FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
USER root
ARG DSH_BUILD_HTTP_PROXY
RUN export http_proxy="$DSH_BUILD_HTTP_PROXY" https_proxy="$DSH_BUILD_HTTP_PROXY" && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=60 update && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=60 install -y --no-install-recommends python3 sudo git procps bash ca-certificates curl unzip ripgrep && rm -rf /var/lib/apt/lists/*
RUN export HTTP_PROXY="$DSH_BUILD_HTTP_PROXY" HTTPS_PROXY="$DSH_BUILD_HTTP_PROXY" http_proxy="$DSH_BUILD_HTTP_PROXY" https_proxy="$DSH_BUILD_HTTP_PROXY" && npm install --global @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.270 && npm cache clean --force
COPY multica /usr/local/bin/multica
RUN chmod 0755 /usr/local/bin/multica && /usr/local/bin/multica version --output json && node --version && python3 --version && codex --version && claude --version
RUN useradd --create-home --shell /bin/bash daytona && printf 'daytona ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/daytona && chmod 0440 /etc/sudoers.d/daytona && mkdir -p /home/daytona/workspaces && chown -R daytona:daytona /home/daytona
ENV HOME=/home/daytona
USER daytona
WORKDIR /home/daytona
CMD ["sleep", "infinity"]
