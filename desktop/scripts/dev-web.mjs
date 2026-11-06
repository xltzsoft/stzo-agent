// Browser-only dev loop: mock relay (unless MOCK=0) + process bridge + vite on :1420.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
const kids = [];
const run = (cmd, args, extra = {}) => {
	const c = spawn(cmd, args, { cwd: desktop, stdio: "inherit", env, ...extra });
	kids.push(c);
	return c;
};
if (process.env.MOCK !== "0") {
	env.STZO_SERVER = "http://127.0.0.1:18790";
	env.STZO_HOME = env.STZO_HOME || "/tmp/stzo-mock";
	env.STZO_NO_UPDATE = "1";
	const demo = "/tmp/stzo-demo";
	if (!existsSync(join(demo, "README.md"))) {
		mkdirSync(join(demo, "src"), { recursive: true });
		writeFileSync(join(demo, "README.md"), "# Demo\n\nHello world\n");
		writeFileSync(join(demo, "src", "index.js"), "console.log('hi');\n");
	}
	run(process.execPath, ["scripts/mock-server.mjs"]);
}
run(process.execPath, ["scripts/dev-bridge.mjs"]);
run(process.execPath, [join(desktop, "node_modules", "vite", "bin", "vite.js")]);
const stop = () => {
	for (const k of kids) k.kill();
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
