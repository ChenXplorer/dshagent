#!/usr/bin/env bash
set -euo pipefail
# Run after the pinned MinIO container is healthy. Credentials remain in its
# existing environment, never in host command arguments or script output.
docker -H unix:///run/dshagent-docker/docker.sock exec dshagent-daytona-minio-1 \
  sh -c 'MC_HOST_mvp="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@localhost:9000" mc mb --ignore-existing mvp/daytona'
