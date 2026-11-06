// JSON-lines API for the desktop app. Every call prints one or more JSON objects (one per line)
// and exits. Errors are printed as {"ok":false,"error":"..."} with exit code 0 so the UI can show them.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { BridgeError, getConfig, getShop, loadAccount, logout, redeem, refreshMe, startDeviceLogin, waitForDeviceApproval } from "./account.ts";
import { AGENT_DIR, BRAND, VERSION, readJson, writeJson } from "./brand.ts";
import { PLUGIN_INFO } from "./plugin-info.ts";

const emit = (obj: unknown): void => {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
};
const SETTINGS = () => join(AGENT_DIR, "settings.json");

function publicAccount() {
	const a = loadAccount();
	if (!a) return { ok: true, loggedIn: false, server: BRAND.server };
	return {
		ok: true,
		loggedIn: true,
		server: BRAND.server,
		user: a.user,
		groups: a.keys.map((k) => ({ id: k.group_id, name: k.group_name, platform: k.platform, rate: k.rate_multiplier ?? 1, provider: `stzo-g${k.group_id}` })),
	};
}

function plugins() {
	const settings = readJson<{ extensions?: string[] }>(SETTINGS(), {});
	const disabled = new Set((settings.extensions ?? []).filter((e) => e.startsWith("-builtin:")).map((e) => e.slice(9)));
	return PLUGIN_INFO.map((p) => ({ ...p, enabled: !disabled.has(p.name) }));
}

function setPlugin(name: string, on: boolean) {
	if (!PLUGIN_INFO.some((p) => p.name === name)) throw new Error(`未知插件：${name}`);
	const settings = readJson<Record<string, any>>(SETTINGS(), {});
	const list: string[] = (settings.extensions ?? []).filter((e: string) => e !== `-builtin:${name}` && e !== `+builtin:${name}`);
	if (!on) list.push(`-builtin:${name}`);
	settings.extensions = list;
	writeJson(SETTINGS(), settings);
}

export async function desktopApi(args: string[]) {
	const [method, ...rest] = args;
	try {
		switch (method) {
			case "version":
				return emit({ ok: true, version: VERSION, server: BRAND.server, repo: BRAND.repo });
			case "account": {
				const a = loadAccount();
				if (a) {
					try {
						await refreshMe(a);
					} catch (err) {
						if (err instanceof BridgeError && err.status === 401) {
							return emit({ ok: true, loggedIn: false, expired: true, server: BRAND.server });
						}
						// Offline: fall through with the cached balance.
					}
				}
				return emit(publicAccount());
			}
			case "login": {
				const start = await startDeviceLogin();
				emit({ ok: true, event: "device", user_code: start.user_code, url: start.verification_uri_complete, expires_in: start.expires_in });
				const account = await waitForDeviceApproval(start);
				return emit({ ok: true, event: "done", user: account.user, groups: account.keys.map((k) => k.group_name) });
			}
			case "logout":
				await logout(loadAccount());
				return emit({ ok: true });
			case "redeem": {
				const a = loadAccount();
				if (!a) return emit({ ok: false, error: "请先登录" });
				const r = await redeem(a, rest[0] ?? "");
				return emit({ ok: true, type: r.type, value: r.value, user: r.user });
			}
			case "shop":
				return emit({ ok: true, ...(await getShop()) });
			case "config":
				return emit({ ok: true, ...(await getConfig()) });
			case "plugins":
				return emit({ ok: true, plugins: plugins() });
			case "plugin-set":
				setPlugin(rest[0] ?? "", rest[1] === "on");
				return emit({ ok: true, plugins: plugins() });
			case "sessions": {
				const { SessionManager } = await import("@earendil-works/pi-coding-agent");
				// Sessions are keyed by the resolved cwd (e.g. /tmp → /private/tmp on macOS), same as the agent sees it.
				let cwd = rest[0] || process.cwd();
				try {
					cwd = realpathSync(cwd);
				} catch {
					/* keep as given */
				}
				const list = await SessionManager.list(cwd);
				return emit({
					ok: true,
					sessions: list
						.sort((a, b) => +new Date(b.modified) - +new Date(a.modified))
						.slice(0, 200)
						.map((s) => ({
							path: s.path,
							id: s.id,
							name: s.name,
							firstMessage: (s.firstMessage || "").slice(0, 120),
							modified: new Date(s.modified).getTime(),
							messageCount: s.messageCount,
						})),
				});
			}
			default:
				return emit({ ok: false, error: `unknown method: ${method}` });
		}
	} catch (err) {
		emit({ ok: false, error: err instanceof Error ? err.message : String(err) });
	}
}
