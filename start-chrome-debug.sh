#!/bin/bash
# OpenClaw 远程调试模式启动 Chrome
# 用 rsync 全量同步 Default Profile，绕过 "non-default data directory" 限制

set -eo pipefail
# rsync 退出码 23/24 表示部分文件跳过，属于正常
RSYNC_OK() { local rc=$1; [[ $rc -eq 0 || $rc -eq 23 || $rc -eq 24 ]] && return 0 || return $rc; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HOME/Library/Application Support/Google/Chrome"
DEBUG_DIR="$HOME/Library/Application Support/Google/ChromeRemoteDebug"

# ---------------------------------------------------------------------------
# Extensions + initScripts
# 镜像 plugins/agent-browser-plugin-stealth/src/index.ts 的 Extensions 与
# initScripts 能力：
#   - Extensions: 默认加载 capsolver-extension。
#   - initScripts: 通过独立的 stealth-extension（document_start + MAIN world
#     内容脚本）注入隐身初始化脚本。
# ---------------------------------------------------------------------------
STEALTH_EXT_DIR="$SCRIPT_DIR/stealth-extension"

# 默认加载的扩展：capsolver + stealth 初始化扩展（initScripts 能力）
EXTENSION_PATHS=(
  "$SCRIPT_DIR/capsolver-extension"
  "$STEALTH_EXT_DIR"
)

# 校验路径并拼接 --load-extension 参数
CHROME_EXTENSION_ARGS=()
VALID_EXTENSIONS=()
for _ext in "${EXTENSION_PATHS[@]}"; do
  if [[ -d "$_ext" ]]; then
    VALID_EXTENSIONS+=("$_ext")
  else
    echo "⚠️  扩展路径不存在，已跳过: $_ext" >&2
  fi
done
if [[ ${#VALID_EXTENSIONS[@]} -gt 0 ]]; then
  _joined="$(IFS=','; echo "${VALID_EXTENSIONS[*]}")"
  CHROME_EXTENSION_ARGS+=("--load-extension=$_joined")
  echo "🧩 加载扩展: $_joined"
fi

echo "🔄 退出 Chrome..."
pkill -f "Google Chrome" 2>/dev/null || true
sleep 2

echo "🔄 同步 Profile 数据..."
rsync -a --delete --ignore-errors --partial \
  --exclude="LOCK" \
  --exclude="LOG" \
  --exclude="LOG.old" \
  --exclude="SingletonLock" \
  --exclude="SingletonCookie" \
  --exclude="SingletonSocket" \
  --exclude="CrashpadMetrics*" \
  --exclude="*-journal" \
  --exclude="*-wal" \
  --exclude="*-shm" \
  --exclude="GPUCache/" \
  --exclude="DawnGraphiteCache/" \
  --exclude="DawnWebGPUCache/" \
  --exclude="ShaderCache/" \
  --exclude="Code Cache/" \
  "$SRC/Default/" "$DEBUG_DIR/Default/" || true

echo "✅ 同步完成"
# 
#  --no-first-run \
#  --no-default-browser-check \
echo "🚀 启动 Chrome 调试模式..."
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$DEBUG_DIR" \
  --profile-directory="Default" \
  --disable-blink-features=AutomationControlled \
  --disable-infobars \
  "${CHROME_EXTENSION_ARGS[@]}" \
  "$@" > /tmp/chrome-debug.log 2>&1 &

echo "⏳ 等待调试端口就绪..."
for i in $(seq 1 15); do
  sleep 1
  if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    echo "✅ Chrome 调试模式已启动 (port 9222)"
    curl -s http://127.0.0.1:9222/json/version | python3 -m json.tool | grep '"Browser"'
    exit 0
  fi
done
echo "⚠️  超时，查看日志: tail /tmp/chrome-debug.log"
