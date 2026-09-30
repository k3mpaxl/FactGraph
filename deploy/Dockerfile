# The frontend bundle is platform independent: build it natively instead of under arm64 emulation.
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --system --uid 10001 --create-home factgraph
COPY app/ ./app/
COPY --from=frontend /build/web/dist ./web/dist/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3).read()"
USER factgraph
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
