FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    fonts-liberation \
    git \
    libasound2 \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpangocairo-1.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xvfb && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY pyproject.toml ./pyproject.toml
COPY app.py ./app.py
COPY langgraph_engine.py ./langgraph_engine.py
COPY tools.py ./tools.py
COPY tracing.py ./tracing.py

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir .

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" && \
    python -m playwright install chromium && \
    chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

RUN mkdir -p /workspace

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8082 \
    HOST=0.0.0.0 \
    WORKSPACE_ROOT=/workspace \
    DAPR_AGENT_CHILD_WORKFLOW_RUN_NAME=daprAgentRunWorkflowV1

VOLUME ["/workspace"]

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8082/api/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8082"]
