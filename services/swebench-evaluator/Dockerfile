FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git docker.io \
	&& rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir swebench requests

COPY entrypoint.py /app/entrypoint.py

ENTRYPOINT ["python", "/app/entrypoint.py"]
