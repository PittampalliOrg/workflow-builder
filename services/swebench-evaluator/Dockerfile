FROM python:3.12-slim

WORKDIR /app

ARG SWEBENCH_PACKAGE_REF=git+https://github.com/PittampalliOrg/SWE-bench.git@783813773be04dd76dcab12946006f827612f28f

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git \
	&& rm -rf /var/lib/apt/lists/*

# The evaluator no longer runs the SWE-bench harness in-process. It dispatches
# Tekton TaskRuns and watches them to terminal. The TaskRuns reuse this image,
# so the harness is installed once at image-build time rather than with
# apt/pip inside every prepare/finalize pod.
RUN pip install --no-cache-dir \
	"kubernetes>=29.0.0" \
	mlflow==3.10.1 \
	requests \
	"${SWEBENCH_PACKAGE_REF}"

COPY entrypoint.py /app/entrypoint.py

ENTRYPOINT ["python", "/app/entrypoint.py"]
