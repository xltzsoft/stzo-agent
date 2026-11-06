// Dev/test mock of the STZO bridge + an Anthropic-compatible relay, so the desktop UI can be
// exercised end to end without a real account or real model spend.
//   node scripts/mock-server.mjs            (port 18790)
//   STZO_SERVER=http://127.0.0.1:18790 STZO_HOME=/tmp/stzo-mock ...
// The scripted model: thinks, lists files, reads + edits README.md, then answers in markdown.
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT || 18790);
const BASE = `http://127.0.0.1:${PORT}`;
const user = { id: 7, email: "demo@stzo.cn", username: "demo", balance: 12.48, total_recharged: 30 };
const keys = [
	{ id: 1, key: "sk-mock-30", group_id: 30, group_name: "Claude Max", platform: "anthropic", rate_multiplier: 2, api: "anthropic-messages", base_url: BASE },
	{ id: 2, key: "sk-mock-31", group_id: 31, group_name: "Claude Plus", platform: "anthropic", rate_multiplier: 1, api: "anthropic-messages", base_url: BASE },
];
let approveAt = 0;

const readBody = (req) =>
	new Promise((ok) => {
		let b = "";
		req.on("data", (c) => (b += c));
		req.on("end", () => ok(b ? JSON.parse(b) : {}));
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunks(text, n = 6) {
	const out = [];
	for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
	return out;
}

async function stream(res, blocks, stop) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	ev("message_start", { message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, usage: { input_tokens: 1800, output_tokens: 1 } } });
	for (const [index, b] of blocks.entries()) {
		if (b.type === "thinking") {
			ev("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
			for (const c of chunks(b.text, 8)) {
				ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: c } });
				await sleep(18);
			}
			ev("content_block_delta", { index, delta: { type: "signature_delta", signature: "mock" } });
		} else if (b.type === "text") {
			ev("content_block_start", { index, content_block: { type: "text", text: "" } });
			for (const c of chunks(b.text)) {
				ev("content_block_delta", { index, delta: { type: "text_delta", text: c } });
				await sleep(16);
			}
		} else {
			ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
			for (const c of chunks(JSON.stringify(b.input), 12)) {
				ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: c } });
				await sleep(12);
			}
		}
		ev("content_block_stop", { index });
	}
	ev("message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: 240 } });
	ev("message_stop", {});
	res.end();
}

function script(messages) {
	// Count assistant turns since the last plain user prompt.
	let turns = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const plain = m.role === "user" && (typeof m.content === "string" || m.content.some((b) => b.type === "text"));
		if (plain && !m.content.some?.((b) => b.type === "tool_result")) break;
		if (m.role === "assistant") turns++;
	}
	const last = messages[messages.length - 1];
	const prompt = typeof last.content === "string" ? last.content : (last.content.find((b) => b.type === "text")?.text ?? "");
	if (/余额|balance/.test(prompt) && turns === 0) return { error: 402 };
	if (turns === 0)
		return {
			blocks: [
				{ type: "thinking", text: "用户想了解项目并修正 README。先列出目录，确认文件结构，再读取 README.md。" },
				{ type: "text", text: "我先看一下项目里有哪些文件。" },
				{ type: "tool_use", id: "toolu_ls", name: "bash", input: { command: "ls -la" } },
			],
			stop: "tool_use",
		};
	if (turns === 1)
		return {
			blocks: [
				{ type: "tool_use", id: "toolu_read", name: "read", input: { path: "README.md" } },
				{ type: "tool_use", id: "toolu_edit", name: "edit", input: { path: "README.md", edits: [{ oldText: "Hello world", newText: "Hello, STZO.\n\nThis project is maintained with STZO Agent." }] } },
			],
			stop: "tool_use",
		};
	return {
		blocks: [
			{
				type: "text",
				text: [
					"README 已更新。改动如下：",
					"",
					"| 文件 | 变更 |",
					"|---|---|",
					"| `README.md` | 替换问候语，补充一行说明 |",
					"",
					"如果要在本地预览，可以运行：",
					"",
					"```bash",
					"npx serve .",
					"```",
					"",
					"接下来可以**为项目补充测试**，或者让我检查其余文件。",
				].join("\n"),
			},
		],
		stop: "end_turn",
	};
}

createServer(async (req, res) => {
	const json = (status, obj) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(obj));
	};
	const url = new URL(req.url, BASE);
	const p = url.pathname;
	const body = req.method === "POST" ? await readBody(req) : {};
	if (p === "/agent/api/me") return json(200, { ok: true, data: { user } });
	if (p === "/agent/api/config")
		return json(200, { ok: true, data: { site: BASE, register_url: `${BASE}/register`, redeem_url: "", doc_url: "", shop_url: "", repo: "xltzsoft/stzo-agent", recommended_model: "claude-sonnet-4-6" } });
	if (p === "/agent/api/shop")
		return json(200, {
			ok: true,
			data: {
				name: "have-a.party",
				url: "https://www.16688.com.cn/shop/S670281",
				contact_qq: "3126443745",
				items: [
					{ goods_no: "G30484476", name: "10$ CDK", price: 10, stock: 96, url: "https://www.16688.com.cn/goods/G30484476?shop_no=S670281" },
					{ goods_no: "G48942553", name: "100$ CDK", price: 100, stock: 97, url: "https://www.16688.com.cn/goods/G48942553?shop_no=S670281" },
				],
			},
		});
	if (p === "/agent/api/redeem") {
		if (body.code !== "TEST-CODE") return json(400, { ok: false, error: "兑换码无效或已被使用" });
		user.balance += 10;
		return json(200, { ok: true, data: { type: "balance", value: 10, user } });
	}
	if (p === "/agent/api/logout") return json(200, { ok: true, data: {} });
	if (p === "/agent/api/device/start") {
		approveAt = Date.now() + 4000;
		return json(200, { ok: true, data: { device_code: "dev", user_code: "QX7M-K2PD", verification_uri: `${BASE}/device`, verification_uri_complete: `${BASE}/device?code=QX7M-K2PD`, interval: 2, expires_in: 600 } });
	}
	if (p === "/agent/api/device/poll") {
		if (Date.now() < approveAt) return json(200, { ok: true, data: { status: "pending" } });
		return json(200, { ok: true, data: { status: "approved", token: "stzo_mock", device_id: "mock", user, keys } });
	}
	if (p === "/v1/models") return json(200, { data: [{ id: "claude-sonnet-4-6" }, { id: "claude-opus-4-6" }, { id: "claude-haiku-4-5" }] });
	if (p === "/v1/messages") {
		const s = script(body.messages);
		if (s.error) return json(402, { type: "error", error: { type: "insufficient_balance", message: "Insufficient balance" } });
		return stream(res, s.blocks, s.stop);
	}
	json(404, { ok: false, error: `mock: ${p}` });
}).listen(PORT, "127.0.0.1", () => console.log(`mock relay on ${BASE}`));
