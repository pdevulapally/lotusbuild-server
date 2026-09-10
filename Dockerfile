# Official Node 22 / Debian Bookworm image index, verified on 2026-09-10.
# Update the digest deliberately and rebuild/retest before promoting an image.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
# Keep application files root-owned and read-only to the runtime account.
USER node
CMD ["node", "dist/index.js"]
