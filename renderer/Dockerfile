# Diagram render service. Build context is the server repo root (see docker-compose.yml).
# The Playwright Python package version must match the image tag so it finds the bundled browsers.
FROM mcr.microsoft.com/playwright/python:v1.65.2-noble

RUN pip install --no-cache-dir --break-system-packages playwright==1.65.2 "aiohttp>=3.11,<4"

WORKDIR /app
COPY scripts/vendor/mermaid.min.js vendor/mermaid.min.js
COPY scripts/vendor/fonts vendor/fonts
COPY renderer/server.py server.py

USER pwuser
ENV PORT=5002
EXPOSE 5002
CMD ["python3", "server.py"]
