FROM docker.io/library/node:22-slim

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=America/Mexico_City

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

USER node
EXPOSE 3000

# Responde 200 solo si la app y la base de datos están disponibles
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
