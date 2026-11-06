import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Product constants. Server and repo can be overridden for staging/testing. */
export const BRAND = {
	name: "STZO Agent",
	command: "stzo",
	npmPackage: "stzo-agent",
	server: (process.env.STZO_SERVER || "https://gc.stzo.cn").replace(/\/$/, ""),
	mount: "/agent",
	repo: process.env.STZO_REPO || "xltzsoft/stzo-agent",
};

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPackageVersion(): string {
	try {
		return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version || "0.0.0";
	} catch {
		return "0.0.0";
	}
}
export const VERSION = readPackageVersion();

export const HOME = process.env.STZO_HOME || join(homedir(), ".stzo-agent");
export const AGENT_DIR = join(HOME, "agent");
export const CACHE_DIR = join(HOME, "cache");
export const ACCOUNT_FILE = join(HOME, "account.json");
export const STATE_FILE = join(HOME, "state.json");

export const bridgeUrl = (path: string) => `${BRAND.server}${BRAND.mount}${path}`;

export function ensureDir(dir: string, mode = 0o700) {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode });
}

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** Atomic write; 0600 because several of these files hold credentials. */
export function writeJson(file: string, data: unknown) {
	ensureDir(dirname(file));
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

export interface LocalState {
	deviceId?: string;
	autoUpdate?: boolean;
	lastUpdateCheck?: number;
	pendingVersion?: string;
	installedVersion?: string;
	seededVersion?: string;
}

export const loadState = () => readJson<LocalState>(STATE_FILE, {});
export function patchState(patch: Partial<LocalState>) {
	const next = { ...loadState(), ...patch };
	writeJson(STATE_FILE, next);
	return next;
}

export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core, pre = ""] = v.replace(/^v/, "").split("-", 2);
		return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	if (x.pre === y.pre) return 0;
	if (!x.pre) return 1;
	if (!y.pre) return -1;
	return x.pre < y.pre ? -1 : 1;
}
