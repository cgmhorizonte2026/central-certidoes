FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
ENV NODE_ENV=demo
ENV PORT=3030
ENV CENTRAL_CERTIDOES_STORAGE=/app/storage

COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/storage

EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3030/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
