# Function Template: Python
# This Dockerfile builds a custom Python function for OCI execution.
#
# The function receives input via the INPUT environment variable (JSON)
# and should write output to stdout (JSON or text).
#
# Build:
#   docker build -t my-function:v1 .
#
# Test locally:
#   docker run -e INPUT='{"name":"World"}' my-function:v1

FROM python:3.12-slim AS builder

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY . .

# Production stage
FROM python:3.12-slim

WORKDIR /app

# Create non-root user
RUN groupadd --system --gid 1001 function && \
    useradd --system --uid 1001 --gid function runner

# Copy from builder
COPY --from=builder --chown=runner:function /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder --chown=runner:function /app .

USER runner

# The function reads INPUT env var and writes to stdout
CMD ["python", "main.py"]
