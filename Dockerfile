FROM ghcr.io/puppeteer/puppeteer:22.12.1   
ENV NODE_ENV=production \
    PORT=10000 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app            
COPY package.json package-lock.json* ./ 
RUN npm install --omit=dev  
COPY . .               

EXPOSE 10000            
CMD ["node", "server.js"]
