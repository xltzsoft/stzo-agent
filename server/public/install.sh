#!/usr/bin/env bash
# STZO Agent installer (macOS / Linux)
#   curl -fsSL https://gc.stzo.cn/agent/install.sh | bash
# Env: STZO_SERVER (default https://gc.stzo.cn), STZO_REPO (default xltzsoft/stzo-agent),
#      STZO_PREFIX (npm prefix), STZO_NPM_REGISTRY (npm registry override), STZO_VERSION (pin a version)
set -euo pipefail

SERVER="${STZO_SERVER:-https://gc.stzo.cn}"
REPO="${STZO_REPO:-xltzsoft/stzo-agent}"
PKG="stzo-agent"
HOME_DIR="${STZO_HOME:-$HOME/.stzo-agent}"

say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m%s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "未找到 Node.js。请先安装 Node.js 22.19 或更高版本：https://nodejs.org/ （macOS 可用 brew install node）"
command -v npm  >/dev/null 2>&1 || die "未找到 npm，请重新安装 Node.js"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || die "Node.js 版本过低（$(node -v)），需要 >= 22.19"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "获取最新版本信息…"
MANIFEST="$TMP/release.json"
if curl -fsSL --max-time 10 "$SERVER/agent/api/update/latest" -o "$MANIFEST" 2>/dev/null; then
  SOURCE=mirror
elif curl -fsSL --max-time 20 "https://api.github.com/repos/$REPO/releases/latest" -o "$MANIFEST"; then
  SOURCE=github
else
  die "无法获取版本信息，请检查网络"
fi

# Prints: version, tarball name, sha256, then candidate URLs (one per line).
node - "$MANIFEST" "$SOURCE" "${STZO_VERSION:-}" > "$TMP/plan.txt" <<'NODE'
const fs = require("fs");
const [file, source, pin] = process.argv.slice(2);
let j = JSON.parse(fs.readFileSync(file, "utf8"));
if (source === "mirror") j = j.data;
const lines = [];
async function main() {
  let version, tarball, sha, urls = [];
  if (source === "mirror") {
    version = j.version; tarball = j.tarball || `stzo-agent-${version}.tgz`; sha = j.sha256 || "";
    const a = (j.assets || []).find((x) => x.name === tarball);
    if (a) urls = [a.mirror_url, a.github_url].filter(Boolean);
  } else {
    const assets = j.assets || [];
    const m = assets.find((x) => x.name === "latest.json");
    let man = {};
    if (m) man = await (await fetch(m.browser_download_url)).json().catch(() => ({}));
    version = String(man.version || j.tag_name || "").replace(/^v/, "");
    tarball = man.tarball || `stzo-agent-${version}.tgz`; sha = man.sha256 || "";
    const a = assets.find((x) => x.name === tarball);
    if (a) urls = [a.browser_download_url];
  }
  if (pin && pin !== version) { console.error(`STZO_VERSION=${pin} 与最新版本 ${version} 不同，请从 GitHub Releases 手动下载`); process.exit(2); }
  if (!urls.length) { console.error("发布中没有找到安装包"); process.exit(3); }
  console.log([version, tarball, sha, ...urls].join("\n"));
}
main();
NODE
VERSION="$(sed -n 1p "$TMP/plan.txt")"; TARBALL="$(sed -n 2p "$TMP/plan.txt")"; SHA="$(sed -n 3p "$TMP/plan.txt")"

say "下载 $PKG v$VERSION …"
OK=
while read -r URL; do
  [ -n "$URL" ] || continue
  if curl -fL --max-time 300 --retry 2 -o "$TMP/$TARBALL" "$URL"; then OK=1; break; fi
done < <(sed -n '4,$p' "$TMP/plan.txt")
[ -n "$OK" ] || die "下载失败"

if [ -n "$SHA" ]; then
  GOT="$(node -e 'const c=require("crypto"),f=require("fs");console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TMP/$TARBALL")"
  [ "$GOT" = "$SHA" ] || die "SHA256 校验失败（期望 $SHA，实际 $GOT）"
  say "校验通过"
fi

# npm prefix: honor STZO_PREFIX, else the global prefix if writable, else a private prefix.
PREFIX="${STZO_PREFIX:-}"
if [ -z "$PREFIX" ]; then
  GP="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$GP" ] && { [ -w "$GP/lib/node_modules" ] || { [ ! -e "$GP/lib/node_modules" ] && [ -w "$GP" ]; }; }; then
    PREFIX="$GP"
  else
    PREFIX="$HOME_DIR/npm-global"
  fi
fi
mkdir -p "$PREFIX"

REG_ARGS=()
if [ -n "${STZO_NPM_REGISTRY:-}" ]; then
  REG_ARGS=(--registry="$STZO_NPM_REGISTRY")
elif ! curl -fsS --max-time 4 -o /dev/null https://registry.npmjs.org/ 2>/dev/null; then
  say "npm 官方源不可达，使用 npmmirror 镜像"
  REG_ARGS=(--registry=https://registry.npmmirror.com)
fi

say "安装到 $PREFIX …"
npm install -g --prefix "$PREFIX" --no-audit --no-fund --loglevel=error ${REG_ARGS[@]+"${REG_ARGS[@]}"} "$TMP/$TARBALL"

BIN="$PREFIX/bin"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    case "${SHELL##*/}" in
      zsh)  RC="$HOME/.zshrc" ;;
      bash) RC="$HOME/.bashrc"; [ "$(uname)" = Darwin ] && RC="$HOME/.bash_profile" ;;
      *)    RC="$HOME/.profile" ;;
    esac
    grep -qs "stzo-agent PATH" "$RC" || printf '\n# stzo-agent PATH\nexport PATH="%s:$PATH"\n' "$BIN" >> "$RC"
    say "已把 $BIN 加入 PATH（新开终端生效，或执行：export PATH=\"$BIN:\$PATH\"）"
    ;;
esac

printf '\n\033[1;32m✓ STZO Agent v%s 安装完成\033[0m\n' "$VERSION"
echo "  1. 登录：  stzo login"
echo "  2. 使用：  cd 你的项目 && stzo"
echo "  之后会自动在后台更新，也可以手动执行 stzo update"
