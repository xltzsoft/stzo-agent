#!/usr/bin/env node
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	console.error(`STZO Agent 需要 Node.js >= 22.19（当前 ${process.versions.node}）。请先升级 Node.js：https://nodejs.org/`);
	process.exit(1);
}
const { run } = await import("../dist/cli.js");
await run(process.argv.slice(2));
