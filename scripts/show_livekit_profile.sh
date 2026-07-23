#!/usr/bin/env bash
set -Eeuo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 - "$PROJECT_ROOT/.env" <<'PY'
from pathlib import Path
import hashlib, sys
values={}
for line in Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace").splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        k,v=line.split("=",1); values[k.strip()]=v.strip()
fp=lambda value: hashlib.sha256(value.encode()).hexdigest()[:10] if value else "<missing>"
print("Active LiveKit profile")
print("  Profile:", values.get("LIVEKIT_PROFILE", "local-dev"))
print("  URL:", values.get("LIVEKIT_URL", "<missing>"))
print("  API key fingerprint:", fp(values.get("LIVEKIT_API_KEY", "")))
print("  API secret fingerprint:", fp(values.get("LIVEKIT_API_SECRET", "")))
print("  Secrets are not displayed")
PY
