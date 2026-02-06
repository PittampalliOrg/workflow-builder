FROM python:3.12-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1000 planner && \
    useradd --uid 1000 --gid planner --shell /bin/bash --create-home planner

# Set up Python virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python dependencies
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app

# Copy application code
COPY --chown=planner:planner . .

# Create workspace directory with proper permissions
RUN mkdir -p /app/workspace && chown -R planner:planner /app

# Switch to non-root user
USER planner

# Expose REST API port
EXPOSE 8000

# Environment variables
ENV PLANNER_CWD=/app/workspace
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Health check via the Dapr sidecar
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3500/v1.0/healthz || exit 1

# Run headless agent
CMD ["python", "app.py"]
