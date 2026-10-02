#!/usr/bin/env bash
# netwatch Phase 0 spike:采样 nethogs 真实输出(≥5 分钟)+ ss 交叉验证
# 运行:sudo bash docs/samples/run-spike.sh
set -u
cd "$(dirname "$0")"

if [ "$EUID" -ne 0 ]; then
  echo "请用 sudo 运行:sudo bash $0"
  exit 1
fi

command -v nethogs >/dev/null 2>&1 || {
  echo "安装 nethogs…"
  DEBIAN_FRONTEND=noninteractive apt-get install -y nethogs || { echo "apt 安装失败"; exit 1; }
}

nethogs -V >nethogs-version.txt 2>&1
echo "nethogs 版本:$(cat nethogs-version.txt)"
uname -r >kernel.txt

# ---- 受控流量:回环 + 外网下载/上传,分散在采样窗口的前/中/后段 ----
TMP=$(mktemp -d /tmp/netwatch-spike.XXXXXX)
dd if=/dev/urandom of="$TMP/blob.bin" bs=1M count=8 status=none
python3 -m http.server 8765 --directory "$TMP" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV $GEN $SSP 2>/dev/null; rm -rf "$TMP"' EXIT

(
  sleep 3
  curl -sS -o /dev/null "http://127.0.0.1:8765/blob.bin"
  curl -sS -o /dev/null "https://proof.ovh.net/files/10Mb.dat"
  for i in 1 2 3; do curl -sS -o /dev/null -F "f=@$TMP/blob.bin" "https://httpbin.org/post"; done
  sleep 110
  curl -sS -o /dev/null "http://127.0.0.1:8765/blob.bin"
  curl -sS -o /dev/null "https://proof.ovh.net/files/10Mb.dat"
  sleep 110
  curl -sS -o /dev/null "http://127.0.0.1:8765/blob.bin"
  for i in 1 2 3; do curl -sS -o /dev/null -F "f=@$TMP/blob.bin" "https://httpbin.org/post"; done
) >spike-traffic.log 2>&1 &
GEN=$!

# ---- ss 轮询旁路采样(与 nethogs 同步,2s 一拍,供交叉验证与兜底评估) ----
(
  for i in $(seq 1 165); do
    echo "===== $(date +%s)"
    ss -tinp state established
    sleep 2
  done
) >ss-sample.txt 2>&1 &
SSP=$!

echo "采样 5.5 分钟(165 × 2s),期间自动生成测试流量…"
nethogs -t -d 2 -a -c 165 >nethogs.txt 2>&1
NETHOGS_EXIT=$?

kill "$SSP" 2>/dev/null
wait "$GEN" 2>/dev/null

echo
echo "== 完成(nethogs 退出码 $NETHOGS_EXIT)=="
wc -l nethogs.txt ss-sample.txt spike-traffic.log
echo "== nethogs.txt 前 15 行预览 =="
head -15 nethogs.txt
