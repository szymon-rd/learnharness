# LearnHarness server for a VPS (used by deploy/docker-compose.yml).
# It runs the same phone server as `npm run phone`: every page and API call
# needs the access code, which is created on first start and stored on the
# data volume. See docs/deploy-vps.md.

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx next build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
# Chromium runs the agent's interactive demos; the fonts cover most scripts
# and emoji in rendered figures.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CHROME_PATH=/usr/bin/chromium \
    LH_DATA_DIR=/data/data \
    LH_AUTH_FILE=/data/auth.json
VOLUME /data
EXPOSE 3210
CMD ["node", "scripts/phone-server.mjs", "--port", "3210"]
