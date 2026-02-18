FROM node:20-bookworm-slim

# Align sandbox capabilities with E2B's base image expectations:
# shell + build tooling + python + common CLI tools used by coding agents.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      coreutils \
      curl \
      findutils \
      fuse3 \
      gawk \
      git \
      grep \
      jq \
      libbluetooth-dev \
      make \
      python3 \
      python3-pip \
      s3fs \
      sed \
      tk-dev \
      unzip \
      util-linux \
      uuid-dev \
      zip \
      gh && \
    rm -rf /var/lib/apt/lists/*

ENV YARN_VERSION=1.22.19
RUN curl -fsSLO --compressed "https://yarnpkg.com/downloads/${YARN_VERSION}/yarn-v${YARN_VERSION}.tar.gz" && \
    mkdir -p /opt && \
    tar -xzf "yarn-v${YARN_VERSION}.tar.gz" -C /opt/ && \
    ln -sfn "/opt/yarn-v${YARN_VERSION}/bin/yarn" /usr/local/bin/yarn && \
    ln -sfn "/opt/yarn-v${YARN_VERSION}/bin/yarnpkg" /usr/local/bin/yarnpkg && \
    rm "yarn-v${YARN_VERSION}.tar.gz"

# node image provides user "node" with UID/GID 1000.
RUN mkdir -p /app /home/node/workspace && \
    ln -sfn /app /workspace && \
    ln -sfn /home/node /home/user && \
    chown -R node:node /app /home/node

WORKDIR /app
COPY --chown=node:node server.js /app/server.js

RUN git config --system user.email "agent@mastra" && \
    git config --system user.name "mastra-agent"

USER node

ENV PORT=8888 \
    WORKSPACE_DIR=/app \
    HOME=/home/node
EXPOSE 8888

HEALTHCHECK --interval=10s --timeout=5s --start-period=3s --retries=3 \
  CMD curl -sf http://localhost:8888/ || exit 1

CMD ["node", "/app/server.js"]
