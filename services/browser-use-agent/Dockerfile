FROM ghcr.io/astral-sh/uv:python3.12-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --no-dev
COPY src/ src/
# The browser is NEVER in this image — the agent attaches to the chromium
# sidecar (or a Browserstation lane) over CDP via BROWSER_USE_CDP_URL.
RUN mkdir -p /sandbox /mnt/session/outputs
EXPOSE 8002
CMD ["uv", "run", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8002"]
