// Short-lived `stzo desktop-api <method>` calls.
import { kill, spawn } from "./native";

export interface Group {
	id: number;
	name: string;
	platform: string;
	rate: number;
	provider: string;
}
export interface User {
	id: number;
	email?: string;
	username?: string;
	balance?: number;
	frozen_balance?: number;
	total_recharged?: number;
}
export interface AccountState {
	loggedIn: boolean;
	expired?: boolean;
	server: string;
	user?: User;
	groups?: Group[];
}
export interface ShopItem {
	goods_no: string;
	name: string;
	price: number;
	stock?: number;
	stock_status?: string;
	url: string;
}
export interface Shop {
	name?: string;
	url: string;
	contact_qq?: string;
	items: ShopItem[];
	error?: string;
}
export interface PluginState {
	name: string;
	title: string;
	description: string;
	defaultEnabled: boolean;
	enabled: boolean;
}
export interface SessionSummary {
	path: string;
	id: string;
	name?: string;
	firstMessage: string;
	modified: number;
	messageCount: number;
}
export interface ClientConfig {
	site: string;
	register_url: string;
	redeem_url: string;
	doc_url: string;
	shop_url: string;
	announcement?: string;
	recommended_model?: string;
}

export class ApiError extends Error {}

/** Run a desktop-api method; `onLine` sees every JSON line, the promise resolves with the last one. */
export function call<T = any>(method: string, args: string[] = [], opts: { cwd?: string; onLine?: (obj: any) => void; signal?: AbortSignal } = {}): Promise<T> {
	return new Promise((resolve, reject) => {
		let last: any;
		const stderr: string[] = [];
		let pid: number | undefined;
		const onAbort = () => pid !== undefined && void kill(pid);
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		spawn(["desktop-api", method, ...args], opts.cwd, (e) => {
			if (e.kind === "stdout") {
				try {
					last = JSON.parse(e.line);
					opts.onLine?.(last);
				} catch {
					/* not ours */
				}
			} else if (e.kind === "stderr") {
				stderr.push(e.line);
			} else {
				opts.signal?.removeEventListener("abort", onAbort);
				if (opts.signal?.aborted) return reject(new ApiError("已取消"));
				if (!last) return reject(new ApiError(stderr.slice(-3).join("\n") || `desktop-api ${method} 退出（${e.code}）`));
				if (last.ok === false) return reject(new ApiError(last.error || "请求失败"));
				resolve(last as T);
			}
		})
			.then((id) => {
				pid = id;
				if (opts.signal?.aborted) void kill(id);
			})
			.catch((err) => reject(new ApiError(String(err))));
	});
}

export const api = {
	account: () => call<AccountState & { ok: true }>("account"),
	logout: () => call("logout"),
	redeem: (code: string) => call<{ type: string; value: number; user: User }>("redeem", [code]),
	shop: () => call<Shop & { ok: true }>("shop"),
	config: () => call<ClientConfig & { ok: true }>("config"),
	plugins: () => call<{ plugins: PluginState[] }>("plugins").then((r) => r.plugins),
	setPlugin: (name: string, on: boolean) => call<{ plugins: PluginState[] }>("plugin-set", [name, on ? "on" : "off"]).then((r) => r.plugins),
	sessions: (cwd: string) => call<{ sessions: SessionSummary[] }>("sessions", [cwd]).then((r) => r.sessions),
	files: (cwd: string) => call<{ files: string[] }>("files", [cwd]).then((r) => r.files),
	version: () => call<{ version: string; server: string; repo: string }>("version"),
	login: (onDevice: (d: { user_code: string; url: string; expires_in: number }) => void, signal?: AbortSignal) =>
		call<{ user: User; groups: string[] }>("login", [], {
			signal,
			onLine: (o) => o.event === "device" && onDevice(o),
		}),
};

export function money(v?: number) {
	if (typeof v !== "number") return "—";
	return `$${v.toFixed(v >= 100 ? 0 : 2)}`;
}

export function displayName(u?: User) {
	return u?.username || u?.email?.split("@")[0] || (u ? `用户 ${u.id}` : "");
}
