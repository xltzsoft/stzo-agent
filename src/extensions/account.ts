import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	type Account,
	BridgeError,
	fmtMoney,
	getConfig,
	getShop,
	loadAccount,
	logout,
	openUrl,
	redeem,
	refreshMe,
	startDeviceLogin,
	userLabel,
	waitForDeviceApproval,
} from "../account.ts";
import { BRAND } from "../brand.ts";
import { pickDefaultModel, refreshAccountModels, registerAccountProviders, unregisterAll } from "../providers.ts";

const CARD = "stzo-card";
const BALANCE_REFRESH_MS = 60_000;
const LOW_BALANCE = 1;
/** The desktop app shows account state in its own UI and restarts the agent after sign-in. */
const DESKTOP = process.env.STZO_DESKTOP === "1";

interface CardData {
	title: string;
	lines: string[];
	tone?: "info" | "success" | "warning" | "error";
}

export default async function accountExtension(pi: ExtensionAPI) {
	let account = loadAccount();
	let lastBalanceAt = 0;

	pi.registerEntryRenderer(CARD, (entry, _opts, theme) => {
		const d = entry.data as CardData;
		const color = d.tone === "error" ? "error" : d.tone === "warning" ? "warning" : d.tone === "success" ? "success" : "accent";
		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.bold(theme.fg(color as any, d.title)), 0, 0));
		for (const l of d.lines) box.addChild(new Text(l, 0, 0));
		return box;
	});
	const card = (title: string, lines: string[], tone?: CardData["tone"]) => pi.appendEntry(CARD, { title, lines, tone });

	// Async work can outlive its session (switch_session / new_session / reload make the captured
	// ctx stale, and touching it throws). Never let that become an unhandled rejection: it would
	// take the whole agent process down.
	const quietly = (p: Promise<unknown>) => void p.catch(() => {});

	const showBalance = (ctx: ExtensionContext) => {
		try {
			paintBalance(ctx);
		} catch {
			/* stale ctx */
		}
	};
	const paintBalance = (ctx: ExtensionContext) => {
		if (DESKTOP || !ctx.hasUI) return;
		if (!account) {
			ctx.ui.setStatus("stzo", ctx.ui.theme.fg("warning", "未登录 · /signin"));
			return;
		}
		const bal = account.user.balance;
		const text = `${userLabel(account.user)} · ${fmtMoney(bal)}`;
		ctx.ui.setStatus("stzo", typeof bal === "number" && bal < LOW_BALANCE ? ctx.ui.theme.fg("warning", `${text} 余额不足 /recharge`) : ctx.ui.theme.fg("dim", text));
	};

	const refreshBalance = async (ctx: ExtensionContext, force = false) => {
		if (!account || (!force && Date.now() - lastBalanceAt < BALANCE_REFRESH_MS)) return;
		lastBalanceAt = Date.now();
		try {
			await refreshMe(account);
		} catch (err) {
			if (err instanceof BridgeError && err.status === 401) {
				account = undefined;
				try {
					ctx.ui.notify(DESKTOP ? "STZO 登录已过期，请重新登录" : "STZO 登录已过期，请执行 /signin 重新登录", "warning");
				} catch {
					/* stale ctx */
				}
			}
		}
		showBalance(ctx);
	};

	// Startup: register relay providers before Pi picks the startup model (async factories are awaited).
	if (account) await registerAccountProviders(pi, account).catch(() => 0);

	pi.on("session_start", async (_event, ctx) => {
		showBalance(ctx);
		if (!account) {
			if (ctx.hasUI && !DESKTOP) ctx.ui.notify(`欢迎使用 ${BRAND.name}！输入 /signin 登录账号（没有账号会引导你注册）`, "info");
			return;
		}
		quietly(refreshAccountModels(pi, account));
		quietly(refreshBalance(ctx, true));
		// If nothing was chosen yet (or the chosen model is gone), switch to a relay model.
		if (!ctx.model) await selectDefault(ctx).catch(() => {});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await refreshBalance(ctx);
	});

	// Surface relay billing errors in plain language.
	pi.on("message_end", async (event: any, ctx) => {
		const msg = event?.message;
		if (msg?.role !== "assistant" || msg?.stopReason !== "error") return;
		const text = String(msg.errorMessage || "");
		if (/insufficient|余额|balance|quota|\b402\b/i.test(text)) {
			ctx.ui.notify(DESKTOP ? "STZO 余额不足，请在左下角账户处充值" : "STZO 余额不足：输入 /recharge 购买兑换码，或 /redeem <兑换码> 充值", "error");
			quietly(refreshBalance(ctx, true));
		} else if (/\b401\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|api key (is )?(invalid|expired|disabled)/i.test(text) && String(ctx.model?.provider || "").startsWith("stzo-")) {
			ctx.ui.notify(DESKTOP ? "API Key 已失效，请重新登录" : "API Key 已失效，请执行 /signin 重新授权", "error");
		}
	});

	async function selectDefault(ctx: ExtensionContext, preferred?: string) {
		if (!account) return;
		let pref = preferred;
		if (!pref) pref = (await getConfig().catch(() => undefined))?.recommended_model;
		const pick = pickDefaultModel(account, pref);
		if (!pick) return;
		const model = ctx.modelRegistry.find(pick.provider, pick.id);
		if (model) await pi.setModel(model);
	}

	async function doLogin(ctx: ExtensionCommandContext) {
		if (account) {
			const again = await ctx.ui.confirm("重新登录", `当前已登录 ${userLabel(account.user)}，要重新授权吗？`);
			if (!again) return;
		}
		let start;
		try {
			start = await startDeviceLogin();
		} catch (err) {
			ctx.ui.notify(`无法发起登录：${(err as Error).message}`, "error");
			return;
		}
		const opened = openUrl(start.verification_uri_complete);
		const t = ctx.ui.theme;
		const controller = new AbortController();
		const widget = () => [
			t.bold(t.fg("accent", `  ${BRAND.name} 登录`)),
			`  ${opened ? "已在浏览器打开授权页面，若未打开请手动访问：" : "请在浏览器打开："}`,
			`  ${t.fg("accent", start.verification_uri_complete)}`,
			`  授权码：${t.bold(start.user_code)}    ${t.fg("dim", "（没有账号可在页面上注册 · Esc 取消）")}`,
		];
		ctx.ui.setWidget("stzo-login", widget());
		const off = ctx.ui.onTerminalInput((data) => {
			if (data === "\u001b") {
				controller.abort(new Error("cancelled"));
				return { consume: true };
			}
			return undefined;
		});
		try {
			const prev = account;
			const next = await waitForDeviceApproval(start, controller.signal);
			if (prev) unregisterAll(pi, prev.keys);
			account = next;
			const n = await registerAccountProviders(pi, next, { live: true });
			await selectDefault(ctx);
			showBalance(ctx);
			card(
				"✓ 登录成功",
				[
					`账号：${userLabel(next.user)}    余额：${fmtMoney(next.user.balance)}`,
					`已授权分组：${next.keys.map((k) => k.group_name).join("、")}（共 ${n} 个模型）`,
					`当前模型：${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未选择，使用 /model 选择"}`,
					"常用命令：/account 账户 · /recharge 充值 · /redeem 兑换码 · /model 切换模型",
				],
				"success",
			);
		} catch (err) {
			if (controller.signal.aborted) ctx.ui.notify("已取消登录", "info");
			else ctx.ui.notify(`登录失败：${(err as Error).message}`, "error");
		} finally {
			off();
			ctx.ui.setWidget("stzo-login", undefined);
		}
	}

	pi.registerCommand("signin", {
		description: `登录 ${BRAND.name} 账号（浏览器授权）`,
		handler: async (_args, ctx) => doLogin(ctx),
	});

	async function doSignout(ctx: ExtensionCommandContext) {
			if (!account) return ctx.ui.notify("当前未登录", "info");
			if (!(await ctx.ui.confirm("退出登录", `退出 ${userLabel(account.user)}？本机保存的 API Key 会被删除。`))) return;
			unregisterAll(pi, account.keys);
			await logout(account);
			account = undefined;
			showBalance(ctx);
			ctx.ui.notify("已退出登录", "info");
	}

	pi.registerCommand("signout", {
		description: `退出 ${BRAND.name} 账号`,
		handler: async (_args, ctx) => doSignout(ctx),
	});

	async function doAccount(ctx: ExtensionCommandContext) {
			if (!account) return ctx.ui.notify("当前未登录，输入 /signin 登录", "warning");
			await refreshBalance(ctx, true);
			if (!account) return;
			const u = account.user;
			card(`${BRAND.name} 账户`, [
				`账号：${userLabel(u)}  (ID ${u.id})`,
				`余额：${fmtMoney(u.balance)}${u.frozen_balance ? `  冻结：${fmtMoney(u.frozen_balance)}` : ""}  累计充值：${fmtMoney(u.total_recharged)}`,
				`并发：${u.concurrency ?? "-"}  状态：${u.status ?? "-"}`,
				...account.keys.map((k) => `分组 ${k.group_name}（${k.platform}，倍率 ×${k.rate_multiplier ?? 1}）→ 模型提供方 stzo-g${k.group_id}`),
				`站点：${BRAND.server}`,
			]);
	}

	pi.registerCommand("account", {
		description: "查看账户、余额与已授权分组",
		handler: async (_args, ctx) => doAccount(ctx),
	});

	pi.registerCommand("balance", {
		description: "刷新并显示余额",
		handler: async (_args, ctx) => {
			if (!account) return ctx.ui.notify("当前未登录，输入 /signin 登录", "warning");
			await refreshBalance(ctx, true);
			if (account) ctx.ui.notify(`余额：${fmtMoney(account.user.balance)}`, "info");
		},
	});

	async function doRedeem(ctx: ExtensionCommandContext, code?: string) {
		if (!account) return ctx.ui.notify("请先 /signin 登录再兑换", "warning");
		const c = (code || (await ctx.ui.input("输入兑换码 (CDK)", "粘贴发卡网发给你的兑换码")) || "").trim();
		if (!c) return;
		try {
			const r = await redeem(account, c);
			showBalance(ctx);
			const what = r.type === "balance" ? `余额 +${fmtMoney(r.value)}` : r.type === "concurrency" ? `并发 +${r.value}` : `${r.type} ${r.value}`;
			card("✓ 兑换成功", [`${what}`, `当前余额：${fmtMoney(r.user.balance)}`], "success");
		} catch (err) {
			ctx.ui.notify(`兑换失败：${(err as Error).message}`, "error");
		}
	}

	pi.registerCommand("redeem", {
		description: "使用兑换码 (CDK) 充值：/redeem <兑换码>",
		handler: async (args, ctx) => doRedeem(ctx, args?.trim()),
	});

	async function doRecharge(ctx: ExtensionCommandContext) {
			let shop;
			try {
				shop = await getShop();
			} catch (err) {
				ctx.ui.notify(`获取商品失败：${(err as Error).message}`, "error");
				return;
			}
			const items = shop.items.filter((i) => (i.stock ?? 1) > 0);
			const labels = items.map((i) => `${i.name}  ¥${i.price}${typeof i.stock === "number" ? `  (库存 ${i.stock})` : ""}`);
			const HAVE_CODE = "我已有兑换码，直接兑换";
			const OPEN_SHOP = "打开店铺首页";
			const choice = await ctx.ui.select(`充值 · ${shop.name || "发卡网"}（购买后会收到兑换码）`, [...labels, HAVE_CODE, OPEN_SHOP]);
			if (!choice) return;
			if (choice === HAVE_CODE) return doRedeem(ctx);
			const url = choice === OPEN_SHOP ? shop.url : items[labels.indexOf(choice)]?.url;
			if (!url) return;
			const opened = openUrl(url);
			card("购买充值卡", [
				opened ? "已在浏览器打开购买页面。" : "请在浏览器打开购买页面：",
				url,
				"付款后页面会显示兑换码（CDK），复制后回到这里。",
				shop.contact_qq ? `售后 QQ：${shop.contact_qq}` : "",
			].filter(Boolean));
			await doRedeem(ctx);
	}

	pi.registerCommand("recharge", {
		description: "购买充值卡（发卡网）并兑换",
		handler: async (_args, ctx) => doRecharge(ctx),
	});

	pi.registerCommand("stzo", {
		description: `${BRAND.name} 菜单：登录、账户、充值、兑换、退出`,
		handler: async (_args, ctx) => {
			const items = account
				? ["账户与余额", "购买充值卡", "输入兑换码", "重新授权 / 切换账号", "退出登录"]
				: ["登录 / 注册", "购买充值卡"];
			const c = await ctx.ui.select(account ? `${BRAND.name} · ${userLabel(account.user)} · ${fmtMoney(account.user.balance)}` : BRAND.name, items);
			if (!c) return;
			if (c.startsWith("登录") || c.startsWith("重新授权")) return doLogin(ctx);
			if (c === "账户与余额") return doAccount(ctx);
			if (c === "购买充值卡") return doRecharge(ctx);
			if (c === "输入兑换码") return doRedeem(ctx);
			if (c === "退出登录") return doSignout(ctx);
		},
	});
}
