#!/usr/bin/env bash
# Development host only. Does not change the existing Docker service/data root.
set -euo pipefail
root=/home/dev/dshagent-mvp
socket=unix:///run/dshagent-docker/docker.sock
network=dshagent-daytona
bridge=mvpday0
subnet=10.203.0.0/24
uplink=ens160
[[ $(id -u) == 0 ]] || { echo 'Run with sudo'; exit 1; }
case "${1:-}" in
  start)
    [[ $(sysctl -n net.ipv4.ip_forward) == 1 ]] || { echo 'Host IPv4 forwarding is disabled'; exit 1; }
    ip link show "$uplink" >/dev/null
    mkdir -p "$root/runtime/docker-data" "$root/tmp/docker" "$root/logs"
    if ! systemctl is-active --quiet dshagent-docker.service; then
      # A private config prevents inheriting host-wide daemon.json settings.
      # Use the developer's configured proxy without writing it to command lines/logs.
      umask 077
      python3 - "$root/runtime/isolated-docker.json" <<'PY'
import json, os, sys
proxies = {key: os.environ[name] for key, name in
           [('http-proxy','HTTP_PROXY'),('https-proxy','HTTPS_PROXY'),('no-proxy','NO_PROXY')]
           if os.environ.get(name)}
with open(sys.argv[1], 'w') as out:
    json.dump({'proxies': proxies} if proxies else {}, out)
PY
      systemd-run --unit=dshagent-docker --property=Delegate=yes \
        --property=RuntimeDirectory=dshagent-docker --property=Restart=on-failure \
        --property="StandardOutput=append:$root/logs/docker.log" \
        --property="StandardError=append:$root/logs/docker.log" \
        --setenv="DOCKER_TMPDIR=$root/tmp/docker" \
        /usr/bin/dockerd --config-file "$root/runtime/isolated-docker.json" \
        --data-root "$root/runtime/docker-data" --exec-root /run/dshagent-docker/exec \
        --pidfile /run/dshagent-docker/docker.pid --host "$socket" \
        --bridge none --iptables=false --ip6tables=false --ip-forward=false \
        --ip-masq=false --userland-proxy=true --storage-driver overlay2 \
        --log-driver local --log-opt max-size=10m --log-opt max-file=3
    fi
    for attempt in {1..30}; do
      docker -H "$socket" info >/dev/null 2>&1 && break
      sleep 1
    done
    docker -H "$socket" info >/dev/null
    if ! docker -H "$socket" network inspect "$network" >/dev/null 2>&1; then
      # Validate subnet overlap before creating a bridge on the shared host.
      ip -j route | python3 -c 'import ipaddress,json,sys; wanted=ipaddress.ip_network("10.203.0.0/24"); routes=json.load(sys.stdin); assert not any(wanted.overlaps(ipaddress.ip_network(r["dst"])) for r in routes if r.get("dst") not in (None,"default")), "MVP subnet overlaps host route"'
      docker -H "$socket" network create --driver bridge --subnet "$subnet" \
        --opt com.docker.network.bridge.name="$bridge" \
        --opt com.docker.network.bridge.enable_ip_masquerade=false "$network"
    fi
    [[ $(docker -H "$socket" network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$network") == "$subnet" ]]
    # Scope every rule to our bridge/subnet; preserve all existing rules/policies.
    iptables -t nat -C POSTROUTING -s "$subnet" -o "$uplink" -m comment --comment dshagent-mvp -j MASQUERADE 2>/dev/null || \
      iptables -t nat -A POSTROUTING -s "$subnet" -o "$uplink" -m comment --comment dshagent-mvp -j MASQUERADE
    iptables -C FORWARD -i "$bridge" -s "$subnet" -m comment --comment dshagent-mvp -j ACCEPT 2>/dev/null || \
      iptables -I FORWARD 1 -i "$bridge" -s "$subnet" -m comment --comment dshagent-mvp -j ACCEPT
    iptables -C FORWARD -o "$bridge" -d "$subnet" -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment dshagent-mvp -j ACCEPT 2>/dev/null || \
      iptables -I FORWARD 1 -o "$bridge" -d "$subnet" -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment dshagent-mvp -j ACCEPT
    docker -H "$socket" info --format '{{.DockerRootDir}}'
    ;;
  stop)
    # Stop the MVP compose stack first; no images, volumes or data are removed.
    systemctl stop dshagent-docker.service
    iptables -t nat -D POSTROUTING -s "$subnet" -o "$uplink" -m comment --comment dshagent-mvp -j MASQUERADE 2>/dev/null || true
    iptables -D FORWARD -i "$bridge" -s "$subnet" -m comment --comment dshagent-mvp -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -o "$bridge" -d "$subnet" -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment dshagent-mvp -j ACCEPT 2>/dev/null || true
    ;;
  *) echo "Usage: $0 start|stop"; exit 2 ;;
esac
