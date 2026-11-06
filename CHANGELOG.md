# Changelog

## v0.1.0 (2026-11-06)

- 首个版本：基于 pi coding agent 1.5.0 封装
- 账号：浏览器设备码登录（/signin、`stzo login`），自动为本机创建分组 API Key
- 充值：/recharge 展示发卡网商品并跳转购买，/redeem 直接在终端兑换 CDK，底栏实时余额
- 模型：自动接入 gc.stzo.cn 中转站的 Claude / OpenAI / Gemini 分组，模型参数来自 pi 内置目录
- 插件：plan-mode、todo、subagent、question、handoff、session-name、confirm-destructive、protected-paths、notify、git-checkpoint
- OTA：GitHub Releases 发布，国内镜像加速，后台自动下载、SHA256 校验后安装，重启生效
