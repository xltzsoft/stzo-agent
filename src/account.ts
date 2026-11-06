import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname, platform, arch } from "node:os";
import { ACCOUNT_FILE, BRAND, VERSION, bridgeUrl, loadState, patchState, readJson, writeJson } from "./brand.ts";

export interface RelayKey {
	id: number;
	key: string;
	group_id: number;
	group_name: string;
	platform: string;
	rate_multiplier?: number;
	api: string;
	base_url: string;
}

export interface RelayUser {
	id: number;
	email?: string;
	username?: string;
	balance?: number;
	frozen_balance?: number;
	concurrency?: number;
	status?: string;
	total_recharged?: number;
}

export interface Account {
	token: string;
	deviceId: string;
	user: RelayUser;
	keys: RelayKey[];
	loggedInAt: number;
	balanceAt?: number;
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

export interface ClientConfig {
	site: string;
	register_url: string;
	redeem_url: string;
	doc_url: string;
	shop_url: string;
	repo: string;
	announcement?: string;
	min_version?: string;
	recommended_model?: string;
}

export class BridgeError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body?: any,
	) {
		super(message);
	}
}

export function loadAccount(): Account | undefined {
	const a = readJson<Account | null>(ACCOUNT_FILE, null);
	return a && a.token && Array.isArray(a.keys) ? a : undefined;
}

export function saveAccount(a: Account) {
	writeJson(ACCOUNT_FILE, a);
}

export function clearAccount() {
	writeJson(ACCOUNT_FILE, null);
}

export function deviceId(): string {
	const s = loadState();
	if (s.deviceId && /^[a-f0-9]{8,32}$/.test(s.deviceId)) return s.deviceId;
	const id = randomBytes(6).toString("hex");
	patchState({ deviceId: id });
	return id;
}

export async function bridge<T = any>(
	path: string,
	opts: { method?: string; body?: unknown; token?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": `${BRAND.npmPackage}/${VERSION} (${platform()} ${arch()})`,
	};
	if (opts.body !== undefined) headers["Content-Type"] = "application/json";
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
	const signals = [AbortSignal.timeout(opts.timeoutMs ?? 15000)];
	if (opts.signal) signals.push(opts.signal);
	let res: Response;
	try {
		res = await fetch(bridgeUrl(path), {
			method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			signal: AbortSignal.any(signals),
		});
	} catch (err) {
		if (opts.signal?.aborted) throw err;
		throw new BridgeError(`无法连接 ${BRAND.server}：${(err as Error).message}`, 0);
	}
	let json: any;
	try {
		json = await res.json();
	} catch {
		throw new BridgeError(`服务器返回异常 (${res.status})`, res.status);
	}
	if (!res.ok || !json?.ok) throw new BridgeError(json?.error || `请求失败 (${res.status})`, res.status, json);
	return json.data as T;
}

export const getConfig = () => bridge<ClientConfig>("/api/config", { timeoutMs: 8000 });
export const getShop = () => bridge<Shop>("/api/shop");

export async function refreshMe(account: Account): Promise<RelayUser> {
	const data = await bridge<{ user: RelayUser }>("/api/me", { token: account.token, timeoutMs: 10000 });
	account.user = data.user;
	account.balanceAt = Date.now();
	saveAccount(account);
	return data.user;
}

export async function redeem(account: Account, code: string) {
	const data = await bridge<{ type: string; value: number; user: RelayUser }>("/api/redeem", {
		token: account.token,
		body: { code: code.trim() },
	});
	account.user = data.user;
	account.balanceAt = Date.now();
	saveAccount(account);
	return data;
}

export async function logout(account: Account | undefined) {
	if (account) await bridge("/api/logout", { token: account.token, body: {} }).catch(() => {});
	clearAccount();
}

export interface DeviceStart {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	interval: number;
	expires_in: number;
}

export function startDeviceLogin() {
	return bridge<DeviceStart>("/api/device/start", {
		body: {
			device_id: deviceId(),
			device_name: hostname().slice(0, 60),
			os: `${platform()} ${arch()}`,
			version: VERSION,
		},
	});
}

/** Poll until approved. Throws BridgeError on denial/expiry, AbortError on cancel. */
export async function waitForDeviceApproval(start: DeviceStart, signal?: AbortSignal): Promise<Account> {
	const deadline = Date.now() + start.expires_in * 1000;
	let interval = Math.max(2, start.interval) * 1000;
	while (Date.now() < deadline) {
		await sleep(interval, signal);
		try {
			const r = await bridge<any>("/api/device/poll", { body: { device_code: start.device_code }, signal });
			if (r.status === "approved") {
				const account: Account = {
					token: r.token,
					deviceId: r.device_id,
					user: r.user,
					keys: r.keys,
					loggedInAt: Date.now(),
					balanceAt: Date.now(),
				};
				saveAccount(account);
				return account;
			}
		} catch (err) {
			if (signal?.aborted) throw err;
			if (err instanceof BridgeError) {
				const st = err.body?.status;
				if (st === "slow_down") {
					interval += 1000;
					continue;
				}
				if (st === "denied") throw new BridgeError("授权请求被拒绝", 403);
				if (st === "expired") throw new BridgeError("授权码已过期，请重新登录", 410);
				if (err.status === 0) continue; // transient network error
			}
			throw err;
		}
	}
	throw new BridgeError("授权码已过期，请重新登录", 410);
}

function sleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

export const fmtMoney = (v: number | undefined) => (typeof v === "number" ? `$${v.toFixed(2)}` : "-");
export const userLabel = (u: RelayUser) => u.email || u.username || `#${u.id}`;

export function openUrl(url: string): boolean {
	if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
	try {
		const [cmd, args] =
			process.platform === "darwin"
				? ["open", [url]]
				: process.platform === "win32"
					? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
					: ["xdg-open", [url]];
		const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
