# ─── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS build
RUN apk add --no-cache openssl

WORKDIR /app

# Install full deps (dev + prod) so vite / react-router / tsc are available.
COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force

# Copy source, generate Prisma client, then build.
COPY . .
RUN npx prisma generate
RUN npm run build

# ─── Stage 2: run ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS run
RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy only the production deps + build output + prisma artefacts.
COPY --from=build /app/node_modules      ./node_modules
COPY --from=build /app/build             ./build
COPY --from=build /app/prisma            ./prisma
COPY --from=build /app/package.json      ./

CMD ["sh", "-c", "npx prisma migrate deploy && npx react-router-serve ./build/server/index.js"]