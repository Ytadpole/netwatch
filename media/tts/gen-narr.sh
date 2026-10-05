#!/usr/bin/env bash
# 生成八段旁白 MP3(Edge 在线语音,经本机 7897 代理;缺 venv 时见 README「旁白」一节)
# 用法:./gen-narr.sh [输出目录](缺省 ./narr)
set -euo pipefail
cd "$(dirname "$0")"
OUT_DIR="${1:-narr}"
VOICE="${VOICE:-zh-CN-YunxiNeural}"
RATE="${RATE:-+6%}"
PROXY="${PROXY:-http://127.0.0.1:7897}"
EDGE_TTS="${EDGE_TTS:-/tmp/tts-venv/bin/edge-tts}"

mkdir -p "$OUT_DIR"
while IFS='|' read -r id text; do
  [ -z "${id:-}" ] && continue
  case "$id" in S*) ;; *) continue ;; esac
  "$EDGE_TTS" --proxy "$PROXY" --voice "$VOICE" --rate="$RATE" --text "$text" --write-media "$OUT_DIR/$id.mp3"
done < narr.txt
echo "旁白已生成 → $OUT_DIR/S{1..8}.mp3"
