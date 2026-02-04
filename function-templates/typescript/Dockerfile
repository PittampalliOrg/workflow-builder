# Function Template: TypeScript
# This Dockerfile builds a custom TypeScript function for OCI execution.
#
# The function receives input via the INPUT environment variable (JSON)
# and should write output to stdout (JSON or text).
#
# Build:
#   docker build -t my-function:v1 .
#
# Test locally:
#   docker run -e INPUT='{"name":"World"}' my-function:v1

FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 function && \
    adduser --system --uid 1001 runner

# Copy built files
COPY --from=builder --chown=runner:function /app/dist ./dist
COPY --from=builder --chown=runner:function /app/node_modules ./node_modules
COPY --from=builder --chown=runner:function /app/package.json ./

USER runner

# The function reads INPUT env var and writes to stdout
CMD ["node", "dist/index.js"]
