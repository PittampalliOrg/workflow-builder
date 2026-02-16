FROM node:22-slim

# Install git and common dev tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# node:22-slim already has user "node" with UID 1000 / GID 1000
# which matches the agent-sandbox securityContext (runAsUser: 1000)

# Set up workspace — ensure /app is writable by UID 1000
RUN mkdir -p /app && chown -R node:node /app
WORKDIR /app
COPY --chown=node:node server.js /app/server.js

# Configure git for the sandbox user
RUN git config --system user.email "agent@mastra" && \
    git config --system user.name "mastra-agent"

USER node

ENV PORT=8888
ENV WORKSPACE_DIR=/app
EXPOSE 8888

HEALTHCHECK --interval=10s --timeout=5s --start-period=3s --retries=3 \
  CMD curl -sf http://localhost:8888/ || exit 1

CMD ["node", "/app/server.js"]
