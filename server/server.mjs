#!/usr/bin/env node
// STZO Agent bridge server.
//
// Runs next to Sub2API (same origin through nginx, mounted at /agent/) and gives the
// stzo CLI what Sub2API alone cannot: a device-code login that works with Turnstile,
// in-CLI redemption of card-shop CDKs, live shop listings, a remote client config and
// a mirror of GitHub release assets for OTA updates.
//
// Zero dependencies; Node >= 18.

import { createHash, randomBytes, randomInt } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadEnvFile(path) {
	if (!path || !existsSync(path)) return;
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return; // e.g. root-only file already injected by systemd EnvironmentFile
	}
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
}
loadEnvFile(process.env.STZO_ENV_FILE || "/etc/stzo-agent/server.env");

const cfg = {
	host: process.env.HOST || "127.0.0.1",
	port: Number(process.env.PORT || 3090),
	mount: (process.env.MOUNT_PATH || "/agent").replace(/\/$/, ""),
	publicBase: (process.env.PUBLIC_BASE || "https://gc.stzo.cn").replace(/\/$/, ""),
	sub2api: (process.env.SUB2API_URL || "http://127.0.0.1:8080").replace(/\/$/, ""),
	adminKey: process.env.SUB2API_ADMIN_KEY || "",
	dataDir: process.env.DATA_DIR || join(HERE, ".data"),
	publicDir: process.env.PUBLIC_DIR || join(HERE, "public"),
	clientConfigFile: process.env.CLIENT_CONFIG_FILE || "",
	githubRepo: process.env.GITHUB_REPO || "xltzsoft/stzo-agent",
	githubToken: process.env.GITHUB_TOKEN || "",
	shopApi: (process.env.SHOP_API || "https://www.16688.com.cn").replace(/\/$/, ""),
	shopNo: process.env.SHOP_NO || "S670281",
	trustProxy: process.env.TRUST_PROXY !== "0",
	sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 180),
	keyPrefix: process.env.KEY_NAME_PREFIX || "stzo-agent",
};

if (!cfg.adminKey) {
	console.error("SUB2API_ADMIN_KEY is not set; refusing to start.");
	process.exit(1);
}
mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
mkdirSync(join(cfg.dataDir, "releases"), { recursive: true });

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------------------
// Tiny JSON store (sessions). Writes are atomic (tmp + rename).
// ---------------------------------------------------------------------------

class JsonStore {
	constructor(file, fallback) {
		this.file = file;
		this.data = fallback;
		if (existsSync(file)) {
			try {
				this.data = JSON.parse(readFileSync(file, "utf8"));
			} catch (err) {
				log("store: failed to read", file, err.message);
			}
		}
		this.timer = undefined;
	}
	save() {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), 200);
	}
	flush() {
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
		renameSync(tmp, this.file);
	}
}

const sessions = new JsonStore(join(cfg.dataDir, "sessions.json"), { v: 1, sessions: {} });
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function createSession(user, device) {
	const token = `stzo_${randomBytes(32).toString("base64url")}`;
	const now = Date.now();
	sessions.data.sessions[sha256(token)] = {
		userId: user.id,
		email: user.email,
		username: user.username,
		deviceId: device.deviceId,
		deviceName: device.deviceName,
		os: device.os,
		createdAt: now,
		lastSeenAt: now,
	};
	sessions.save();
	return token;
}

function getSession(req) {
	const auth = req.headers.authorization || "";
	const m = /^Bearer\s+(stzo_[A-Za-z0-9_-]{20,})$/.exec(auth);
	if (!m) return undefined;
	const hash = sha256(m[1]);
	const s = sessions.data.sessions[hash];
	if (!s) return undefined;
	const ttl = cfg.sessionTtlDays * 86400_000;
	if (Date.now() - s.lastSeenAt > ttl) {
		delete sessions.data.sessions[hash];
		sessions.save();
		return undefined;
	}
	if (Date.now() - s.lastSeenAt > 3600_000) {
		s.lastSeenAt = Date.now();
		sessions.save();
	}
	return { hash, ...s };
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, in memory)
// ---------------------------------------------------------------------------

const buckets = new Map();
function rateLimit(key, limit, windowMs) {
	const now = Date.now();
	let b = buckets.get(key);
	if (!b || now >= b.reset) {
		b = { count: 0, reset: now + windowMs };
		buckets.set(key, b);
	}
	b.count++;
	return b.count <= limit;
}
setInterval(() => {
	const now = Date.now();
	for (const [k, b] of buckets) if (now >= b.reset) buckets.delete(k);
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Sub2API client
// ---------------------------------------------------------------------------

class UpstreamError extends Error {
	constructor(status, message, code) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

async function s2a(path, { method = "GET", body, token, admin = false, headers = {}, timeoutMs = 15000 } = {}) {
	const h = { Accept: "application/json", ...headers };
	if (admin) h["x-api-key"] = cfg.adminKey;
	if (token) h.Authorization = `Bearer ${token}`;
	if (body !== undefined) h["Content-Type"] = "application/json";
	const res = await fetch(`${cfg.sub2api}${path}`, {
		method,
		headers: h,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	let json;
	try {
		json = await res.json();
	} catch {
		throw new UpstreamError(502, `Sub2API returned non-JSON (${res.status})`);
	}
	if (!res.ok || (json && typeof json.code === "number" && json.code !== 0)) {
		const msg = json?.message || json?.error || `Sub2API error ${res.status}`;
		throw new UpstreamError(res.status >= 400 ? res.status : 400, msg, json?.reason || json?.code);
	}
	return json?.data;
}

async function adminGetUser(userId) {
	return s2a(`/api/v1/admin/users/${encodeURIComponent(userId)}`, { admin: true });
}

function publicUser(u) {
	return {
		id: u.id,
		email: u.email,
		username: u.username,
		balance: u.balance,
		frozen_balance: u.frozen_balance,
		concurrency: u.concurrency,
		status: u.status,
		total_recharged: u.total_recharged,
	};
}

// ---------------------------------------------------------------------------
// Device-code login
// ---------------------------------------------------------------------------

// user_code alphabet avoids look-alike characters.
const UC_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
const DEVICE_TTL_MS = 10 * 60_000;
const devices = new Map(); // device_code -> flow
const byUserCode = new Map(); // user_code -> device_code

function newUserCode() {
	for (;;) {
		let s = "";
		for (let i = 0; i < 8; i++) s += UC_ALPHABET[randomInt(UC_ALPHABET.length)];
		const code = `${s.slice(0, 4)}-${s.slice(4)}`;
		if (!byUserCode.has(code)) return code;
	}
}

function normalizeUserCode(raw) {
	const s = String(raw || "")
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
	return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : "";
}

setInterval(() => {
	const now = Date.now();
	for (const [dc, f] of devices) {
		if (now > f.expiresAt + 60_000) {
			devices.delete(dc);
			byUserCode.delete(f.userCode);
		}
	}
}, 30_000).unref();

const cleanStr = (v, max = 80) =>
	String(v ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.slice(0, max);

function platformApi(platform) {
	switch (platform) {
		case "anthropic":
		case "kimi":
		case "glm":
			return { api: "anthropic-messages", baseUrl: cfg.publicBase };
		case "gemini":
			return { api: "google-generative-ai", baseUrl: `${cfg.publicBase}/v1beta` };
		default:
			return { api: "openai-completions", baseUrl: `${cfg.publicBase}/v1` };
	}
}

async function approveDevice(flow, userJwt, groupIds) {
	const user = await s2a("/api/v1/user/profile", { token: userJwt });
	if (!user?.id) throw new UpstreamError(401, "无法确认登录状态，请重新登录网站");
	if (user.status && user.status !== "active") throw new UpstreamError(403, "账号状态异常，无法授权");

	const available = (await s2a("/api/v1/groups/available", { token: userJwt })) || [];
	const allowed = new Map(available.map((g) => [Number(g.id), g]));
	let chosen = (Array.isArray(groupIds) ? groupIds : []).map(Number).filter((id) => allowed.has(id));
	if (chosen.length === 0) chosen = available.map((g) => Number(g.id));
	chosen = chosen.slice(0, 12);
	if (chosen.length === 0) throw new UpstreamError(400, "当前账号没有可用的分组，请联系管理员");

	// Remove keys this device created on a previous login so re-login does not pile up keys.
	const keyName = (gid) => `${cfg.keyPrefix}-${flow.deviceId}-g${gid}`;
	try {
		const page = await s2a(`/api/v1/keys?page=1&page_size=100&search=${encodeURIComponent(`${cfg.keyPrefix}-${flow.deviceId}`)}`, {
			token: userJwt,
		});
		for (const k of page?.items || []) {
			if (typeof k.name === "string" && k.name.startsWith(`${cfg.keyPrefix}-${flow.deviceId}-g`)) {
				await s2a(`/api/v1/keys/${k.id}`, { method: "DELETE", token: userJwt }).catch(() => {});
			}
		}
	} catch (err) {
		log("device: listing old keys failed:", err.message);
	}

	const keys = [];
	for (const gid of chosen) {
		const g = allowed.get(gid);
		const created = await s2a("/api/v1/keys", {
			method: "POST",
			token: userJwt,
			body: { name: keyName(gid), group_id: gid },
		});
		const { api, baseUrl } = platformApi(g.platform);
		keys.push({
			id: created.id,
			key: created.key,
			group_id: gid,
			group_name: g.name,
			platform: g.platform,
			rate_multiplier: g.rate_multiplier,
			api,
			base_url: baseUrl,
		});
	}
	flow.status = "approved";
	flow.user = user;
	flow.keys = keys;
	flow.token = createSession(user, flow);
	log(`device: approved ${flow.userCode} for user ${user.id} (${keys.length} keys)`);
}

// ---------------------------------------------------------------------------
// Redeem (card-shop CDK) on behalf of the logged-in user
// ---------------------------------------------------------------------------

async function redeemForUser(userId, rawCode) {
	const code = String(rawCode || "").trim();
	if (!/^[A-Za-z0-9_\-]{3,128}$/.test(code)) throw new UpstreamError(400, "兑换码格式不正确");

	// The admin create-and-redeem endpoint redeems an existing unused code atomically, but it
	// would CREATE a new code if none exists. Look the code up first and require an exact match.
	const page = await s2a(`/api/v1/admin/redeem-codes?page=1&page_size=20&search=${encodeURIComponent(code)}`, {
		admin: true,
	});
	const found = (page?.items || []).find((c) => c.code === code);
	if (!found) throw new UpstreamError(404, "兑换码不存在");
	if (found.status !== "unused") {
		if (found.used_by === userId) throw new UpstreamError(409, "该兑换码已被你兑换过");
		throw new UpstreamError(409, found.status === "expired" ? "兑换码已过期" : "兑换码已被使用");
	}

	const result = await s2a("/api/v1/admin/redeem-codes/create-and-redeem", {
		method: "POST",
		admin: true,
		headers: { "Idempotency-Key": `stzo-${userId}-${sha256(code).slice(0, 24)}` },
		body: {
			code,
			type: found.type || "balance",
			// Ignored for an existing code. Non-zero because the field is required.
			value: 0.000001,
			user_id: userId,
			notes: "stzo-agent redeem",
		},
	});
	const rc = result?.redeem_code || {};
	if (rc.used_by !== undefined && rc.used_by !== null && Number(rc.used_by) !== Number(userId)) {
		throw new UpstreamError(409, "兑换码已被其他用户使用");
	}
	return { type: rc.type || found.type, value: rc.value ?? found.value };
}

// ---------------------------------------------------------------------------
// Card shop (16688) listing, cached
// ---------------------------------------------------------------------------

let shopCache = { at: 0, data: null };
async function getShop() {
	if (shopCache.data && Date.now() - shopCache.at < 5 * 60_000) return shopCache.data;
	const post = async (path, body) => {
		const res = await fetch(`${cfg.shopApi}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 stzo-agent" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10000),
		});
		const json = await res.json();
		if (json.code !== 1) throw new Error(json.msg || "shop api error");
		return json.data;
	};
	const [detail, goods] = await Promise.all([
		post("/shopApi/shop/detail", { shop_no: cfg.shopNo }),
		post("/shopApi/goods/list", { shop_no: cfg.shopNo, page: 1, page_size: 50 }),
	]);
	const data = {
		name: detail?.name,
		url: `${cfg.shopApi}/shop/${cfg.shopNo}`,
		contact_qq: detail?.contact_qq || "",
		items: (goods?.list || []).map((g) => ({
			goods_no: g.goods_no,
			name: g.name,
			price: g.price,
			stock: g.stock_available_quantity,
			stock_status: g.stock_available_status,
			url: `${cfg.shopApi}/goods/${g.goods_no}?shop_no=${cfg.shopNo}`,
		})),
	};
	shopCache = { at: Date.now(), data };
	return data;
}

// ---------------------------------------------------------------------------
// Remote client config
// ---------------------------------------------------------------------------

function clientConfig() {
	let extra = {};
	if (cfg.clientConfigFile && existsSync(cfg.clientConfigFile)) {
		try {
			extra = JSON.parse(readFileSync(cfg.clientConfigFile, "utf8"));
		} catch (err) {
			log("config: bad CLIENT_CONFIG_FILE:", err.message);
		}
	}
	return {
		site: cfg.publicBase,
		register_url: `${cfg.publicBase}/register`,
		redeem_url: `${cfg.publicBase}/redeem`,
		doc_url: `${cfg.publicBase}/docs/`,
		shop_url: `${cfg.shopApi}/shop/${cfg.shopNo}`,
		repo: cfg.githubRepo,
		announcement: "",
		min_version: "",
		...extra,
	};
}

// ---------------------------------------------------------------------------
// OTA: GitHub latest release + asset mirror
// ---------------------------------------------------------------------------

let releaseCache = { at: 0, data: null };
const SAFE_ASSET = /^[A-Za-z0-9._-]{1,120}$/;

async function gh(path) {
	const headers = { Accept: "application/vnd.github+json", "User-Agent": "stzo-agent-bridge" };
	if (cfg.githubToken) headers.Authorization = `Bearer ${cfg.githubToken}`;
	const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(15000) });
	if (!res.ok) throw new Error(`GitHub ${res.status}`);
	return res.json();
}

async function getLatestRelease() {
	if (releaseCache.data && Date.now() - releaseCache.at < 10 * 60_000) return releaseCache.data;
	const rel = await gh(`/repos/${cfg.githubRepo}/releases/latest`);
	const assets = (rel.assets || []).filter((a) => SAFE_ASSET.test(a.name));
	let manifest = null;
	const manifestAsset = assets.find((a) => a.name === "latest.json");
	if (manifestAsset) {
		try {
			const res = await fetch(manifestAsset.browser_download_url, { signal: AbortSignal.timeout(15000) });
			if (res.ok) manifest = await res.json();
		} catch (err) {
			log("ota: manifest fetch failed:", err.message);
		}
	}
	const version = String(manifest?.version || rel.tag_name || "").replace(/^v/, "");
	const data = {
		version,
		tag: rel.tag_name,
		name: rel.name,
		notes: rel.body || "",
		published_at: rel.published_at,
		html_url: rel.html_url,
		tarball: manifest?.tarball,
		sha256: manifest?.sha256,
		assets: assets.map((a) => ({
			name: a.name,
			size: a.size,
			github_url: a.browser_download_url,
			mirror_url: `${cfg.publicBase}${cfg.mount}/dl/${rel.tag_name}/${a.name}`,
		})),
	};
	releaseCache = { at: Date.now(), data };
	return data;
}

const inflightDownloads = new Map();
async function mirrorAsset(tag, name) {
	if (!/^v?[0-9A-Za-z._-]{1,40}$/.test(tag) || !SAFE_ASSET.test(name)) return undefined;
	const dir = join(cfg.dataDir, "releases", tag);
	const file = join(dir, name);
	if (existsSync(file)) return file;
	const key = `${tag}/${name}`;
	if (inflightDownloads.has(key)) return inflightDownloads.get(key);
	const p = (async () => {
		const rel = await gh(`/repos/${cfg.githubRepo}/releases/tags/${encodeURIComponent(tag)}`);
		const asset = (rel.assets || []).find((a) => a.name === name);
		if (!asset) return undefined;
		if (asset.size > 200 * 1024 * 1024) throw new Error("asset too large");
		const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(300_000) });
		if (!res.ok) throw new Error(`download ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());
		mkdirSync(dir, { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, buf);
		renameSync(tmp, file);
		log(`ota: mirrored ${key} (${buf.length} bytes)`);
		return file;
	})().finally(() => inflightDownloads.delete(key));
	inflightDownloads.set(key, p);
	return p;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function clientIp(req) {
	if (cfg.trustProxy) {
		const real = req.headers["x-real-ip"];
		if (typeof real === "string" && real) return real;
		const fwd = req.headers["x-forwarded-for"];
		if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
	}
	return req.socket.remoteAddress || "?";
}

function send(res, status, body, headers = {}) {
	const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": typeof body === "string" || Buffer.isBuffer(body) ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		...headers,
	});
	res.end(payload);
}
const ok = (res, data) => send(res, 200, { ok: true, data });
const fail = (res, status, message, extra = {}) => send(res, status, { ok: false, error: message, ...extra });

async function readJson(req, limit = 16 * 1024) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new UpstreamError(413, "请求体过大");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new UpstreamError(400, "JSON 格式错误");
	}
}

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".sh": "text/x-shellscript; charset=utf-8",
	".ps1": "text/plain; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".tgz": "application/gzip",
	".txt": "text/plain; charset=utf-8",
};

function serveFile(req, res, file, { cache = "no-cache", download = false } = {}) {
	let st;
	try {
		st = statSync(file);
	} catch {
		return fail(res, 404, "not found");
	}
	if (!st.isFile()) return fail(res, 404, "not found");
	const ext = file.slice(file.lastIndexOf("."));
	const headers = {
		"Content-Type": MIME[ext] || "application/octet-stream",
		"Content-Length": st.size,
		"Cache-Control": cache,
		"X-Content-Type-Options": "nosniff",
	};
	if (ext === ".html") {
		headers["Content-Security-Policy"] =
			"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
		headers["Referrer-Policy"] = "no-referrer";
	}
	if (download) headers["Content-Disposition"] = `attachment; filename="${file.split("/").pop()}"`;
	res.writeHead(200, headers);
	if (req.method === "HEAD") return res.end();
	createReadStream(file).pipe(res);
}

const PUBLIC_FILES = {
	"/": "index.html",
	"/device": "device.html",
	"/install.sh": "install.sh",
	"/install.ps1": "install.ps1",
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function route(req, res) {
	const url = new URL(req.url, "http://localhost");
	let path = url.pathname;
	if (path === cfg.mount) path = `${cfg.mount}/`;
	if (!path.startsWith(`${cfg.mount}/`)) return fail(res, 404, "not found");
	path = path.slice(cfg.mount.length);
	const ip = clientIp(req);
	const m = req.method;

	if ((m === "GET" || m === "HEAD") && PUBLIC_FILES[path]) {
		return serveFile(req, res, join(cfg.publicDir, PUBLIC_FILES[path]));
	}

	if (m === "GET" && path === "/api/health") return ok(res, { status: "ok", time: Date.now() });

	if (m === "GET" && path === "/api/config") return ok(res, clientConfig());

	if (m === "POST" && path === "/api/device/start") {
		if (!rateLimit(`dstart:${ip}`, 20, 10 * 60_000)) return fail(res, 429, "请求过于频繁，请稍后再试");
		const body = await readJson(req);
		const deviceCode = randomBytes(32).toString("base64url");
		const userCode = newUserCode();
		const deviceId = /^[a-f0-9]{8,32}$/.test(String(body.device_id || ""))
			? String(body.device_id)
			: randomBytes(6).toString("hex");
		const flow = {
			deviceCode,
			userCode,
			deviceId,
			deviceName: cleanStr(body.device_name) || "未命名设备",
			os: cleanStr(body.os, 40),
			version: cleanStr(body.version, 24),
			ip,
			status: "pending",
			expiresAt: Date.now() + DEVICE_TTL_MS,
			lastPoll: 0,
		};
		devices.set(deviceCode, flow);
		byUserCode.set(userCode, deviceCode);
		const verification = `${cfg.publicBase}${cfg.mount}/device`;
		return ok(res, {
			device_code: deviceCode,
			user_code: userCode,
			verification_uri: verification,
			verification_uri_complete: `${verification}?code=${userCode}`,
			interval: 3,
			expires_in: DEVICE_TTL_MS / 1000,
		});
	}

	if (m === "GET" && path === "/api/device/lookup") {
		if (!rateLimit(`dlookup:${ip}`, 60, 10 * 60_000)) return fail(res, 429, "请求过于频繁");
		const uc = normalizeUserCode(url.searchParams.get("code"));
		const flow = uc && devices.get(byUserCode.get(uc));
		if (!flow || Date.now() > flow.expiresAt) return fail(res, 404, "授权码无效或已过期，请在终端重新执行 /login");
		return ok(res, {
			user_code: flow.userCode,
			device_name: flow.deviceName,
			os: flow.os,
			version: flow.version,
			status: flow.status,
			expires_in: Math.max(0, Math.round((flow.expiresAt - Date.now()) / 1000)),
		});
	}

	if (m === "POST" && (path === "/api/device/approve" || path === "/api/device/deny")) {
		if (!rateLimit(`dapprove:${ip}`, 30, 10 * 60_000)) return fail(res, 429, "请求过于频繁");
		const jwt = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || "")?.[1];
		if (!jwt) return fail(res, 401, "请先登录网站");
		const body = await readJson(req);
		const uc = normalizeUserCode(body.user_code);
		const flow = uc && devices.get(byUserCode.get(uc));
		if (!flow || Date.now() > flow.expiresAt) return fail(res, 404, "授权码无效或已过期");
		if (flow.status !== "pending") return fail(res, 409, "该授权请求已处理");
		if (path === "/api/device/deny") {
			// Require a valid site login to deny as well, so strangers cannot cancel flows.
			await s2a("/api/v1/user/profile", { token: jwt });
			flow.status = "denied";
			return ok(res, { status: "denied" });
		}
		flow.status = "approving";
		try {
			await approveDevice(flow, jwt, body.group_ids);
		} catch (err) {
			flow.status = "pending";
			throw err;
		}
		return ok(res, { status: "approved", keys: flow.keys.map((k) => ({ group_name: k.group_name, platform: k.platform })) });
	}

	if (m === "POST" && path === "/api/device/poll") {
		const body = await readJson(req);
		const flow = devices.get(String(body.device_code || ""));
		if (!flow) return fail(res, 404, "expired_token", { status: "expired" });
		if (Date.now() - flow.lastPoll < 1500) return fail(res, 429, "slow_down", { status: "slow_down" });
		flow.lastPoll = Date.now();
		if (Date.now() > flow.expiresAt && flow.status !== "approved") return fail(res, 410, "expired_token", { status: "expired" });
		if (flow.status === "denied") {
			devices.delete(flow.deviceCode);
			byUserCode.delete(flow.userCode);
			return fail(res, 403, "access_denied", { status: "denied" });
		}
		if (flow.status !== "approved") return ok(res, { status: "pending" });
		// Hand over once, then forget the plaintext keys.
		devices.delete(flow.deviceCode);
		byUserCode.delete(flow.userCode);
		return ok(res, {
			status: "approved",
			token: flow.token,
			device_id: flow.deviceId,
			user: publicUser(flow.user),
			keys: flow.keys,
		});
	}

	if (m === "GET" && path === "/api/shop") {
		try {
			return ok(res, await getShop());
		} catch (err) {
			log("shop:", err.message);
			return ok(res, { name: "", url: `${cfg.shopApi}/shop/${cfg.shopNo}`, items: [], error: "商品列表暂时不可用" });
		}
	}

	if (m === "GET" && path === "/api/update/latest") {
		try {
			return ok(res, await getLatestRelease());
		} catch (err) {
			log("ota:", err.message);
			return fail(res, 502, "暂时无法获取最新版本");
		}
	}

	if ((m === "GET" || m === "HEAD") && path.startsWith("/dl/")) {
		const [, , tag, name] = path.split("/");
		try {
			const file = await mirrorAsset(decodeURIComponent(tag || ""), decodeURIComponent(name || ""));
			if (!file) return fail(res, 404, "not found");
			return serveFile(req, res, file, { cache: "public, max-age=31536000, immutable", download: true });
		} catch (err) {
			log("dl:", err.message);
			return fail(res, 502, "镜像下载失败，请改用 GitHub 地址");
		}
	}

	// ---- authenticated (stzo session) ----
	if (path.startsWith("/api/")) {
		const s = getSession(req);
		if (!s) return fail(res, 401, "未登录或登录已过期，请执行 /login");

		if (m === "GET" && path === "/api/me") {
			const u = await adminGetUser(s.userId);
			return ok(res, { user: publicUser(u), device: { id: s.deviceId, name: s.deviceName } });
		}

		if (m === "POST" && path === "/api/redeem") {
			if (!rateLimit(`redeem:u${s.userId}`, 10, 60 * 60_000) || !rateLimit(`redeem:${ip}`, 20, 60 * 60_000)) {
				return fail(res, 429, "兑换尝试过于频繁，请一小时后再试");
			}
			const body = await readJson(req);
			const r = await redeemForUser(s.userId, body.code);
			const u = await adminGetUser(s.userId);
			log(`redeem: user ${s.userId} type=${r.type} value=${r.value}`);
			return ok(res, { ...r, user: publicUser(u) });
		}

		if (m === "GET" && path === "/api/balance-history") {
			const data = await s2a(`/api/v1/admin/users/${s.userId}/balance-history?page=1&page_size=20`, { admin: true });
			return ok(res, data);
		}

		if (m === "POST" && path === "/api/logout") {
			delete sessions.data.sessions[s.hash];
			sessions.save();
			return ok(res, { status: "logged_out" });
		}
	}

	return fail(res, 404, "not found");
}

const server = createServer(async (req, res) => {
	const started = Date.now();
	try {
		await route(req, res);
	} catch (err) {
		if (err instanceof UpstreamError) {
			const status = err.status === 401 ? 401 : err.status >= 400 && err.status < 600 ? err.status : 502;
			if (!res.headersSent) fail(res, status, err.message);
		} else {
			log("error:", req.method, req.url?.split("?")[0], err?.stack || err);
			if (!res.headersSent) fail(res, 500, "服务器内部错误");
		}
	} finally {
		const ms = Date.now() - started;
		if (!req.url?.includes("/device/poll")) log(req.method, req.url?.split("?")[0], res.statusCode, `${ms}ms`);
	}
});

server.listen(cfg.port, cfg.host, () => log(`stzo-agent bridge listening on http://${cfg.host}:${cfg.port}${cfg.mount}/`));

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		try {
			sessions.flush();
		} catch {}
		process.exit(0);
	});
}
