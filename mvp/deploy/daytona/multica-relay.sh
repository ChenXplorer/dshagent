#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo'; exit 1; }
# SSH reverse forward is loopback-only. This relay admits only the MVP bridge.
rule=(-i mvpday0 -s 10.203.0.0/24 -d 10.203.0.1 -p tcp --dport 18382 -m comment --comment dshagent-multica-relay -j ACCEPT)
case "${1:-}" in
  start)
    iptables -C INPUT "${rule[@]}" 2>/dev/null || iptables -I INPUT 1 "${rule[@]}"
    if ! systemctl is-active --quiet dshagent-multica-relay.service; then
      systemd-run --unit=dshagent-multica-relay --property=Restart=on-failure \
        /usr/bin/socat TCP4-LISTEN:18382,bind=10.203.0.1,reuseaddr,fork TCP4:127.0.0.1:18381
    fi
    ;;
  stop)
    systemctl stop dshagent-multica-relay.service
    iptables -D INPUT "${rule[@]}" 2>/dev/null || true
    ;;
  *) echo "Usage: $0 start|stop"; exit 2 ;;
esac
