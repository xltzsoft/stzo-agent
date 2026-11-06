#!/usr/bin/env node
// Prepare the bundled runtime for the desktop app:
//   src-tauri/binaries/node-<target-triple>[.exe]   official Node.js binary (verified against SHASUMS256)
//   src-tauri/app/                                  the stzo CLI + production node_modules
//
// Usage: node scripts/prepare-sidecar.mjs [--target <rust-triple>] [--skip-app] [--skip-node]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = process.env.STZO_NODE_VERSION || "24.22.2";
const MIRRORS = ["https://nodejs.org/dist", "https://npmmirror.com/mirrors/node"];

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const root = resolve(desktop, "..");
const tauriDir = join(desktop, "src-tauri");
const cache = join(desktop, ".cache");
mkdirSync(cache, { recursive: true });

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
	const i = argv.indexOf(n);
	return i >= 0 ? argv[i + 1] : undefined;
};
const win = process.platform === "win32";
const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { stdio: "inherit", shell: win, ...o });
// On Windows, Git Bash puts GNU tar first on PATH, which treats "D:\\..." as a remote host.
// The system bsdtar handles both zip and tgz with drive-letter paths.
const TAR = win ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";

function hostTriple() {
	const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
	return /host: (\S+)/.exec(out)[1];
}
const target = opt("--target") || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();

const NODE_PLATFORM = {
	"aarch64-apple-darwin": ["darwin-arm64", "tar.gz"],
	"x86_64-apple-darwin": ["darwin-x64", "tar.gz"],
	"x86_64-pc-windows-msvc": ["win-x64", "zip"],
	"aarch64-pc-windows-msvc": ["win-arm64", "zip"],
	"x86_64-unknown-linux-gnu": ["linux-x64", "tar.gz"],
	"aarch64-unknown-linux-gnu": ["linux-arm64", "tar.gz"],
};

async function fetchBuf(path) {
	let last;
	for (const m of MIRRORS) {
		try {
			const res = await fetch(`${m}/${path}`, { redirect: "follow" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return Buffer.from(await res.arrayBuffer());
		} catch (err) {
			last = new Error(`${m}/${path}: ${err.message}`);
			console.warn(`  ${last.message}, trying next mirror`);
		}
	}
	throw last;
}

async function prepareNode() {
	const spec = NODE_PLATFORM[target];
	if (!spec) throw new Error(`unsupported target ${target}`);
	const [plat, ext] = spec;
	const base = `node-v${NODE_VERSION}-${plat}`;
	const file = `${base}.${ext}`;
	const exe = target.includes("windows") ? ".exe" : "";
	const out = join(tauriDir, "binaries", `node-${target}${exe}`);
	const stamp = `${out}.version`;
	if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf8") === `${NODE_VERSION}/${plat}`) {
		console.log(`node ${NODE_VERSION} (${plat}) already prepared`);
		return;
	}
	const archive = join(cache, file);
	if (!existsSync(archive)) {
		console.log(`downloading ${file}`);
		const sums = (await fetchBuf(`v${NODE_VERSION}/SHASUMS256.txt`)).toString("utf8");
		const expected = sums.split("\n").find((l) => l.endsWith(`  ${file}`))?.split(" ")[0];
		if (!expected) throw new Error(`no checksum for ${file}`);
		const buf = await fetchBuf(`v${NODE_VERSION}/${file}`);
		const got = createHash("sha256").update(buf).digest("hex");
		if (got !== expected) throw new Error(`checksum mismatch for ${file}`);
		writeFileSync(archive, buf);
	}
	const tmp = join(cache, `x-${plat}`);
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	// bsdtar (macOS, Windows 10+) also reads zip files.
	execFileSync(TAR, ["-xf", archive, "-C", tmp], { stdio: "inherit" });
	const src = exe ? join(tmp, base, "node.exe") : join(tmp, base, "bin", "node");
	mkdirSync(dirname(out), { recursive: true });
	copyFileSync(src, out);
	if (!exe) chmodSync(out, 0o755);
	writeFileSync(stamp, `${NODE_VERSION}/${plat}`);
	rmSync(tmp, { recursive: true, force: true });
	console.log(`node -> ${out}`);
}

function prune(dir, keepPlatform) {
	const drop = /\.(map|md|markdown|ts\.map|tsbuildinfo)$|^(CHANGELOG|HISTORY|AUTHORS|CONTRIBUTING)/i;
	const walk = (d) => {
		// pi reads its own README/docs/CHANGELOG/examples at runtime; leave those packages intact.
		if (/[\\/]@earendil-works$/.test(d)) return;
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) {
				if (["test", "tests", "__tests__", "example", "examples", "docs", ".github"].includes(name) && d.includes("node_modules")) {
					rmSync(p, { recursive: true, force: true });
					continue;
				}
				// Native prebuilds for other operating systems.
				if (/^(darwin|linux|win32)(-|$)/.test(name) && d.includes("prebuilds") && !name.startsWith(keepPlatform)) {
					rmSync(p, { recursive: true, force: true });
					continue;
				}
				walk(p);
			} else if (drop.test(name) && !/^readme/i.test(name) && name !== "LICENSE.md") {
				rmSync(p, { force: true });
			} else if (name.endsWith(".d.ts") || name.endsWith(".d.mts") || name.endsWith(".d.cts")) {
				rmSync(p, { force: true });
			}
		}
	};
	walk(dir);
	// Keep only this OS's native dir in pi-tui.
	const nativeDir = join(dir, "node_modules", "@earendil-works", "pi-tui", "native");
	if (existsSync(nativeDir)) {
		for (const name of readdirSync(nativeDir)) if (name !== keepPlatform) rmSync(join(nativeDir, name), { recursive: true, force: true });
	}
}

function prepareApp() {
	const app = join(tauriDir, "app");
	console.log("packing stzo CLI");
	const json = execFileSync("npm", ["pack", "--json", "--pack-destination", cache], { cwd: root, encoding: "utf8", shell: win, stdio: ["ignore", "pipe", "inherit"] });
	const tgz = join(cache, JSON.parse(json.slice(json.indexOf("[")))[0].filename);
	const tmp = join(cache, "app-x");
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	execFileSync(TAR, ["-xzf", tgz, "-C", tmp], { stdio: "inherit" });
	rmSync(app, { recursive: true, force: true });
	renameSync(join(tmp, "package"), app);
	rmSync(tmp, { recursive: true, force: true });
	rmSync(tgz, { force: true });
	// Reuse the root lockfile so the bundled deps match what CI tested.
	if (existsSync(join(root, "package-lock.json"))) copyFileSync(join(root, "package-lock.json"), join(app, "package-lock.json"));
	console.log("installing production dependencies");
	sh("npm", ["ci", "--omit=dev", "--no-bin-links", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: app });
	const plat = target.includes("apple") ? "darwin" : target.includes("windows") ? "win32" : "linux";
	prune(app, plat);
	rmSync(join(app, "package-lock.json"), { force: true });
	console.log(`app -> ${app}`);
}

if (!flag("--skip-node")) await prepareNode();
if (!flag("--skip-app")) prepareApp();
