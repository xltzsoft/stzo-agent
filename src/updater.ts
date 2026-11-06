import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { BRAND, HOME, PACKAGE_ROOT, VERSION, bridgeUrl, compareVersions, ensureDir, loadState, patchState } from "./brand.ts";

export interface ReleaseInfo {
	version: string;
	tag: string;
	notes: string;
	html_url?: string;
	tarball?: string;
	sha256?: string;
	assets: { name: string; github_url: string; mirror_url?: string; size?: number }[];
	source: "mirror" | "github";
}

const CHECK_INTERVAL_MS = 6 * 3600_000;

async function getJson(url: string, timeoutMs = 10000): Promise<any> {
	const res = await fetch(url, {
		headers: { Accept: "application/json", "User-Agent": `${BRAND.npmPackage}/${VERSION}` },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/** Latest release: bridge mirror first (fast in mainland China), GitHub API as fallback. */
export async function fetchLatestRelease(): Promise<ReleaseInfo> {
	try {
		const j = await getJson(bridgeUrl("/api/update/latest"), 8000);
		if (j?.ok && j.data?.version) return { ...j.data, source: "mirror" };
	} catch {}
	const rel = await getJson(`https://api.github.com/repos/${BRAND.repo}/releases/latest`, 12000);
	const assets = (rel.assets || []).map((a: any) => ({ name: a.name, github_url: a.browser_download_url, size: a.size }));
	let manifest: any = {};
	const m = assets.find((a: any) => a.name === "latest.json");
	if (m) manifest = await getJson(m.github_url, 12000).catch(() => ({}));
	return {
		version: String(manifest.version || rel.tag_name || "").replace(/^v/, ""),
		tag: rel.tag_name,
		notes: rel.body || "",
		html_url: rel.html_url,
		tarball: manifest.tarball,
		sha256: manifest.sha256,
		assets,
		source: "github",
	};
}

export function isNewer(rel: ReleaseInfo) {
	return !!rel.version && compareVersions(rel.version, VERSION) > 0;
}

export function shouldCheck(force = false) {
	if (force) return true;
	if (process.env.STZO_NO_UPDATE === "1" || process.env.PI_OFFLINE === "1") return false;
	return Date.now() - (loadState().lastUpdateCheck ?? 0) > CHECK_INTERVAL_MS;
}

/** Where npm installed us. Undefined for a git checkout / dev run, where self-update is skipped. */
export function installPrefix(): string | undefined {
	const marker = `${sep}node_modules${sep}${BRAND.npmPackage}`;
	if (!PACKAGE_ROOT.endsWith(marker)) return undefined;
	const nodeModules = dirname(PACKAGE_ROOT);
	// unix: <prefix>/lib/node_modules ; windows: <prefix>/node_modules
	return process.platform === "win32" ? dirname(nodeModules) : dirname(dirname(nodeModules));
}

function npmCommand(): { cmd: string; shell: boolean } {
	if (process.platform === "win32") {
		const local = join(dirname(process.execPath), "npm.cmd");
		return { cmd: existsSync(local) ? `"${local}"` : "npm.cmd", shell: true };
	}
	const local = join(dirname(process.execPath), "npm");
	return { cmd: existsSync(local) ? local : "npm", shell: false };
}

function acquireLock(): (() => void) | undefined {
	ensureDir(HOME);
	const lock = join(HOME, "update.lock");
	try {
		if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 15 * 60_000) rmSync(lock, { force: true });
		const fd = openSync(lock, "wx");
		writeFileSync(fd, String(process.pid));
		closeSync(fd);
		return () => rmSync(lock, { force: true });
	} catch {
		return undefined;
	}
}

async function download(urls: string[], expectedSha?: string, onProgress?: (msg: string) => void): Promise<string> {
	let lastErr: unknown;
	for (const url of urls) {
		try {
			onProgress?.(`下载 ${url}`);
			const res = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: "follow" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const buf = Buffer.from(await res.arrayBuffer());
			const sha = createHash("sha256").update(buf).digest("hex");
			if (expectedSha && sha !== expectedSha.toLowerCase()) throw new Error("SHA256 校验失败");
			const file = join(tmpdir(), `${BRAND.npmPackage}-${process.pid}-${Date.now()}.tgz`);
			writeFileSync(file, buf);
			return file;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error("下载失败");
}

function run(cmd: string, args: string[], shell: boolean, onLine?: (l: string) => void): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			shell,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
			windowsHide: true,
		});
		const feed = (d: Buffer) => {
			for (const l of d.toString().split(/\r?\n/)) if (l.trim()) onLine?.(l.trim());
		};
		child.stdout.on("data", feed);
		child.stderr.on("data", feed);
		child.on("error", () => resolve(127));
		child.on("close", (code) => resolve(code ?? 1));
	});
}

export type InstallResult =
	| { status: "updated"; version: string }
	| { status: "current" }
	| { status: "skipped"; reason: string }
	| { status: "failed"; reason: string };

/** Download, verify and install a release over the current npm install. Takes effect on next start. */
export async function installRelease(rel: ReleaseInfo, onProgress?: (msg: string) => void): Promise<InstallResult> {
	if (!isNewer(rel)) return { status: "current" };
	const prefix = installPrefix();
	if (!prefix) return { status: "skipped", reason: "当前为源码/开发模式运行，请用 git pull 更新" };
	if (loadState().installedVersion === rel.version) return { status: "updated", version: rel.version };
	const tarballName = rel.tarball || `${BRAND.npmPackage}-${rel.version}.tgz`;
	const asset = rel.assets.find((a) => a.name === tarballName);
	if (!asset) return { status: "failed", reason: `发布中缺少 ${tarballName}` };
	if (!rel.sha256) return { status: "failed", reason: "发布缺少 SHA256 校验信息 (latest.json)" };
	const release = acquireLock();
	if (!release) return { status: "skipped", reason: "另一个进程正在更新" };
	let file: string | undefined;
	try {
		const urls = [asset.mirror_url, asset.github_url].filter(Boolean) as string[];
		file = await download(urls, rel.sha256, onProgress);
		const { cmd, shell } = npmCommand();
		const args = ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error"];
		const registry = process.env.STZO_NPM_REGISTRY;
		if (registry) args.push(`--registry=${registry}`);
		args.push(shell ? `"${file}"` : file);
		onProgress?.("安装中（npm install -g）…");
		const code = await run(cmd, shell ? args.map((a) => (a.includes(" ") && !a.startsWith('"') ? `"${a}"` : a)) : args, shell, onProgress);
		if (code !== 0) return { status: "failed", reason: `npm 退出码 ${code}` };
		patchState({ installedVersion: rel.version, pendingVersion: undefined });
		return { status: "updated", version: rel.version };
	} catch (err) {
		return { status: "failed", reason: (err as Error).message };
	} finally {
		if (file) rmSync(file, { force: true });
		release();
	}
}
