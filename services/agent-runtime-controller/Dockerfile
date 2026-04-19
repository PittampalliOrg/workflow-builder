FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY pyproject.toml /app/
RUN pip install --no-cache-dir \
      kopf==1.37.2 \
      kubernetes==29.0.0 \
      pyyaml==6.0.1

COPY src /app/src

USER 1000

# kopf expects the module path; main.py wires the handlers.
CMD ["kopf", "run", "--standalone", "--namespace=openshell", "/app/src/main.py"]
