# STZO Agent

终端里的 AI 编程助手，基于 [pi coding agent](https://github.com/earendil-works/pi) 二次封装：

- **账号**：浏览器设备码登录（兼容站点的 Turnstile 人机验证），登录后自动为本机创建分组 API Key
- **充值**：`/recharge` 直接列出发卡网商品，`/redeem <CDK>` 在终端兑换，底栏实时显示余额
- **模型**：自动接入 [gc.stzo.cn](https://gc.stzo.cn) 中转站的 Claude / OpenAI / Gemini 分组
- **插件**：规划模式、子代理、待办、危险命令确认、受保护路径、完成通知等，开箱即用
- **OTA**：GitHub Releases 发布，国内镜像加速，后台下载 → SHA256 校验 → 安装，重启生效

## 安装

```bash
curl -fsSL https://gc.stzo.cn/agent/install.sh | bash
```

Windows（PowerShell）：

```powershell
irm https://gc.stzo.cn/agent/install.ps1 | iex
```

需要 Node.js ≥ 22.19。

## 使用

```bash
stzo login        # 浏览器授权登录
cd your-project
stzo              # 启动
```

| 会话内命令 | 说明 |
|---|---|
| `/stzo` | 账户菜单（登录 / 余额 / 充值 / 兑换 / 退出） |
| `/signin` `/signout` | 登录 / 退出（pi 自带的 `/login` 用于其他模型厂商） |
| `/account` `/balance` | 账户详情 / 刷新余额 |
| `/recharge` | 购买充值卡（发卡网） |
| `/redeem <兑换码>` | 兑换 CDK |
| `/update` `/update auto off` | 立即更新 / 关闭自动更新 |
| `/plan` `/todos` `/handoff` | 内置插件 |

命令行：`stzo login | logout | account | recharge | redeem <code> | update | config | --help-pi`

数据目录 `~/.stzo-agent/`（`agent/` 为 pi 配置目录，`account.json` 保存登录凭据，权限 0600）。可以在 `stzo config` 中开关内置插件，或在 `~/.stzo-agent/agent/settings.json` 的 `extensions` 中写 `-builtin:<插件名>`。

## 架构

```
┌──────────── 用户电脑 ────────────┐        ┌──────────────── gc.stzo.cn ────────────────┐
│ stzo (bin/stzo.js)               │        │ nginx                                       │
│  └ pi main() + 内联扩展          │  HTTPS │  ├ /agent/  → stzo-agent bridge :3090       │
│     ├ stzo-account  登录/余额/充值│ ─────▶ │  │   设备码登录 · 代兑换 · 商品 · OTA 镜像   │
│     ├ stzo-updater  OTA           │        │  │       │ admin key / 用户 JWT(仅授权时)    │
│     ├ stzo-branding               │        │  │       ▼                                   │
│     └ builtin:plan-mode … 插件    │ ─────▶ │  └ /v1/  → Sub2API :8080（模型请求，按 Key 计费）│
└──────────────────────────────────┘        └─────────────────────────────────────────────┘
          ▲ Releases (tgz + latest.json + SHA256)          ▲ 发卡网 16688 商品 API
          └──────────── GitHub xltzsoft/stzo-agent ───────┘
```

**登录**：CLI 调 `POST /agent/api/device/start` 拿到授权码 → 浏览器打开 `/agent/device`（与 Sub2API 同源，可读取网站登录态）→ 用户确认并勾选分组 → bridge 用用户 JWT 校验身份、为该设备每个分组创建 API Key（重复登录会替换旧 Key），随即丢弃 JWT，签发 bridge 会话令牌 → CLI 轮询拿到令牌和 Key。

**兑换**：bridge 先用 admin 接口精确查找兑换码（必须存在且未使用），再调 `create-and-redeem` 为该用户原子兑换；查找这一步不能省，否则该接口会凭空创建新码。每用户每小时 10 次、每 IP 20 次限流。

**OTA**：`node scripts/release.mjs patch "说明"` → 推送 tag → Actions 打包 `stzo-agent-x.y.z.tgz`、生成 `latest.json`（含 SHA256）并发布 Release。客户端每 6 小时检查一次（先走 bridge 镜像，失败回落 GitHub API），发现新版本即后台下载、校验并 `npm install -g --prefix <原安装位置>`，下次启动生效。服务端可在 `client-config.json` 里设 `min_version` 强制升级、设 `announcement` 推送公告。

## 开发

```bash
npm install
npm test                 # 构建 + 单元测试 + bridge 端到端测试（mock Sub2API）
node bin/stzo.js         # 本地运行
STZO_SERVER=http://127.0.0.1:3090 node bin/stzo.js   # 指向本地 bridge
```

### 部署 bridge

```bash
# 首次：在服务器上创建 /etc/stzo-agent/server.env（参考 deploy/server.env.example，chmod 600）
#      并在 nginx 站点 :80 / :443 两个 server 块中 include deploy/nginx-agent.conf 的内容
deploy/deploy.sh root@gc.stzo.cn
```

### 发布新版本

```bash
node scripts/release.mjs patch "修复 xxx" "新增 yyy"
```

### 升级 pi 上游

修改 `package.json` 中 `@earendil-works/*` 的版本号（保持一致），`npm install && npm test`，再发版。`src/plugins/` 来自上游 `examples/extensions`，必要时对照上游更新。

## 许可

MIT。pi 及其示例扩展的版权声明见 [NOTICE.md](NOTICE.md)。
