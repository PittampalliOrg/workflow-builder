FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git docker.io \
	&& rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
	"git+https://github.com/PittampalliOrg/SWE-bench.git@6b32ec7dc48358aa7a6e3f8e12e9c72e5647e3cd" \
	requests \
	docker

COPY entrypoint.py /app/entrypoint.py

ENTRYPOINT ["python", "/app/entrypoint.py"]
