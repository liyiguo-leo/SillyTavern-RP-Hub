#!/usr/bin/env bash
# tools/install-server.sh —— 把 server/ 装进 SillyTavern/plugins/（Linux / Termux / macOS）
#
# 只有「自建 ST（含 Termux 手机端 Node 版）」需要；TT酒馆（TauriTavern）没有 Node 服务端，
# 前端 local/ 已接管全部接口，跳过本脚本即可。
#
# 用法：
#   bash tools/install-server.sh /path/to/SillyTavern          # 复制
#   bash tools/install-server.sh /path/to/SillyTavern --link   # 软链接（改代码即时生效）
#   bash tools/install-server.sh /path/to/SillyTavern --uninstall

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/server"
MODE="copy"

if [[ $# -lt 1 ]]; then
    echo "用法：bash tools/install-server.sh <SillyTavern 路径> [--link|--uninstall]" >&2
    exit 1
fi

ST_ROOT="$(cd "$1" && pwd)"
shift || true
UNINSTALL=0
for arg in "$@"; do
    case "$arg" in
        --link) MODE="link" ;;
        --uninstall) UNINSTALL=1 ;;
        *) echo "未知参数：$arg" >&2; exit 1 ;;
    esac
done

[[ -f "$ST_ROOT/server.js" ]] || { echo "不是 SillyTavern 根目录（缺 server.js）：$ST_ROOT" >&2; exit 1; }

PLUGINS_DIR="$ST_ROOT/plugins"
TARGET="$PLUGINS_DIR/rp-hub-compat"
CONFIG="$ST_ROOT/config.yaml"

if [[ $UNINSTALL -eq 1 ]]; then
    rm -rf "$TARGET"
    echo "已移除：$TARGET"
    exit 0
fi

[[ -d "$SRC" ]] || { echo "仓库缺少 server/：$SRC" >&2; exit 1; }
mkdir -p "$PLUGINS_DIR"
rm -rf "$TARGET"

if [[ "$MODE" == "link" ]]; then
    ln -s "$SRC" "$TARGET"
    echo "已软链：$TARGET -> $SRC"
else
    cp -R "$SRC" "$TARGET"
    echo "已复制：$TARGET"
fi

if [[ -f "$CONFIG" ]]; then
    cp "$CONFIG" "$CONFIG.bak"
    if grep -qE '^[[:space:]]*enableServerPlugins[[:space:]]*:' "$CONFIG"; then
        sed -i.tmp -E 's/^[[:space:]]*enableServerPlugins[[:space:]]*:.*/enableServerPlugins: true/' "$CONFIG"
        rm -f "$CONFIG.tmp"
    else
        printf '\nenableServerPlugins: true\n' >> "$CONFIG"
    fi
    echo "config.yaml 已确保 enableServerPlugins: true（备份：$CONFIG.bak）"
else
    echo "警告：未找到 config.yaml，请手动加 enableServerPlugins: true" >&2
fi

cat <<'EOF'

下一步：重启 SillyTavern，验证
  curl http://127.0.0.1:8000/api/plugins/rp-hub-compat/v1/status
前端 local/ 为 auto 模式：插件在 → 用服务器库；插件不在 → 用浏览器 IndexedDB。
EOF
