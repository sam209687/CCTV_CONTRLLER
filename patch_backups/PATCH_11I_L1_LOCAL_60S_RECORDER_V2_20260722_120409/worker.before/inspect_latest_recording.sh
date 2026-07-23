#!/usr/bin/env bash
set -Eeuo pipefail
DIR="${CCTV_RECORDINGS_DIR:-$HOME/CCTV_Recordings}"
FILE="$(
  find "$DIR" -type f -name '*.mp4' -printf '%T@ %p\n' 2>/dev/null |
  sort -nr | head -n1 | cut -d' ' -f2-
)"
[[ -n "$FILE" ]] || { echo "No MP4 found in $DIR" >&2; exit 1; }
echo "$FILE"
ls -lh "$FILE"
ffprobe -v error -select_streams v:0 \
  -show_entries 'format=duration,size:stream=codec_name,width,height,avg_frame_rate' \
  -of json "$FILE"
META="${FILE%.mp4}.json"
[[ ! -f "$META" ]] || { echo; cat "$META"; }
