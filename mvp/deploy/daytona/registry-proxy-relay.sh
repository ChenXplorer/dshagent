#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo'; exit 1; }
# Reuse this development machine's HTTP proxy through the MVP bridge only.
rule=(-i mvpday0 -s 10.203.0.0/24 -d 10.203.0.1 -p tcp --dport 18119 -m comment --comment dshagent-registry-proxy -j ACCEPT)
case "${1:-}" in
  start)
    iptables -C INPUT "${rule[@]}" 2>/dev/null || iptables -I INPUT 1 "${rule[@]}"
    if ! systemctl is-active --quiet dshagent-registry-proxy.service; then
      systemd-run --unit=dshagent-registry-proxy --property=Restart=on-failure \
        /usr/bin/socat TCP4-LISTEN:18119,bind=10.203.0.1,reuseaddr,fork TCP4:127.0.0.1:8118
    fi
    ;;
  stop)
    systemctl stop dshagent-registry-proxy.service
    iptables -D INPUT "${rule[@]}" 2>/dev/null || true
    ;;
  *) echo "Usage: $0 start|stop"; exit 2 ;;
esac
