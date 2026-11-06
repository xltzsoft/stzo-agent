import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
	BridgeError,
	fmtMoney,
	getShop,
	loadAccount,
	logout,
	redeem,
	refreshMe,
	startDeviceLogin,
	userLabel,
	waitForDeviceApproval,
} from "./account.ts";
import { AGENT_DIR, BRAND, CACHE_DIR, HOME, PACKAGE_ROOT, VERSION, ensureDir, loadState, patchState, writeJson } from "./brand.ts";
import accountExtension, { openUrl } from "./extensions/account.ts";
import brandingExtension from "./extensions/branding.ts";
import updaterExtension from "./extensions/updater.ts";
import confirmDestructive from "./plugins/confirm-destructive/index.ts";
import gitCheckpoint from "./plugins/git-checkpoint/index.ts";
import handoff from "./plugins/handoff/index.ts";
import notify from "./plugins/notify/index.ts";
import planMode from "./plugins/plan-mode/index.ts";
import protectedPaths from "./plugins/protected-paths/index.ts";
import question from "./plugins/question/index.ts";
import sessionName from "./plugins/session-name/index.ts";
import subagent from "./plugins/subagent/index.ts";
import todo from "./plugins/todo/index.ts";
import { fetchLatestRelease, installRelease, isNewer } from "./updater.ts";

/** Bundled plugins. Users toggle them with `stzo config` or `-builtin:<name>` in settings.json. */
const PLUGINS: InlineExtension[] = [
	{ name: "plan-mode", factory: planMode, builtin: true },
	{ name: "todo", factory: todo, builtin: true },
	{ name: "subagent", factory: subagent, builtin: true },
	{ name: "question", factory: question, builtin: true },
	{ name: "handoff", factory: handoff, builtin: true },
	{ name: "session-name", factory: sessionName, builtin: true },
	{ name: "confirm-destructive", factory: confirmDestructive, builtin: true },
	{ name: "protected-paths", factory: protectedPaths, builtin: true },
	{ name: "notify", factory: notify, builtin: true },
	{ name: "git-checkpoint", factory: gitCheckpoint, builtin: true },
];
const DISABLED_BY_DEFAULT = ["git-checkpoint"];

const CORE: InlineExtension[] = [
	{ name: "stzo-account", factory: accountExtension, hidden: true },
	{ name: "stzo-updater", factory: updaterExtension, hidden: true },
	{ name: "stzo-branding", factory: brandingExtension, hidden: true },
];

function configureEnvironment() {
	process.env.PI_CODING_AGENT_DIR ||= AGENT_DIR;
	// Pi's own update check targets pi.dev; we ship our own OTA channel.
	process.env.PI_SKIP_VERSION_CHECK = "1";
	process.env.PI_TELEMETRY ??= "0";
	process.env.STZO_AGENT = "1";
}

function copyMissing(srcDir: string, dstDir: string) {
	if (!existsSync(srcDir)) return;
	ensureDir(dstDir);
	for (const f of readdirSync(srcDir)) {
		const dst = join(dstDir, f);
		if (!existsSync(dst)) copyFileSync(join(srcDir, f), dst);
	}
}

/** First run (and after each upgrade): default settings plus bundled sub-agents and prompts. */
function seed() {
	ensureDir(HOME);
	ensureDir(AGENT_DIR);
	ensureDir(CACHE_DIR);
	const settingsFile = join(AGENT_DIR, "settings.json");
	if (!existsSync(settingsFile)) {
		writeJson(settingsFile, {
			extensions: DISABLED_BY_DEFAULT.map((n) => `-builtin:${n}`),
			quietStartup: "header",
			collapseChangelog: true,
		});
	}
	const state = loadState();
	if (state.seededVersion !== VERSION) {
		copyMissing(join(PACKAGE_ROOT, "resources", "agents"), join(AGENT_DIR, "agents"));
		copyMissing(join(PACKAGE_ROOT, "resources", "prompts"), join(AGENT_DIR, "prompts"));
		patchState({ seededVersion: VERSION });
	}
}

const out = (s = ""): void => {
	process.stdout.write(`${s}\n`);
};

async function cmdLogin() {
	const start = await startDeviceLogin();
	const opened = openUrl(start.verification_uri_complete);
	out(`\n  ${BRAND.name} 登录`);
	out(`  ${opened ? "已在浏览器打开授权页面；如未打开请访问：" : "请在浏览器打开："}`);
	out(`  ${start.verification_uri_complete}`);
	out(`  授权码：${start.user_code}\n`);
	out("  等待授权中…（Ctrl+C 取消）");
	const account = await waitForDeviceApproval(start);
	out(`\n  ✓ 已登录 ${userLabel(account.user)}，余额 ${fmtMoney(account.user.balance)}`);
	out(`  已授权分组：${account.keys.map((k) => k.group_name).join("、")}`);
	out(`  运行 \`${BRAND.command}\` 开始使用。`);
}

async function cmdAccount() {
	const a = loadAccount();
	if (!a) return out(`未登录。运行 \`${BRAND.command} login\` 登录。`);
	const u = await refreshMe(a);
	out(`账号：${userLabel(u)} (ID ${u.id})`);
	out(`余额：${fmtMoney(u.balance)}   累计充值：${fmtMoney(u.total_recharged)}`);
	for (const k of a.keys) out(`分组：${k.group_name}（${k.platform}，×${k.rate_multiplier ?? 1}）`);
}

async function cmdRedeem(code: string | undefined) {
	const a = loadAccount();
	if (!a) return out(`未登录。运行 \`${BRAND.command} login\` 登录。`);
	if (!code) return out(`用法：${BRAND.command} redeem <兑换码>`);
	const r = await redeem(a, code);
	out(`✓ 兑换成功：${r.type === "balance" ? `余额 +${fmtMoney(r.value)}` : `${r.type} +${r.value}`}，当前余额 ${fmtMoney(r.user.balance)}`);
}

async function cmdRecharge() {
	const shop = await getShop();
	out(`${shop.name || "发卡网"} — 购买后获得兑换码，再运行 \`${BRAND.command} redeem <兑换码>\``);
	for (const i of shop.items) out(`  ${i.name}  ¥${i.price}  ${i.url}`);
	out(`  店铺：${shop.url}`);
}

async function cmdUpdate() {
	out(`当前版本 v${VERSION}，检查更新…`);
	const rel = await fetchLatestRelease();
	if (!isNewer(rel)) return out(`已是最新版本（最新发布 v${rel.version || "?"}）`);
	out(`发现新版本 v${rel.version}（来源：${rel.source === "mirror" ? "国内镜像" : "GitHub"}）`);
	const r = await installRelease(rel, (m) => out(`  ${m}`));
	if (r.status === "updated") out(`✓ 已更新到 v${r.version}`);
	else if (r.status === "failed") {
		out(`✗ 更新失败：${r.reason}`);
		process.exitCode = 1;
	} else if (r.status === "skipped") out(r.reason);
}

function cmdHelp() {
	out(`${BRAND.name} v${VERSION} — 基于 pi coding agent

用法：
  ${BRAND.command}                    启动交互式编程助手
  ${BRAND.command} "<提示词>"          带初始提示启动
  ${BRAND.command} -p "<提示词>"       非交互模式，输出结果后退出
  ${BRAND.command} login              浏览器授权登录（也可在会话内 /signin）
  ${BRAND.command} logout             退出登录
  ${BRAND.command} account            查看账户与余额
  ${BRAND.command} recharge           查看充值卡商品
  ${BRAND.command} redeem <兑换码>     兑换充值
  ${BRAND.command} update             立即检查并安装更新
  ${BRAND.command} config             开关内置插件与资源
  ${BRAND.command} --help-pi          显示底层 pi 的完整命令行帮助

数据目录：${HOME}
项目主页：https://github.com/${BRAND.repo}`);
}

export async function run(argv: string[]) {
	configureEnvironment();
	seed();
	const [cmd, ...rest] = argv;
	const handlers: Record<string, () => Promise<void> | void> = {
		login: cmdLogin,
		signin: cmdLogin,
		logout: async () => {
			await logout(loadAccount());
			out("已退出登录");
		},
		signout: async () => {
			await logout(loadAccount());
			out("已退出登录");
		},
		account: cmdAccount,
		whoami: cmdAccount,
		redeem: () => cmdRedeem(rest[0]),
		recharge: cmdRecharge,
		update: cmdUpdate,
		version: () => out(VERSION),
		"--version": () => out(VERSION),
		"-v": () => out(VERSION),
		help: cmdHelp,
		"--help": cmdHelp,
		"-h": cmdHelp,
	};
	if (cmd && handlers[cmd] && !(cmd.startsWith("-") && rest.length > 0 && cmd !== "--help" && cmd !== "-h")) {
		try {
			await handlers[cmd]();
		} catch (err) {
			process.stderr.write(`错误：${err instanceof BridgeError || err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 1;
		}
		return;
	}
	const args = argv.map((a) => (a === "--help-pi" ? "--help" : a));
	const { main } = await import("@earendil-works/pi-coding-agent");
	process.title = BRAND.command;
	await main(args, { extensionFactories: [...CORE, ...PLUGINS] });
}


