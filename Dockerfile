# --- Build stage: install npm deps + claude ---
FROM node:20-alpine AS builder
WORKDIR /build
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# --- Runtime stage ---
FROM node:20-alpine

RUN apk add --no-cache ca-certificates curl nss-tools && \
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/bin/caddy && \
    chmod +x /usr/bin/caddy

WORKDIR /app

COPY --from=builder /build/node_modules ./server/node_modules
COPY --from=builder /usr/local/lib/node_modules/@anthropic-ai/claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code
COPY --from=builder /usr/local/bin/claude /usr/local/bin/claude
COPY server/src ./server/src
COPY web/public ./web/public
COPY Caddyfile /etc/caddy/Caddyfile

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV MYCO_DATA=/data \
    HOST=127.0.0.1 \
    PORT=3000

EXPOSE 80 443

VOLUME ["/data"]

ENTRYPOINT ["/docker-entrypoint.sh"]
