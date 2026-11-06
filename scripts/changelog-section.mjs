// Print the CHANGELOG.md section for a version (used as GitHub release notes).
import { readFileSync } from "node:fs";

const version = process.argv[2];
let text = "";
try {
	text = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
} catch {}
const lines = text.split(/\r?\n/);
const start = lines.findIndex((l) => new RegExp(`^##\\s*\\[?v?${version.replace(/\./g, "\\.")}\\]?`).test(l));
let out = "";
if (start >= 0) {
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => /^##\s/.test(l));
	out = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}
console.log(out || `STZO Agent v${version}`);
