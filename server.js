/* eslint-disable no-console */
const express = require('express');
const path = require('path');
const stringify = require('csv-stringify').stringify;

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const PORT = process.env.PORT || 10000;
const CHROME = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const HEADLESS = (process.env.HEADLESS ?? 'true') !== 'false';
const LIGHT = (process.env.LIGHT_MODE ?? 'true') === 'true';

function slugify(s) {
  return s.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, '_');
}

async function launchBrowser() {
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (PROXY) args.push(`--proxy-server=${PROXY}`);
  if (LIGHT) args.push('--disable-dev-shm-usage', '--no-zygote', '--single-process');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  return puppeteer.launch({
    headless: HEADLESS,
    executablePath,   
    args,
    defaultViewport: { width: 1366, height: 900 }
  });
}
async function newPage(browser) {
  const page = await browser.newPage();
  if (LIGHT) {
    await page.setRequestInterception(true);
    page.on('request', r => {
      const t = r.resourceType();
      if (t === 'image' || t === 'media' || t === 'font') r.abort(); else r.continue();
    });
  }
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  );
  page.setDefaultNavigationTimeout(60000);
  return page;
}

async function clickConsent(page) {
  try {
    await page.waitForTimeout(500);
    const btn = await page.$x("//button[contains(., 'Accetta') or contains(., 'Accept') or contains(., 'Consenti')]");
    if (btn[0]) await btn[0].click();
  } catch {}
}

async function gotoResults(page, { q, city='milano', region='lombardia' }) {
  const slug = slugify(q);
  const tries = [
    `https://www.paginegialle.it/ricerca/${encodeURIComponent(q)}/${encodeURIComponent(city)}`,
    `https://www.paginegialle.it/${region}/${city}/${slug}.html`,
    `https://www.paginegialle.it/ricerca/${encodeURIComponent(q)}`
  ];
  for (const url of tries) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2' });
      await clickConsent(page);
      if (await page.$('h1')) return { ok: true, url };
    } catch {}
  }
  // fallback: form home
  try {
    await page.goto('https://www.paginegialle.it', { waitUntil: 'networkidle2' });
    await clickConsent(page);
    const [what] = await page.$x("//input[contains(@placeholder,'nome') or contains(@aria-label,'attività')]");
    const [where] = await page.$x("//input[contains(@placeholder,'indirizzo') or contains(@aria-label,'dove')]");
    if (what) { await what.click(); await what.type(q); }
    if (where) { await where.click(); await where.type(city); }
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    return { ok: true, url: 'form' };
  } catch {}
  return { ok: false };
}

async function extractSynonyms(page) {
  return page.evaluate(() => {
    const bag = new Set();
    const collect = box => {
      if (!box) return;
      box.querySelectorAll('a,button,span,li').forEach(el => {
        const t = (el.innerText||'').trim();
        if (t && t.length < 60 && !/aperto|chiuso|mappa|recensioni|filtri|prenota/i.test(t)) bag.add(t);
      });
    };
    // blocchi filtri
    document.querySelectorAll('[class*=filter],[class*=filtri],[id*=filter]').forEach(collect);
    document.querySelectorAll('h2,h3,[role=heading],strong').forEach(h => {
      const tx = (h.textContent||'').toLowerCase();
      if (/tipi di|categorie correlate|specialit|prodotti|settori|servizi/i.test(tx))
        collect(h.closest('section,div,aside') || h.parentElement);
    });
    // fallback testo
    if (!bag.size) {
      const body = document.body.innerText || '';
      const m = body.match(/Tipi di[^\n]*\n([\s\S]{0,500})/i);
      if (m) m[1].split(/\s{2,}|\n/).map(s=>s.trim()).filter(Boolean).forEach(v=>bag.add(v));
    }
    return Array.from(bag);
  });
}

async function extractCompanies(page, limitPerPage=20, maxPages=3) {
  const out = [];
  for (let p=1; p<=maxPages; p++) {
    // tenta vari pattern comuni
    const items = await page.$$eval('article, .scheda, .results-item, [data-result], .result-card', nodes => {
      const arr = [];
      nodes.forEach(n => {
        const name = (n.querySelector('h2 a, h2, h3 a, h3')?.textContent||'').trim();
        const phone = (n.querySelector('a[href^="tel:"]')?.getAttribute('href')||'').replace('tel:','');
        const addr = (n.querySelector('[class*="addr"], [class*="address"], address')?.textContent||'').trim();
        if (name) arr.push({ name, phone, address: addr });
      });
      return arr;
    }).catch(()=>[]);
    items.forEach(x=>out.push(x));
    if (out.length >= limitPerPage) break;

    // vai pagina successiva se esiste
    const next = await page.$('a[rel="next"], a[aria-label*="avanti"], a[aria-label*="pagina successiva"], .next, .pagination-next');
    if (!next) break;
    await Promise.all([ next.click(), page.waitForNavigation({ waitUntil: 'networkidle2' }) ]);
  }
  return out;
}

// ------------------- API -------------------
const app = express();
app.use(express.json());

app.get('/health', (_req,res)=>res.json({ok:true}));

// 1) SOLO SINONIMI
app.post('/synonyms', async (req, res) => {
  const { category, city='milano', region='lombardia', limit=12 } = req.body||{};
  if (!category) return res.status(400).json({ error: 'category is required' });
  let browser;
  try {
    browser = await launch();
    const page = await newPage(browser);
    const nav = await gotoResults(page, { q: category, city, region });
    if (!nav.ok) throw new Error('cannot reach results page');
    await page.waitForTimeout(700);
    let syn = await extractSynonyms(page);
    syn = Array.from(new Set(syn.map(s=>s.replace(/\s+/g,' ').trim()))).slice(0, limit);
    res.json({ category, city, region, count: syn.length, synonyms: syn });
  } catch (e) {
    console.error('synonyms:', e);
    res.status(500).json({ error: String(e.message||e) });
  } finally {
    if (browser) await browser.close().catch(()=>{});
  }
});

// 2) SCRAPE AZIENDE (JSON)
app.post('/scrape', async (req, res) => {
  const { category, city='milano', region='lombardia', limitCompanies=60, maxPages=3, useSynonyms=true, limitSyn=6 } = req.body||{};
  if (!category) return res.status(400).json({ error: 'category is required' });
  let browser;
  try {
    browser = await launch();
    const page = await newPage(browser);

    const searchTerms = [category];
    if (useSynonyms) {
      const nav0 = await gotoResults(page, { q: category, city, region });
      if (nav0.ok) {
        await page.waitForTimeout(600);
        let syn = await extractSynonyms(page);
        syn = Array.from(new Set(syn.map(s=>s.replace(/\s+/g,' ').trim()))).slice(0, limitSyn);
        searchTerms.push(...syn);
      }
    }

    const companies = [];
    for (const term of searchTerms) {
      const nav = await gotoResults(page, { q: `${term} ${city}`, city, region });
      if (!nav.ok) continue;
      await page.waitForTimeout(600);
      const got = await extractCompanies(page, 100, maxPages);
      got.forEach(g => companies.push({ term, ...g }));
      if (companies.length >= limitCompanies) break;
    }

    res.json({ category, city, region, total: companies.length, items: companies.slice(0, limitCompanies) });
  } catch (e) {
    console.error('scrape:', e);
    res.status(500).json({ error: String(e.message||e) });
  } finally {
    if (browser) await browser.close().catch(()=>{});
  }
});

// 3) SCRAPE → CSV (download)
app.post('/scrape-csv', async (req, res) => {
  const r = await (await fetch(`http://localhost:${PORT}/scrape`, {
    method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(req.body||{})
  })).json().catch(()=>({ items: [] }));

  const records = (r.items||[]).map(x => ({
    Categoria: r.category, TermineRicerca: x.term || r.category,
    Nome: x.name || '', Indirizzo: x.address || '', Telefono: x.phone || ''
  }));

  const header = Object.keys(records[0] || {Categoria:'',TermineRicerca:'',Nome:'',Indirizzo:'',Telefono:''});
  const csv = stringify(records, { header: true, columns: header });
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="pg-results.csv"');
  res.send(csv);
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
