# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app
# Toolchain for native modules pulled in by teleproto (utf-8-validate, bufferutil).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- client (Vite SPA) ----
FROM node:22-slim AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm ci
COPY client ./
RUN npm run build

# ---- production deps ----
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=client /app/client/dist ./client/dist
COPY package.json .node-pg-migraterc.json ./
COPY migrations ./migrations
# Default command runs the app; compose overrides for ingestor/migrate.
CMD ["node", "dist/entrypoints/app.js"]
