# ------------------------------------------------------------------------------
# PaySim-BD: Multi-stage Docker Container
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install dependencies for compilation
COPY package*.json ./
RUN npm ci

# Copy source code and build dist
COPY . .
RUN npm run build

# Production runner image
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled artifacts and cryptographic certificates
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/delivery/certs ./dist/src/delivery/certs
COPY --from=builder /app/src/delivery/certs ./src/delivery/certs

# Create persistent storage volume directory for SQLite database
RUN mkdir -p /data

EXPOSE 8080

ENV PORT=8080
ENV DB_PATH=/data/paysim.db

CMD ["node", "dist/src/cli/index.js", "start", "--port", "8080", "--db", "/data/paysim.db"]

