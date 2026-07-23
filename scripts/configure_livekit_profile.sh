#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
LOCAL_CONFIG="$PROJECT_ROOT/config/livekit.dev.yaml"
PROFILE="${1:-}"

usage() {
  cat <<'TXT'
Usage:
  bash scripts/configure_livekit_profile.sh cloud-dev
  bash scripts/configure_livekit_profile.sh local-dev [LAN_IP]
  bash scripts/configure_livekit_profile.sh cloud-production
  bash scripts/configure_livekit_profile.sh self-hosted-production
TXT
}

[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }

case "$PROFILE" in
  cloud-dev|cloud-production)
    [[ -t 0 ]] || { echo "Run this in an interactive terminal" >&2; exit 1; }
    printf 'LiveKit project URL (wss://...): '
    IFS= read -r LIVEKIT_URL
    LIVEKIT_URL="${LIVEKIT_URL%/}"
    [[ "$LIVEKIT_URL" == wss://* ]] || { echo "URL must begin with wss://" >&2; exit 1; }
    printf 'LiveKit API key: '
    IFS= read -r LIVEKIT_API_KEY
    printf 'LiveKit API secret: '
    IFS= read -r -s LIVEKIT_API_SECRET
    printf '\n'
    [[ -n "$LIVEKIT_API_KEY" && -n "$LIVEKIT_API_SECRET" ]] || { echo "Key and secret are required" >&2; exit 1; }
    ;;

  local-dev)
    LAN_IP="${2:-}"
    if [[ -z "$LAN_IP" ]]; then
      LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    fi
    [[ "$LAN_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Valid LAN IP required" >&2; exit 1; }
    LIVEKIT_URL="ws://${LAN_IP}:7880"
    LIVEKIT_API_KEY="devkey"
    LIVEKIT_API_SECRET="secret"
    if [[ -f "$LOCAL_CONFIG" ]]; then
      python3 - "$LOCAL_CONFIG" "$LAN_IP" <<'PY'
from pathlib import Path
import re, sys
p = Path(sys.argv[1]); ip = sys.argv[2]
t = p.read_text(encoding="utf-8")
t, n = re.subn(r'(?m)^(\s*node_ip:\s*)"?[^"\s]+"?\s*$', rf'\1"{ip}"', t, count=1)
if n != 1: raise SystemExit("Could not update rtc.node_ip")
p.write_text(t, encoding="utf-8")
PY
    fi
    ;;

  self-hosted-production)
    [[ -t 0 ]] || { echo "Run this in an interactive terminal" >&2; exit 1; }
    printf 'Self-hosted LiveKit URL (wss://...): '
    IFS= read -r LIVEKIT_URL
    LIVEKIT_URL="${LIVEKIT_URL%/}"
    [[ "$LIVEKIT_URL" == wss://* ]] || { echo "URL must begin with wss://" >&2; exit 1; }
    printf 'LiveKit API key: '
    IFS= read -r LIVEKIT_API_KEY
    printf 'LiveKit API secret: '
    IFS= read -r -s LIVEKIT_API_SECRET
    printf '\n'
    [[ -n "$LIVEKIT_API_KEY" && -n "$LIVEKIT_API_SECRET" ]] || { echo "Key and secret are required" >&2; exit 1; }
    ;;

  *) usage; exit 1 ;;
esac

python3 - "$ENV_FILE" "$PROFILE" "$LIVEKIT_URL" "$LIVEKIT_API_KEY" "$LIVEKIT_API_SECRET" <<'PY'
from pathlib import Path
import hashlib, os, sys
p = Path(sys.argv[1])
values = {
    "LIVEKIT_PROFILE": sys.argv[2],
    "LIVEKIT_URL": sys.argv[3],
    "LIVEKIT_API_KEY": sys.argv[4],
    "LIVEKIT_API_SECRET": sys.argv[5],
    "LIVEKIT_TOKEN_TTL": "1h",
}
lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
out=[]; seen=set()
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        key=line.split("=",1)[0].strip()
        if key in values:
            out.append(f"{key}={values[key]}"); seen.add(key); continue
    out.append(line)
if out and out[-1].strip(): out.append("")
out.append("# LiveKit active profile")
for key, value in values.items():
    if key not in seen: out.append(f"{key}={value}")
tmp=p.with_name(f".{p.name}.tmp-{os.getpid()}")
tmp.write_text("\n".join(out).rstrip()+"\n", encoding="utf-8")
tmp.chmod(0o600); tmp.replace(p); p.chmod(0o600)
fp=lambda value: hashlib.sha256(value.encode()).hexdigest()[:10]
print("\nLiveKit profile configured")
print(f"  Profile: {values['LIVEKIT_PROFILE']}")
print(f"  URL: {values['LIVEKIT_URL']}")
print(f"  API key fingerprint: {fp(values['LIVEKIT_API_KEY'])}")
print(f"  API secret fingerprint: {fp(values['LIVEKIT_API_SECRET'])}")
print("  Secrets were not printed")
PY

echo
echo "Restart node server.js before testing."
if [[ "$PROFILE" == cloud-* ]]; then
  echo "Do not start the local LiveKit server for this profile."
else
  echo "For local-dev start: bash scripts/start_livekit_dev.sh"
fi
