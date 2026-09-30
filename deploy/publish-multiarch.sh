#!/usr/bin/env bash
set -euo pipefail

image="${FACTGRAPH_IMAGE:-k3mpaxl/factgraph}"
version="${FACTGRAPH_VERSION:-0.4.0}"

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --file deploy/Dockerfile \
  --tag "${image}:latest" \
  --tag "${image}:${version}" \
  --push \
  .

docker buildx imagetools inspect "${image}:latest"
