# agent-browser-mcp — Vercel agent-browser exposed as a streamable-HTTP MCP server
# with deterministic artifact persistence.
#
# agent-browser (github.com/vercel-labs/agent-browser) is a Rust CLI that drives
# Chrome for Testing over CDP and speaks MCP over stdio (`agent-browser mcp`).
# Our non-CLI (dapr-agent-py) agents consume tools over HTTP, so bridge.mjs
# proxies the stdio MCP server to a streamable-HTTP endpoint at /mcp AND, after
# each artifact-producing tool call (screenshot/video/pdf/HAR/trace), reads the
# produced file off this pod and POSTs it to the run's browser-artifacts store
# (keyed by the X-Wfb-Execution-Id header). Chrome is isolated in THIS image.
FROM node:24-bookworm-slim

# Chrome for Testing runtime libraries + ffmpeg (agent-browser shells out to
# ffmpeg for WebM video recording — without it `record stop` fails).
RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates fonts-liberation ffmpeg libasound2 libatk-bridge2.0-0 libatk1.0-0 \
	libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
	libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
	libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 curl xdg-utils \
	&& rm -rf /var/lib/apt/lists/*

# Pinned so the image is reproducible and the MCP tool surface is stable.
RUN npm install -g agent-browser@0.31.2

# The bridge (MCP proxy + artifact persistence).
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bridge.mjs browser-lane-policy.mjs mcp-session-lifecycle.mjs render.mjs target-auth-policy.mjs vision-contract.mjs ./

# Pre-download Chrome for Testing into the image (version-matched to the CLI).
RUN agent-browser install

# core = navigation/snapshot/screenshot/interaction; network = HAR; debug = video
# recording + DevTools trace/profiler. Needed so agents can produce those artifacts.
ENV PORT=8000 \
	AGENT_BROWSER_TOOLS=core,network,debug,state \
	NODE_ENV=production
EXPOSE 8000

CMD ["node", "bridge.mjs"]
