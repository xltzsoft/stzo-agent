// Bump version, update CHANGELOG, commit, tag and push → GitHub Actions publishes the release.
//   node scripts/release.mjs patch|minor|major|<x.y.z> ["changelog line" ...]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const pkgUrl = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));
const [bump = "patch", ...notes] = process.argv.slice(2);

const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
if (status) {
	console.error("工作区有未提交改动，请先提交。");
	process.exit(1);
}

let [maj, min, pat] = pkg.version.split("-")[0].split(".").map(Number);
let next;
if (bump === "major") next = `${maj + 1}.0.0`;
else if (bump === "minor") next = `${maj}.${min + 1}.0`;
else if (bump === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(bump)) next = bump;
else {
	console.error("用法：node scripts/release.mjs patch|minor|major|<x.y.z> [说明…]");
	process.exit(1);
}

pkg.version = next;
writeFileSync(pkgUrl, `${JSON.stringify(pkg, null, "\t")}\n`);
const lockUrl = new URL("../package-lock.json", import.meta.url);
try {
	const lock = JSON.parse(readFileSync(lockUrl, "utf8"));
	lock.version = next;
	if (lock.packages?.[""]) lock.packages[""].version = next;
	writeFileSync(lockUrl, `${JSON.stringify(lock, null, "\t")}\n`);
} catch {}

// Desktop app versions follow the CLI (tauri.conf.json reads ../../package.json directly).
const deskPkgUrl = new URL("../desktop/package.json", import.meta.url);
try {
	const dp = JSON.parse(readFileSync(deskPkgUrl, "utf8"));
	dp.version = next;
	writeFileSync(deskPkgUrl, `${JSON.stringify(dp, null, "\t")}\n`);
	const cargoUrl = new URL("../desktop/src-tauri/Cargo.toml", import.meta.url);
	writeFileSync(cargoUrl, readFileSync(cargoUrl, "utf8").replace(/^version = ".*"$/m, `version = "${next}"`));
} catch {}

const clUrl = new URL("../CHANGELOG.md", import.meta.url);
let cl = "";
try {
	cl = readFileSync(clUrl, "utf8");
} catch {}
const date = new Date().toISOString().slice(0, 10);
const body = notes.length ? notes.map((n) => `- ${n}`).join("\n") : "- 维护更新";
const header = "# Changelog\n";
cl = cl.startsWith(header) ? cl.slice(header.length) : cl;
writeFileSync(clUrl, `${header}\n## v${next} (${date})\n\n${body}\n${cl.replace(/^\n+/, "\n")}`);

sh("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md", "desktop/package.json", "desktop/src-tauri/Cargo.toml"]);
sh("git", ["commit", "-m", `release: v${next}`]);
sh("git", ["tag", "-a", `v${next}`, "-m", `v${next}`]);
sh("git", ["push", "origin", "HEAD", `v${next}`]);
console.log(`\n已推送 v${next}，GitHub Actions 正在构建发布。命令行与桌面版客户端会在 6 小时内自动更新。`);
