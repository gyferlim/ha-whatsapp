# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN apk add --no-cache git python3 make g++

WORKDIR /build

COPY app/package.json ./
RUN npm install --omit=dev

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine

LABEL maintainer="Based on FaserF/hassio-addons/whatsapp"
LABEL description="Standalone WhatsApp Bridge (Baileys) — no Home Assistant required"

# ffmpeg for optional audio conversion; tini for proper signal handling
RUN apk add --no-cache tini ffmpeg

WORKDIR /app

COPY --from=builder /build/node_modules ./node_modules
COPY app/index.js ./

# /data is the persistent volume for auth session
RUN mkdir -p /data/session

EXPOSE 8066

# Use tini so Ctrl-C and SIGTERM work cleanly
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/index.js"]
