FROM ghcr.io/nvidia/openshell-community/sandboxes/base:latest

USER root

# Overlay the OpenShell sandbox policy with our customizations, including
# end-to-end TLS for package registries and the internal Git CONNECT policy.
# The cluster runtime supplies its own global policy, while this baked copy is
# the fail-safe for standalone and local OpenShell use.
COPY policy.yaml /etc/openshell/policy.yaml

# Install Playwright system dependencies
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
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright browsers to a shared location accessible by all users.
# OpenShell runs commands as the `sandbox` user, so /opt/pw-browsers avoids
# permission issues that occur when browsers are installed under /root/.cache.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN pip install --break-system-packages playwright \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /opt/pw-browsers
