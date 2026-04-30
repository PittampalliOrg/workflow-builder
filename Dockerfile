FROM node:22-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@10
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml .npmrc ./
COPY components.json drizzle.config.ts server-prod.js svelte.config.js tsconfig.json vite.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
COPY static ./static
ENV NODE_ENV=production
RUN pnpm build && find build -name '*.map' -type f -delete

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN addgroup -S nodejs && adduser -S sveltekit -G nodejs
COPY --from=builder --chown=sveltekit:nodejs /app/build ./build
COPY --from=builder --chown=sveltekit:nodejs /app/server-prod.js ./
COPY --from=builder --chown=sveltekit:nodejs /app/package.json ./
COPY --from=prod-deps --chown=sveltekit:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=sveltekit:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=sveltekit:nodejs /app/drizzle.config.ts ./
# drizzle-kit is a devDependency excluded by the prod-deps stage, but the
# db-migrate Sync hook runs `npx drizzle-kit migrate`. Without the package
# in node_modules, npx falls back to fetching it and the unprivileged user
# (1001) can't write to /.npm. Copy it explicitly from the builder so the
# binary is local and npx never tries to write a cache.
COPY --from=builder --chown=sveltekit:nodejs /app/node_modules/drizzle-kit ./node_modules/drizzle-kit
COPY --from=builder --chown=sveltekit:nodejs /app/node_modules/.bin/drizzle-kit ./node_modules/.bin/drizzle-kit
USER sveltekit
EXPOSE 3000
CMD ["node", "server-prod.js"]
