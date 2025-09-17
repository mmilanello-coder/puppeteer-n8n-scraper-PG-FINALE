FROM ghcr.io/puppeteer/puppeteer:22.12.1   # base con Chrome già installato

ENV NODE_ENV=production \
    PORT=10000 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app             # cartella di lavoro
COPY package.json package-lock.json* ./ 
RUN npm install --omit=dev   # installa le dipendenze
COPY . .                 # copia tutto il codice (server.js ecc.)

EXPOSE 10000             # porta da aprire
CMD ["node", "server.js"] # comando che parte
