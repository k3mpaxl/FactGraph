# The frontend bundle is platform independent: build it natively instead of under arm64 emulation.
FROM --platform=$BUILDPLATFORM node:26-alpine AS frontend
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Latest stable Python on an explicitly named Debian release (3.15 is only a release candidate as of October 2026).
FROM python:3.14-slim-trixie
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
# Apply Debian security updates at build time (e.g. libpcre2-8-0), even when the base image lags behind.
RUN apt-get update \
    && apt-get -y upgrade --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
# Exact versions with hashes (requirements.lock, generated from requirements.txt): reproducible builds, no unreviewed
# upstream release slips in. Regenerate with: uv pip compile requirements.txt --generate-hashes --universal --python-version 3.14 -o requirements.lock
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock \
    && useradd --system --uid 10001 --create-home factgraph
COPY app/ ./app/
COPY --from=frontend /build/web/dist ./web/dist/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3).read()"
USER factgraph
# No access log: request URLs contain board IDs, which are the boards' access keys.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log", "--no-server-header"]
