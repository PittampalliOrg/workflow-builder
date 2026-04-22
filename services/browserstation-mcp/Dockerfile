FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install -g pnpm && pnpm install --prod

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install -g pnpm && pnpm install --prod=false
COPY . ./
ENV NODE_ENV=production
RUN pnpm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3101
ENV HOST=0.0.0.0
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 browsermcp
COPY --from=builder --chown=browsermcp:nodejs /app/dist ./dist
COPY --from=deps --chown=browsermcp:nodejs /app/node_modules ./node_modules
USER browsermcp
EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3101/health || exit 1
CMD ["node", "dist/index.js"]
