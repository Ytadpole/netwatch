#!/usr/bin/env bash
# netwatch 本机常驻安装(Phase 5):渲染 deploy/*.service 的 @占位@ 并启用双 systemd 服务
# 用法:sudo bash deploy/install.sh        (sudo 只在这一步;agent 不代跑)
# 覆盖:NODE_BIN=/path/to/node WEB_USER=user REPO_DIR=/opt/netwatch sudo bash deploy/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STATE_DIR=/var/lib/netwatch

# --- 前置检查(在提权前后各做一次无妨)---
if [ "$(id -u)" != 0 ]; then
  echo "请用 sudo 运行:sudo bash deploy/install.sh" >&2
  exit 1
fi

# --- node 解析:优先 NODE_BIN;其次调用用户的 nvm(sudo 环境里没有,须从其家目录找);最后系统路径 ---
INVOKER="${SUDO_USER:-$(stat -c '%U' "$REPO_DIR")}"
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(ls -1 "$HOME/.nvm/versions/node/"*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$NODE_BIN" ] && [ "$INVOKER" != "root" ]; then
  NODE_BIN="$(ls -1 "/home/$INVOKER/.nvm/versions/node/"*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "✗ 找不到 node:用 NODE_BIN=/path/to/node 覆盖后重跑" >&2; exit 1; }

WEB_USER="${WEB_USER:-$INVOKER}"

# --- 依赖检查 ---
[ -f "$REPO_DIR/node_modules/tsx/dist/cli.mjs" ] || { echo "✗ 缺依赖:先在仓库目录 npm install" >&2; exit 1; }
[ -d "$REPO_DIR/apps/web/dist" ] || { echo "✗ 缺前端产物:先在仓库目录 npm run web:build" >&2; exit 1; }

# --- 共享状态目录:库(root 写/展示端读)+ 规则文件(展示端写白名单/采集端读)---
install -d -m 755 "$STATE_DIR"
[ -f "$STATE_DIR/rules.json" ] || install -o "$WEB_USER" -m 644 /dev/null "$STATE_DIR/rules.json"

# --- 渲染 unit(@REPO_DIR@/@NODE_BIN@/@WEB_USER@ → 本机真实值)并安装 ---
render() { sed -e "s|@REPO_DIR@|$REPO_DIR|g" -e "s|@NODE_BIN@|$NODE_BIN|g" -e "s|@WEB_USER@|$WEB_USER|g" "$1"; }
render "$SCRIPT_DIR/netwatch-collector.service" > /etc/systemd/system/netwatch-collector.service
render "$SCRIPT_DIR/netwatch-web.service"       > /etc/systemd/system/netwatch-web.service
chmod 644 /etc/systemd/system/netwatch-*.service

systemctl daemon-reload
systemctl enable --now netwatch-collector.service netwatch-web.service

echo
echo "✓ 安装完成(REPO_DIR=$REPO_DIR NODE_BIN=$NODE_BIN WEB_USER=$WEB_USER)"
echo "  采集端  journalctl -u netwatch-collector -f     (root,ss 轮询,写 $STATE_DIR/netwatch.db)"
echo "  仪表盘  http://127.0.0.1:8787                   (journalctl -u netwatch-web -f)"
echo "  验证自恢复(Phase 5 验收):sudo reboot 后两服务应自动拉起"
echo "  重装/更新:git pull && npm run web:build && sudo bash deploy/install.sh(幂等)"
