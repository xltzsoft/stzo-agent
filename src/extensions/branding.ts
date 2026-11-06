import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { BRAND, VERSION } from "../brand.ts";

export default function brandingExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_e, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setTitle(`${BRAND.command} · ${ctx.cwd.split(/[\\/]/).pop() || ""}`);
		ctx.ui.setHeader((_tui, theme) => {
			const lines = [
				`${theme.bold(theme.fg("accent", `◆ ${BRAND.name}`))} ${theme.fg("dim", `v${VERSION}`)}`,
				theme.fg(
					"dim",
					"/signin 登录 · /account 账户 · /recharge 充值 · /redeem 兑换 · /model 模型 · /plan 规划 · /update 更新 · /help 帮助",
				),
			];
			return new Text(lines.join("\n"), 0, 0);
		});
	});

	pi.registerCommand("help", {
		description: `${BRAND.name} 使用帮助`,
		handler: async (_a, ctx) => {
			pi.appendEntry("stzo-card", {
				title: `${BRAND.name} 帮助`,
				lines: [
					"账户：/stzo 菜单 · /signin 登录 · /signout 退出 · /account 账户详情 · /balance 余额",
					"充值：/recharge 购买兑换码 · /redeem <兑换码> 兑换",
					"模型：/model 选择模型 · Ctrl+P 切换 · /settings 设置",
					"插件：/plan 只读规划模式 · /todos 待办 · subagent 子代理 · /handoff 会话交接",
					"      在 `stzo config` 中可开关内置插件",
					"更新：/update 立即更新 · /update auto off 关闭自动更新 · /version",
					`文档：${BRAND.server}/docs/  · 源码：https://github.com/${BRAND.repo}`,
				],
			});
			ctx.ui.notify("帮助已显示在对话中", "info");
		},
	});
}
