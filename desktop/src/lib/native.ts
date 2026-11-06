// Process + OS bridge. In the Tauri app this goes through Rust commands; in a plain browser
// (vite dev without Tauri) it falls back to scripts/dev-bridge.mjs over HTTP + SSE so the UI
// can be developed and screenshotted against the real agent.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ProcEvent = { kind: "stdout"; id: number; line: string } | { kind: "stderr"; id: number; line: string } | { kind: "exit"; id: number; code: number | null };

export interface AppEnv {
	platform: string;
	home: string;
	cli: string;
	node: string;
	dev: boolean;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Listener = (e: ProcEvent) => void;
const listeners = new Map<number, Listener>();
const early = new Map<number, ProcEvent[]>();

function dispatch(e: ProcEvent) {
	const l = listeners.get(e.id);
	if (l) l(e);
	else {
		// Output can arrive before the spawn promise resolves; keep it until a listener attaches.
		const q = early.get(e.id) ?? [];
		q.push(e);
		early.set(e.id, q);
	}
	if (e.kind === "exit") setTimeout(() => listeners.delete(e.id), 0);
}

let ready: Promise<void> | undefined;
function ensureListening() {
	if (!ready) {
		if (isTauri) {
			ready = listen<ProcEvent>("proc", (ev) => dispatch(ev.payload)).then(() => undefined);
		} else {
			ready = new Promise((resolve) => {
				const es = new EventSource("/__bridge/events");
				es.onmessage = (m) => dispatch(JSON.parse(m.data));
				es.onopen = () => resolve();
			});
		}
	}
	return ready;
}

async function devCall<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`/__bridge/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = await res.json();
	if (!res.ok) throw new Error(data.error || res.statusText);
	return data as T;
}

export async function appEnv(): Promise<AppEnv> {
	if (isTauri) return invoke<AppEnv>("app_env");
	return devCall<AppEnv>("env", {});
}

/** Spawn `stzo <args>` in cwd and attach `onEvent`. Returns the process id. */
export async function spawn(args: string[], cwd: string | undefined, onEvent: Listener): Promise<number> {
	await ensureListening();
	const id = isTauri ? await invoke<number>("proc_spawn", { args, cwd: cwd ?? null }) : (await devCall<{ id: number }>("spawn", { args, cwd })).id;
	listeners.set(id, onEvent);
	for (const e of early.get(id) ?? []) onEvent(e);
	early.delete(id);
	return id;
}

export async function write(id: number, line: string) {
	if (isTauri) return invoke<void>("proc_write", { id, line });
	await devCall("write", { id, line });
}

export async function kill(id: number, graceMs = 0) {
	if (isTauri) return invoke<void>("proc_kill", { id, graceMs });
	await devCall("kill", { id, graceMs });
}

export async function openExternal(url: string) {
	if (isTauri) {
		const { openUrl } = await import("@tauri-apps/plugin-opener");
		return openUrl(url);
	}
	console.info("[dev] open external:", url);
}

export async function pickFolder(defaultPath?: string): Promise<string | undefined> {
	if (isTauri) {
		const { open } = await import("@tauri-apps/plugin-dialog");
		const r = await open({ directory: true, multiple: false, defaultPath, title: "选择项目文件夹" });
		return typeof r === "string" ? r : undefined;
	}
	const p = window.prompt("项目文件夹路径", defaultPath);
	return p || undefined;
}

export async function revealFolder(path: string) {
	if (isTauri) {
		const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
		return revealItemInDir(path);
	}
}

export interface UpdateInfo {
	version: string;
	notes?: string;
	install: (onProgress?: (pct: number) => void) => Promise<void>;
}

export async function checkAppUpdate(): Promise<UpdateInfo | undefined> {
	if (!isTauri) return undefined;
	const { check } = await import("@tauri-apps/plugin-updater");
	const u = await check({ timeout: 15000 });
	if (!u) return undefined;
	return {
		version: u.version,
		notes: u.body,
		install: async (onProgress) => {
			let total = 0;
			let got = 0;
			await u.downloadAndInstall((ev) => {
				if (ev.event === "Started") total = ev.data.contentLength ?? 0;
				else if (ev.event === "Progress") {
					got += ev.data.chunkLength;
					if (total) onProgress?.(Math.min(100, Math.round((got / total) * 100)));
				}
			});
			const { relaunch } = await import("@tauri-apps/plugin-process");
			await relaunch();
		},
	};
}

export async function appVersion(): Promise<string> {
	if (!isTauri) return "dev";
	const { getVersion } = await import("@tauri-apps/api/app");
	return getVersion();
}
