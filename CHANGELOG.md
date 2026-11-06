# Changelog

## v0.2.1 (2026-11-06)

- 修复：桌面版切换会话后智能体崩溃（智能体已停止）
- 修复：经中转站调用 Mistral/DeepSeek 等模型时报 422（developer 角色）与 reasoning_effort 不支持
- 修复：模型请求错误被误报为“授权已失效”
- 改进：上游失败自动重试时不再重复显示回复，错误信息更易读

## v0.2.0 (2026-11-06)

- 桌面应用：macOS（Apple 芯片 / Intel）dmg 与 Windows 安装包，内置 Node 运行时，开箱即用
- 全新界面：项目文件夹、会话历史、模型与思考强度选择、工具调用时间线与改动对比
- 应用内登录、充值与兑换码兑换，插件开关，一键更新
- 安装脚本不再需要 sudo，安装到 ~/.stzo-agent/cli；修复 macOS 安装后找不到 stzo 命令
- 默认选择倍率最低的分组；更新清单改名为 cli-latest.json（兼容旧版本）

## v0.1.0 (2026-11-06)

- 首个版本：基于 pi coding agent 1.5.0 封装
- 账号：浏览器设备码登录（/signin、`stzo login`），自动为本机创建分组 API Key
- 充值：/recharge 展示发卡网商品并跳转购买，/redeem 直接在终端兑换 CDK，底栏实时余额
- 模型：自动接入 gc.stzo.cn 中转站的 Claude / OpenAI / Gemini 分组，模型参数来自 pi 内置目录
- 插件：plan-mode、todo、subagent、question、handoff、session-name、confirm-destructive、protected-paths、notify、git-checkpoint
- OTA：GitHub Releases 发布，国内镜像加速，后台自动下载、SHA256 校验后安装，重启生效
