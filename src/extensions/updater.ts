import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../account.ts";
import { BRAND, VERSION, compareVersions, loadState, patchState } from "../brand.ts";
import { fetchLatestRelease, installPrefix, installRelease, isNewer, shouldCheck } from "../updater.ts";

export default function updaterExtension(pi: ExtensionAPI) {
	let running = false;

	const autoEnabled = () => loadState().autoUpdate !== false;

	async function check(ctx: ExtensionContext, opts: { force?: boolean; install?: boolean } = {}) {
		if (running) return;
		if (!shouldCheck(opts.force)) {
			try {
				showPending(ctx);
			} catch {
				/* stale ctx */
			}
			return;
		}
		await runCheck(ctx, opts);
	}

	function showPending(ctx: ExtensionContext) {
		const pending = loadState().installedVersion;
		if (pending && compareVersions(pending, VERSION) > 0 && ctx.hasUI) {
			ctx.ui.setStatus("stzo-update", ctx.ui.theme.fg("success", `已更新到 v${pending}，重启生效`));
		}
	}

	async function runCheck(ctx: ExtensionContext, opts: { force?: boolean; install?: boolean }) {
		running = true;
		try {
			const rel = await fetchLatestRelease();
			patchState({ lastUpdateCheck: Date.now() });
			if (!isNewer(rel)) {
				if (opts.force) ctx.ui.notify(`已是最新版本 v${VERSION}`, "info");
				return;
			}
			const install = opts.install ?? autoEnabled();
			if (!install || !installPrefix()) {
				patchState({ pendingVersion: rel.version });
				ctx.ui.setStatus("stzo-update", ctx.ui.theme.fg("warning", `新版本 v${rel.version} · /update`));
				if (opts.force && !installPrefix()) ctx.ui.notify(`发现 v${rel.version}，但当前为开发模式，请 git pull 更新`, "warning");
				return;
			}
			ctx.ui.setStatus("stzo-update", ctx.ui.theme.fg("dim", `正在后台更新到 v${rel.version}…`));
			const r = await installRelease(rel);
			if (r.status === "updated") {
				ctx.ui.setStatus("stzo-update", ctx.ui.theme.fg("success", `已更新到 v${r.version}，重启生效`));
				ctx.ui.notify(`${BRAND.name} 已更新到 v${r.version}，下次启动生效`, "info");
			} else if (r.status === "failed") {
				ctx.ui.setStatus("stzo-update", ctx.ui.theme.fg("warning", `v${rel.version} 更新失败 · /update`));
				if (opts.force) ctx.ui.notify(`更新失败：${r.reason}`, "error");
			} else if (r.status === "skipped" && opts.force) {
				ctx.ui.notify(r.reason, "warning");
			}
		} catch (err) {
			if (opts.force) ctx.ui.notify(`检查更新失败：${(err as Error).message}`, "error");
		} finally {
			running = false;
		}
	}

	pi.on("session_start", async (_e, ctx) => {
		if (process.env.STZO_DESKTOP === "1") return; // the desktop app updates itself
		// Remote announcement / forced minimum version.
		void getConfig()
			.then((c) => {
				if (c.announcement && ctx.hasUI) ctx.ui.notify(c.announcement, "info");
				if (c.min_version && compareVersions(VERSION, c.min_version) < 0) {
					ctx.ui.notify(`当前版本 v${VERSION} 已停止支持，请执行 /update 更新到 v${c.min_version} 以上`, "error");
					void check(ctx, { force: true, install: true }).catch(() => {});
				}
			})
			.catch(() => {});
		// check() may run after a session switch made ctx stale; swallow instead of crashing.
		setTimeout(() => void check(ctx).catch(() => {}), 3000).unref?.();
	});

	pi.registerCommand("update", {
		description: `检查并安装 ${BRAND.name} 更新（/update auto on|off 设置自动更新）`,
		getArgumentCompletions: (prefix) =>
			["auto on", "auto off"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
		handler: async (args, ctx) => {
			const a = (args || "").trim();
			if (a === "auto on" || a === "auto off") {
				patchState({ autoUpdate: a === "auto on" });
				ctx.ui.notify(`自动更新已${a === "auto on" ? "开启" : "关闭"}`, "info");
				return;
			}
			ctx.ui.notify(`当前版本 v${VERSION}，正在检查更新…`, "info");
			await check(ctx, { force: true, install: true });
		},
	});

	pi.registerCommand("version", {
		description: `显示 ${BRAND.name} 版本`,
		handler: async (_a, ctx) => {
			ctx.ui.notify(`${BRAND.name} v${VERSION} · 自动更新${autoEnabled() ? "开" : "关"} · ${BRAND.repo}`, "info");
		},
	});
}
