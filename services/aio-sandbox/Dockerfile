# AIO Browser Sandbox + Claude Code CLI
#
# Extends the AIO sandbox (Chrome, CDP, VNC, browser automation, MCP)
# with Claude Code CLI for headless planning/execution.
#
# Base:  ghcr.io/agent-infra/sandbox:latest
#   - Ubuntu 22.04, Node 22, npm, git, gh, curl, Chrome
#   - Port 8080 (shell, files, browser, VNC, MCP, CDP)
#   - User: gem, Home: /home/gem
#
# Added: @anthropic-ai/claude-code CLI, git agent config

FROM ghcr.io/agent-infra/sandbox:latest

USER root

# Install Claude Code CLI globally (Node.js + npm already in base image)
RUN npm install -g @anthropic-ai/claude-code@2.1.50 && claude --version

# Git config for agent commits
RUN git config --system user.email "agent@pittampalli.com" && \
    git config --system user.name "AI Agent"

# Back to default AIO user
USER gem

EXPOSE 8080
