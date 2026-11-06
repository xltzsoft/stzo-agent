# STZO Agent installer (Windows PowerShell)
#   irm https://gc.stzo.cn/agent/install.ps1 | iex
$ErrorActionPreference = "Stop"
$Server = if ($env:STZO_SERVER) { $env:STZO_SERVER } else { "https://gc.stzo.cn" }
$Repo   = if ($env:STZO_REPO)   { $env:STZO_REPO }   else { "xltzsoft/stzo-agent" }

function Say($m) { Write-Host "==> $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "错误：$m" -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "未找到 Node.js。请先安装 Node.js 22.19+：https://nodejs.org/ （或 winget install OpenJS.NodeJS.LTS）" }
& node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)'
if ($LASTEXITCODE -ne 0) { Die "Node.js 版本过低（$(node -v)），需要 >= 22.19" }

Say "获取最新版本信息…"
$version = $null; $tarball = $null; $sha = $null; $urls = @()
try {
  $r = (Invoke-RestMethod -Uri "$Server/agent/api/update/latest" -TimeoutSec 10).data
  $version = $r.version; $tarball = if ($r.tarball) { $r.tarball } else { "stzo-agent-$version.tgz" }; $sha = $r.sha256
  $a = $r.assets | Where-Object { $_.name -eq $tarball } | Select-Object -First 1
  if ($a) { $urls = @($a.mirror_url, $a.github_url) | Where-Object { $_ } }
} catch {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -TimeoutSec 20
  $m = $rel.assets | Where-Object { $_.name -eq "latest.json" } | Select-Object -First 1
  $man = if ($m) { Invoke-RestMethod -Uri $m.browser_download_url } else { @{} }
  $version = if ($man.version) { $man.version } else { $rel.tag_name.TrimStart("v") }
  $tarball = if ($man.tarball) { $man.tarball } else { "stzo-agent-$version.tgz" }; $sha = $man.sha256
  $a = $rel.assets | Where-Object { $_.name -eq $tarball } | Select-Object -First 1
  if ($a) { $urls = @($a.browser_download_url) }
}
if (-not $urls) { Die "发布中没有找到安装包" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) $tarball
Say "下载 stzo-agent v$version …"
$ok = $false
foreach ($u in $urls) { try { Invoke-WebRequest -Uri $u -OutFile $tmp -UseBasicParsing -TimeoutSec 300; $ok = $true; break } catch {} }
if (-not $ok) { Die "下载失败" }
if ($sha) {
  $got = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower()
  if ($got -ne $sha.ToLower()) { Die "SHA256 校验失败" }
  Say "校验通过"
}

$reg = @()
if ($env:STZO_NPM_REGISTRY) { $reg = @("--registry=$($env:STZO_NPM_REGISTRY)") }
else { try { Invoke-WebRequest -Uri "https://registry.npmjs.org/" -Method Head -TimeoutSec 4 -UseBasicParsing | Out-Null } catch { Say "npm 官方源不可达，使用 npmmirror 镜像"; $reg = @("--registry=https://registry.npmmirror.com") } }

Say "安装中…"
& npm install -g --no-audit --no-fund --loglevel=error @reg $tmp
if ($LASTEXITCODE -ne 0) { Die "npm 安装失败" }
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "✓ STZO Agent v$version 安装完成" -ForegroundColor Green
Write-Host "  1. 登录：  stzo login"
Write-Host "  2. 使用：  cd 你的项目; stzo"
Write-Host "  之后会自动在后台更新，也可以手动执行 stzo update"
