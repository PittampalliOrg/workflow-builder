FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git \
	&& rm -rf /var/lib/apt/lists/*

# The evaluator no longer runs the SWE-bench harness in-process. It dispatches
# a Tekton PipelineRun (swebench-eval) and watches it to terminal. Each
# TaskRun pip-installs the harness from $SWEBENCH_PACKAGE_REF; we only need
# the kubernetes client, mlflow, and HTTP client here.
RUN pip install --no-cache-dir \
	"kubernetes>=29.0.0" \
	mlflow==3.10.1 \
	requests

COPY entrypoint.py /app/entrypoint.py

ENTRYPOINT ["python", "/app/entrypoint.py"]
