FROM ghcr.io/nvidia/openshell-community/sandboxes/base:latest

USER root

# Install Playwright system dependencies and Chromium via Playwright itself
# (Ubuntu 24.04 Noble ships chromium only as a snap, so we use Playwright's bundled binary)
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2t64 \
    libpangocairo-1.0-0 \
    libgtk-3-0t64 \
    xvfb \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --break-system-packages playwright \
    && playwright install --with-deps chromium

ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
