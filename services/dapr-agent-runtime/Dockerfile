FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY pyproject.toml ./pyproject.toml
COPY app.py ./app.py
COPY langgraph_engine.py ./langgraph_engine.py
COPY tools.py ./tools.py

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir .

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
