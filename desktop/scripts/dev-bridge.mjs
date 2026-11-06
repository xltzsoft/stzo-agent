// Dev-only stand-in for the Rust process commands, so the UI can run in a normal browser:
//   vite (port 1420) proxies /__bridge/* here. Never shipped.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.BRIDGE_PORT || 1421);
const cli = process.env.STZO_CLI || resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/stzo.js");
const node = process.env.STZO_NODE || process.execPath;
const procs = new Map();
const clients = new Set();
let next = 0;

const send = (ev) => {
	const data = `data: ${JSON.stringify(ev)}\n\n`;
	for (const c of clients) c.write(data);
};

function lines(stream, id, kind) {
	let buf = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buf += chunk;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			let line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			send({ kind, id, line });
		}
	});
}

const readBody = (req) =>
	new Promise((ok) => {
		let b = "";
		req.on("data", (c) => (b += c));
		req.on("end", () => ok(b ? JSON.parse(b) : {}));
	});

createServer(async (req, res) => {
	const json = (status, obj) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(obj));
	};
	const url = req.url.replace(/^\/__bridge/, "");
	if (url === "/events") {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(": ok\n\n");
		clients.add(res);
		req.on("close", () => clients.delete(res));
		return;
	}
	const body = await readBody(req);
	try {
		if (url === "/env") return json(200, { platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", home: homedir(), cli, node, dev: true });
		if (url === "/spawn") {
			const id = ++next;
			const child = spawn(node, ["--no-warnings", cli, ...body.args], {
				cwd: body.cwd || homedir(),
				env: { ...process.env, STZO_DESKTOP: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			procs.set(id, child);
			lines(child.stdout, id, "stdout");
			lines(child.stderr, id, "stderr");
			child.on("close", (code) => {
				procs.delete(id);
				setTimeout(() => send({ kind: "exit", id, code }), 30);
			});
			child.on("error", (err) => send({ kind: "stderr", id, line: String(err) }));
			return json(200, { id });
		}
		if (url === "/write") {
			const p = procs.get(body.id);
			if (!p) return json(400, { error: "进程已退出" });
			p.stdin.write(body.line.endsWith("\n") ? body.line : `${body.line}\n`);
			return json(200, {});
		}
		if (url === "/kill") {
			const p = procs.get(body.id);
			if (p) {
				p.stdin.end();
				setTimeout(() => p.exitCode === null && p.kill(), body.graceMs || 0);
			}
			return json(200, {});
		}
		json(404, { error: "not found" });
	} catch (err) {
		json(500, { error: String(err) });
	}
}).listen(PORT, "127.0.0.1", () => console.log(`dev bridge on :${PORT} (cli ${cli})`));

process.on("SIGTERM", () => {
	for (const p of procs.values()) p.kill();
	process.exit(0);
});
