#!/bin/sh
set -eu
# Boot official DSH web (loopback) and the preview gateway on 8080.
export DSH_HOME="${DSH_HOME:-/workspace/.runtime/dsh-home}"
export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
export MULTICA_OFFICIAL_URL="${MULTICA_OFFICIAL_URL:-http://127.0.0.1:18080}"
export MULTICA_SERVER_URL="$MULTICA_OFFICIAL_URL"
if [ -f /opt/multica-official/workspace.id ]; then
  export MULTICA_WORKSPACE_ID="$(cat /opt/multica-official/workspace.id)"
fi
if [ -f /opt/multica-official/pat.token ]; then
  export MULTICA_TOKEN="$(cat /opt/multica-official/pat.token)"
fi
mkdir -p "$DSH_HOME" /tmp
cat > "$DSH_HOME/.env" <<EOF
DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY
MULTICA_OFFICIAL_URL=$MULTICA_OFFICIAL_URL
MULTICA_SERVER_URL=$MULTICA_SERVER_URL
MULTICA_TOKEN=${MULTICA_TOKEN:-}
MULTICA_WORKSPACE_ID=${MULTICA_WORKSPACE_ID:-}
CODEX_HOME=${CODEX_HOME:-/workspace/.runtime/codex-home}
CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-/workspace/.runtime/claude-home}
EOF
chmod 600 "$DSH_HOME/.env"

python3 - <<'PY'
import os, pathlib, signal
def pids_on(port):
    want = f"{port:04X}"
    inodes = set()
    for name in ("tcp", "tcp6"):
        path = pathlib.Path(f"/proc/net/{name}")
        if not path.exists():
            continue
        for line in path.read_text().splitlines()[1:]:
            cols = line.split()
            if len(cols) < 10 or cols[3] != "0A":
                continue
            if cols[1].split(":")[-1].upper() == want:
                inodes.add(cols[9])
    found = []
    for fd in pathlib.Path("/proc").glob("*/fd/*"):
        try:
            target = os.readlink(fd)
        except Exception:
            continue
        if target.startswith("socket:[") and target[8:-1] in inodes:
            pid = fd.parts[2]
            if pid.isdigit() and int(pid) > 1:
                found.append(int(pid))
    return sorted(set(found))
for port in (8080, 3080):
    for pid in pids_on(port):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
PY
sleep 1

: >/tmp/dsh-web.log
: >/tmp/dsh-gateway.log
nohup dsh web --no-open --port 3080 \
  --trusted-host localhost \
  --trusted-host 127.0.0.1 \
  --trusted-host 0.0.0.0 \
  >>/tmp/dsh-web.log 2>&1 &
echo $! >/tmp/dsh-web.pid

ready=0
for i in $(seq 1 80); do
  if curl -sS -o /dev/null --max-time 1 http://127.0.0.1:3080/ >/dev/null 2>&1 || \
     curl -sS -o /dev/null --max-time 1 -w '%{http_code}' http://127.0.0.1:3080/ | grep -qE '^[0-9]{3}$'; then
    ready=1
    break
  fi
  # fail fast if the process already exited
  if [ -f /tmp/dsh-web.pid ] && ! kill -0 "$(cat /tmp/dsh-web.pid)" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
python3 - <<'PY'
import re
import http.client
import urllib.parse
from pathlib import Path
text = Path("/tmp/dsh-web.log").read_text(errors="ignore")
match = re.search(r"[?&]token=([A-Za-z0-9._~-]+)", text)
token = match.group(1) if match else ""
Path("/tmp/dsh-web.token").write_text(token)
print("token", "yes" if token else "no")
if token:
    conn = http.client.HTTPConnection("127.0.0.1", 3080, timeout=8)
    conn.request("GET", f"/?token={urllib.parse.quote(token)}", headers={"Host": "127.0.0.1:3080", "Accept": "text/html"})
    res = conn.getresponse()
    res.read()
    cookie = (res.getheader("set-cookie") or "").split(";")[0].strip()
    if cookie:
        Path("/tmp/dsh-web.cookie").write_text(cookie)
        print("cookie", "yes")
    else:
        print("cookie", "no", res.status)
PY
if [ "$ready" != 1 ]; then
  echo "DSH web failed to start" >&2
  tail -50 /tmp/dsh-web.log >&2 || true
  exit 1
fi

nohup sh -c 'while true; do node /workspace/scripts/dsh-gateway.mjs >>/tmp/dsh-gateway.log 2>&1; sleep 1; done' >/dev/null 2>&1 &
echo $! >/tmp/dsh-gateway.pid
sleep 0.4
echo "dsh gateway started"
