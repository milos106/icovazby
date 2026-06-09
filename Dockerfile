# Multi-stage Docker build for icovazby
# Self-host: docker run -p 3000:3000 -v ./data:/app/data icovazby:latest
# Or: docker-compose up -d

FROM node:20-alpine AS builder
WORKDIR /app

# Install build deps for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++ git

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY public ./public
COPY tsup.config.ts tsconfig.json ./
RUN npm run build

# Runtime stage — slim, only production deps
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache python3 make g++ && \
    addgroup -S icovazby && adduser -S icovazby -G icovazby

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    apk del python3 make g++

COPY --from=builder /app/dist ./dist
COPY public ./public
COPY scripts ./scripts

# Volume pro persistent data
VOLUME ["/app/data"]
ENV ARES_WEB_DATA_DIR=/app/data
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

USER icovazby

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/healthz || exit 1

CMD ["node", "--env-file-if-exists=.env", "dist/server.js"]
