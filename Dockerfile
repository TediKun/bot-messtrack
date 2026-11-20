# Multi-stage Dockerfile for MessTrack Bot on Railway / Koyeb

FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production Runner
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

# Create directory for persistent auth data if mounted
RUN mkdir -p /app/auth_info_baileys

CMD ["node", "dist/index.js"]


