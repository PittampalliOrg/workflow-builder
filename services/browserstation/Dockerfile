FROM docker.io/rayproject/ray:2.47.1-cpu

RUN pip install --no-cache-dir "fastapi[standard]" websockets httpx uvicorn

WORKDIR /opt/app

COPY app/ ./app/

ENV PYTHONUNBUFFERED=1
