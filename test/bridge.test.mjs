// End-to-end test of the bridge server against a mock Sub2API, driven by the real client code.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const ADMIN = "admin-test";
const JWT = "user-jwt";
const state = {
	user: { id: 7, email: "u@example.com", username: "u", balance: 1.5, status: "active", concurrency: 2, total_recharged: 0 },
	keys: [],
	nextKey: 100,
	codes: [{ id: 1, code: "CDK-GOOD-1", type: "balance", value: 10, status: "unused", used_by: null }],
	createdCodes: [],
};

function mockSub2api(req, res) {
	const url = new URL(req.url, "http://x");
	const send = (data, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(status === 200 ? { code: 0, message: "success", data } : { code: status, message: data }));
	};
	const userAuth = req.headers.authorization === `Bearer ${JWT}`;
	const adminAuth = req.headers["x-api-key"] === ADMIN;
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const json = body ? JSON.parse(body) : {};
		const p = url.pathname;
		if (p.startsWith("/api/v1/admin/")) {
			if (!adminAuth) return send("unauthorized", 401);
			if (p === `/api/v1/admin/users/${state.user.id}`) return send(state.user);
			if (p === "/api/v1/admin/redeem-codes") {
				const q = url.searchParams.get("search") || "";
				return send({ items: state.codes.filter((c) => c.code.includes(q)), total: 1 });
			}
			if (p === "/api/v1/admin/redeem-codes/create-and-redeem" && req.method === "POST") {
				let c = state.codes.find((x) => x.code === json.code);
				if (!c) {
					c = { id: 99, code: json.code, type: json.type, value: json.value, status: "unused", used_by: null };
					state.codes.push(c);
					state.createdCodes.push(c);
				}
				if (c.status !== "unused") return send("used", 409);
				c.status = "used";
				c.used_by = json.user_id;
				if (c.type === "balance") state.user.balance += c.value;
				return send({ redeem_code: c });
			}
			return send("nf", 404);
		}
		if (!userAuth) return send("unauthorized", 401);
		if (p === "/api/v1/user/profile") return send(state.user);
		if (p === "/api/v1/groups/available")
			return send([
				{ id: 31, name: "Claude Plus", platform: "anthropic", rate_multiplier: 1 },
				{ id: 2, name: "ALL", platform: "openai", rate_multiplier: 1 },
			]);
		if (p === "/api/v1/keys" && req.method === "GET") return send({ items: state.keys, total: state.keys.length });
		if (p === "/api/v1/keys" && req.method === "POST") {
			const k = { id: state.nextKey++, key: `sk-test-${state.nextKey}`, name: json.name, group_id: json.group_id, status: "active" };
			state.keys.push(k);
			return send(k);
		}
		if (p.startsWith("/api/v1/keys/") && req.method === "DELETE") {
			state.keys = state.keys.filter((k) => String(k.id) !== p.split("/").pop());
			return send({});
		}
		return send("nf", 404);
	});
}

let mock;
let bridge;
let bridgePort;
let client;

before(async () => {
	mock = createServer(mockSub2api);
	await new Promise((r) => mock.listen(0, "127.0.0.1", r));
	bridgePort = 30000 + Math.floor(Math.random() * 20000);
	const data = mkdtempSync(join(tmpdir(), "stzo-bridge-"));
	bridge = spawn(process.execPath, ["server/server.mjs"], {
		env: {
			...process.env,
			STZO_ENV_FILE: "/nonexistent",
			PORT: String(bridgePort),
			SUB2API_URL: `http://127.0.0.1:${mock.address().port}`,
			SUB2API_ADMIN_KEY: ADMIN,
			PUBLIC_BASE: `http://127.0.0.1:${bridgePort}`,
			DATA_DIR: data,
			SHOP_API: "http://127.0.0.1:9", // unreachable → graceful fallback
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	await new Promise((resolve, reject) => {
		bridge.stdout.on("data", (d) => String(d).includes("listening") && resolve());
		bridge.on("exit", (c) => reject(new Error(`bridge exited ${c}`)));
	});
	process.env.STZO_SERVER = `http://127.0.0.1:${bridgePort}`;
	process.env.STZO_HOME = mkdtempSync(join(tmpdir(), "stzo-home-"));
	client = await import("../dist/account.js");
});

after(() => {
	bridge?.kill();
	mock?.close();
});

const api = (path, opts = {}) =>
	fetch(`http://127.0.0.1:${bridgePort}/agent${path}`, {
		...opts,
		headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
	}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

test("public endpoints", async () => {
	assert.equal((await api("/api/health")).body.ok, true);
	const cfg = (await api("/api/config")).body.data;
	assert.match(cfg.shop_url, /S670281/);
	const shop = (await api("/api/shop")).body;
	assert.equal(shop.ok, true);
	assert.deepEqual(shop.data.items, []);
	const page = await fetch(`http://127.0.0.1:${bridgePort}/agent/device`);
	assert.equal(page.status, 200);
	assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("device login, me, redeem, logout", async () => {
	const start = await client.startDeviceLogin();
	assert.match(start.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

	const look = await api(`/api/device/lookup?code=${start.user_code.toLowerCase().replace("-", "")}`);
	assert.equal(look.body.data.status, "pending");

	// Unauthenticated approval is rejected.
	const bad = await api("/api/device/approve", { method: "POST", body: JSON.stringify({ user_code: start.user_code }) });
	assert.equal(bad.status, 401);

	const waiting = client.waitForDeviceApproval({ ...start, interval: 2 });
	const ok = await api("/api/device/approve", {
		method: "POST",
		headers: { Authorization: `Bearer ${JWT}` },
		body: JSON.stringify({ user_code: start.user_code, group_ids: [31] }),
	});
	assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
	const account = await waiting;
	assert.equal(account.user.id, 7);
	assert.equal(account.keys.length, 1);
	assert.equal(account.keys[0].api, "anthropic-messages");
	assert.equal(account.keys[0].group_name, "Claude Plus");
	assert.ok(client.loadAccount(), "account saved to disk");

	// Second approval on the same flow is refused.
	const again = await api("/api/device/approve", {
		method: "POST",
		headers: { Authorization: `Bearer ${JWT}` },
		body: JSON.stringify({ user_code: start.user_code }),
	});
	assert.notEqual(again.status, 200);

	const me = await client.refreshMe(account);
	assert.equal(me.balance, 1.5);

	// Unknown code must NOT be created by create-and-redeem.
	await assert.rejects(client.redeem(account, "CDK-NOPE-0"), /不存在/);
	assert.equal(state.createdCodes.length, 0);

	const r = await client.redeem(account, "CDK-GOOD-1");
	assert.equal(r.user.balance, 11.5);
	await assert.rejects(client.redeem(account, "CDK-GOOD-1"), /兑换过/);

	// Re-login on the same device replaces the old key instead of piling up.
	const start2 = await client.startDeviceLogin();
	const w2 = client.waitForDeviceApproval({ ...start2, interval: 2 });
	await api("/api/device/approve", {
		method: "POST",
		headers: { Authorization: `Bearer ${JWT}` },
		body: JSON.stringify({ user_code: start2.user_code, group_ids: [31, 2] }),
	});
	const acc2 = await w2;
	assert.equal(acc2.keys.length, 2);
	assert.equal(state.keys.length, 2);

	await client.logout(acc2);
	assert.equal(client.loadAccount(), undefined);
	const after = await api("/api/me", { headers: { Authorization: `Bearer ${acc2.token}` } });
	assert.equal(after.status, 401);
});

test("denied flow reports denial", async () => {
	const start = await client.startDeviceLogin();
	const waiting = client.waitForDeviceApproval({ ...start, interval: 2 });
	await api("/api/device/deny", {
		method: "POST",
		headers: { Authorization: `Bearer ${JWT}` },
		body: JSON.stringify({ user_code: start.user_code }),
	});
	await assert.rejects(waiting, /拒绝/);
});
