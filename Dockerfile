# AetherCommerce — single-command container install (Reference Pack: container-class adapter)
#   docker compose up
# Zero external services: everything runs in-process (in-memory + node:sqlite).
FROM node:26-slim

WORKDIR /app

# install deps first (layer cache)
COPY package.json package-lock.json ./
COPY kernel/ kernel/
COPY services/ services/
COPY packs/ packs/
COPY scripts/ scripts/
COPY tsconfig.json ./
RUN npm install --no-audit --no-fund

# default demo port (pack data: services/gateway/packs/gateway-core.json)
EXPOSE 8787

# one command: the platform boots, seeds a shoppable catalog, serves HTTP
CMD ["node", "scripts/serve.ts"]
