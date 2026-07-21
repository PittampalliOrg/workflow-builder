FROM docker.io/rayproject/ray:2.47.1-cpu

WORKDIR /opt/app

COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY app/ ./app/

ENV PYTHONUNBUFFERED=1
