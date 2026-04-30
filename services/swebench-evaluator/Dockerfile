FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git docker.io \
	&& rm -rf /var/lib/apt/lists/*

# SWE-bench is pinned by commit; see README.md for upstream-base provenance.
RUN pip install --no-cache-dir \
	"git+https://github.com/PittampalliOrg/SWE-bench.git@75cc7f9296a1f07b31c5459f1ed2c2da8c5d52da" \
	requests \
	docker

COPY entrypoint.py /app/entrypoint.py

ENTRYPOINT ["python", "/app/entrypoint.py"]
