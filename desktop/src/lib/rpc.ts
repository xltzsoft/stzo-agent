// Client for one long-lived `stzo --mode rpc` process (one per open project folder).
// Keeps a reconstructed view of the conversation that React reads through `useAgent`.
import { useSyncExternalStore } from "react";
import { kill, spawn, write } from "./native";

export interface Model {
	id: string;
	name: string;
	api: string;
	provider: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export type Block =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; redacted?: boolean }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, any>; partialJson?: string }
	| { type: "image"; data: string; mimeType: string };

export interface ChatMessage {
	role: "user" | "assistant" | "toolResult" | "bashExecution" | "custom" | "branchSummary" | "compactionSummary" | "card";
	content?: string | Block[];
	timestamp?: number;
	// assistant
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	provider?: string;
	usage?: { input: number; output: number; cost?: { total: number } };
	// toolResult
	toolCallId?: string;
	toolName?: string;
	details?: any;
	isError?: boolean;
	// bashExecution
	command?: string;
	output?: string;
	exitCode?: number;
	// custom / card
	customType?: string;
	display?: boolean;
	summary?: string;
	data?: any;
}

export interface ToolRun {
	running: boolean;
	partial?: string;
	result?: { content?: Block[]; details?: any };
	isError?: boolean;
	durationMs?: number;
}

export interface UiRequest {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeout?: number;
}

export interface Notice {
	id: number;
	text: string;
	tone: "info" | "warning" | "error" | "success";
}

export interface Stats {
	cost: number;
	tokens: { input: number; output: number; total: number };
	contextUsage?: { tokens: number; contextWindow: number; percent: number };
}

export interface Command {
	name: string;
	description?: string;
	source: string;
}

export interface AgentState {
	phase: "starting" | "ready" | "exited";
	exitInfo?: string;
	cwd: string;
	messages: ChatMessage[];
	tools: Record<string, ToolRun>;
	streaming: boolean;
	compacting: boolean;
	retry?: { attempt: number; maxAttempts: number; error: string };
	model?: Model;
	models: Model[];
	thinkingLevel: string;
	thinkingLevels: string[];
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	statuses: Record<string, string>;
	widgets: Record<string, string[]>;
	queue: { steering: string[]; followUp: string[] };
	dialogs: UiRequest[];
	editorText?: { text: string; seq: number };
	stats?: Stats;
	commands: Command[];
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Provider errors often arrive as raw JSON bodies; pull out the human-readable message. */
export function errorText(raw?: string): string {
	const s = (raw ?? "").trim();
	const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
	if (m) {
		try {
			return JSON.parse(`"${m[1]}"`);
		} catch {
			return m[1];
		}
	}
	return s;
}

let noticeSeq = 0;
export type NoticeSink = (n: Notice) => void;

export class Agent {
	state: AgentState;
	private pid?: number;
	private reqSeq = 0;
	private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private subs = new Set<() => void>();
	private stderr: string[] = [];
	private raf = 0;
	private disposed = false;
	onSettled?: () => void;
	onSessionChanged?: () => void;

	constructor(
		cwd: string,
		private notify: NoticeSink,
	) {
		this.state = {
			phase: "starting",
			cwd,
			messages: [],
			tools: {},
			streaming: false,
			compacting: false,
			models: [],
			thinkingLevel: "off",
			thinkingLevels: ["off"],
			statuses: {},
			widgets: {},
			queue: { steering: [], followUp: [] },
			dialogs: [],
			commands: [],
		};
	}

	// ---- store plumbing -------------------------------------------------------------------
	subscribe = (fn: () => void) => {
		this.subs.add(fn);
		return () => this.subs.delete(fn);
	};
	private emit(now = false) {
		if (now) {
			cancelAnimationFrame(this.raf);
			this.raf = 0;
			for (const s of this.subs) s();
			return;
		}
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			for (const s of this.subs) s();
		});
	}
	private set(patch: Partial<AgentState>, now = false) {
		this.state = { ...this.state, ...patch };
		this.emit(now);
	}

	// ---- process --------------------------------------------------------------------------
	async start(sessionPath?: string) {
		this.stderr = [];
		this.set({ phase: "starting", exitInfo: undefined }, true);
		try {
			this.pid = await spawn(["--mode", "rpc"], this.state.cwd, (e) => {
				if (e.kind === "stdout") this.onLine(e.line);
				else if (e.kind === "stderr") {
					this.stderr.push(stripAnsi(e.line));
					if (this.stderr.length > 40) this.stderr.shift();
				} else this.onExit(e.code);
			});
		} catch (err) {
			this.set({ phase: "exited", exitInfo: String(err) }, true);
			return;
		}
		try {
			if (sessionPath) await this.request({ type: "switch_session", sessionPath });
			await this.refresh();
			this.set({ phase: "ready" }, true);
		} catch (err) {
			if (this.state.phase !== "exited") this.set({ phase: "exited", exitInfo: (err as Error).message }, true);
		}
	}

	private onExit(code: number | null) {
		this.pid = undefined;
		for (const p of this.pending.values()) p.reject(new Error("智能体进程已退出"));
		this.pending.clear();
		if (this.disposed) return;
		const tail = this.stderr.filter((l) => l.trim()).slice(-6).join("\n");
		this.set({ phase: "exited", streaming: false, exitInfo: tail || `进程退出（代码 ${code ?? "?"}）` }, true);
	}

	async dispose() {
		this.disposed = true;
		if (this.pid !== undefined) await kill(this.pid, 1500).catch(() => {});
		this.subs.clear();
	}

	request<T = any>(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
		if (this.pid === undefined) return Promise.reject(new Error("智能体未运行"));
		const id = `r${++this.reqSeq}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${cmd.type} 超时`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			write(this.pid!, JSON.stringify({ ...cmd, id })).catch((e) => {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new Error(String(e)));
			});
		});
	}

	private send(obj: Record<string, unknown>) {
		if (this.pid !== undefined) void write(this.pid, JSON.stringify(obj)).catch(() => {});
	}

	// ---- commands -------------------------------------------------------------------------
	async refresh() {
		const [st, msgs, models, levels, cmds] = await Promise.all([
			this.request({ type: "get_state" }),
			this.request({ type: "get_messages" }),
			this.request({ type: "get_available_models" }),
			this.request({ type: "get_available_thinking_levels" }).catch(() => ({ levels: ["off"] })),
			this.request({ type: "get_commands" }).catch(() => ({ commands: [] })),
		]);
		const model = st.model && st.model.provider !== "unknown" ? st.model : undefined;
		this.set({
			model,
			models: models.models ?? [],
			thinkingLevel: st.thinkingLevel ?? "off",
			thinkingLevels: levels.levels ?? ["off"],
			sessionFile: st.sessionFile,
			sessionId: st.sessionId,
			sessionName: st.sessionName,
			streaming: !!st.isStreaming,
			messages: (msgs.messages ?? []) as ChatMessage[],
			tools: {},
			commands: (cmds.commands ?? []).map((c: any) => ({ name: c.name, description: c.description, source: c.source })),
		});
		void this.refreshStats();
	}

	async refreshStats() {
		try {
			const s = await this.request<Stats>({ type: "get_session_stats" });
			this.set({ stats: s });
		} catch {
			/* ignore */
		}
	}

	async prompt(text: string, images?: { data: string; mimeType: string }[]) {
		const msg: Record<string, unknown> = { type: "prompt", message: text };
		if (images?.length) msg.images = images.map((i) => ({ type: "image", ...i }));
		if (this.state.streaming && !text.startsWith("/")) msg.streamingBehavior = "steer";
		const r = await this.request(msg, 120_000);
		return r?.disposition as string | undefined;
	}

	abort() {
		return this.request({ type: "abort" }).catch(() => {});
	}

	async setModel(m: Model) {
		const model = await this.request<Model>({ type: "set_model", provider: m.provider, modelId: m.id });
		const levels = await this.request({ type: "get_available_thinking_levels" }).catch(() => ({ levels: ["off"] }));
		const st = await this.request({ type: "get_state" });
		this.set({ model, thinkingLevels: levels.levels ?? ["off"], thinkingLevel: st.thinkingLevel ?? this.state.thinkingLevel });
		void this.refreshStats();
	}

	async setThinking(level: string) {
		await this.request({ type: "set_thinking_level", level });
		this.set({ thinkingLevel: level });
	}

	async newSession() {
		const r = await this.request({ type: "new_session" });
		if (r?.cancelled) return;
		await this.refresh();
		this.onSessionChanged?.();
	}

	async switchSession(path: string) {
		const r = await this.request({ type: "switch_session", sessionPath: path });
		if (r?.cancelled) return;
		await this.refresh();
	}

	async rename(name: string) {
		await this.request({ type: "set_session_name", name });
		this.set({ sessionName: name });
		this.onSessionChanged?.();
	}

	setEditorText(text: string) {
		this.set({ editorText: { text, seq: (this.state.editorText?.seq ?? 0) + 1 } }, true);
	}

	answer(id: string, reply: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
		this.send({ type: "extension_ui_response", id, ...reply });
		this.set({ dialogs: this.state.dialogs.filter((d) => d.id !== id) }, true);
	}

	// ---- events ---------------------------------------------------------------------------
	private onLine(line: string) {
		if (!line.trim()) return;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			return;
		}
		if (ev.type === "response") {
			const p = ev.id ? this.pending.get(ev.id) : undefined;
			if (!p) return;
			this.pending.delete(ev.id);
			if (ev.success) p.resolve(ev.data);
			else p.reject(new Error(ev.error || `${ev.command} 失败`));
			return;
		}
		this.onEvent(ev);
	}

	private patchLast(fn: (m: ChatMessage) => ChatMessage) {
		const msgs = this.state.messages;
		const i = msgs.length - 1;
		if (i < 0 || msgs[i].role !== "assistant") return;
		const next = msgs.slice();
		next[i] = fn(msgs[i]);
		this.set({ messages: next });
	}

	private onEvent(ev: any) {
		switch (ev.type) {
			case "agent_start":
				return this.set({ streaming: true, retry: undefined }, true);
			case "agent_settled":
				this.set({ streaming: false, retry: undefined }, true);
				void this.refreshStats();
				this.onSettled?.();
				this.onSessionChanged?.();
				return;
			case "message_start":
				return this.set({ messages: [...this.state.messages, { ...ev.message, content: Array.isArray(ev.message.content) ? [...ev.message.content] : ev.message.content }] });
			case "message_update": {
				const u = ev.assistantMessageEvent;
				if (!u) return;
				return this.patchLast((m) => {
					const content = Array.isArray(m.content) ? m.content.slice() : [];
					const i = u.contentIndex ?? content.length;
					const cur: any = content[i];
					switch (u.type) {
						case "text_start":
							content[i] = { type: "text", text: "" };
							break;
						case "text_delta":
							content[i] = { type: "text", text: (cur?.text ?? "") + u.delta };
							break;
						case "text_end":
							content[i] = { type: "text", text: typeof u.content === "string" ? u.content : (cur?.text ?? "") };
							break;
						case "thinking_start":
							content[i] = { type: "thinking", thinking: "" };
							break;
						case "thinking_delta":
							content[i] = { type: "thinking", thinking: (cur?.thinking ?? "") + u.delta };
							break;
						case "thinking_end":
							content[i] = { type: "thinking", thinking: typeof u.content === "string" ? u.content : (cur?.thinking ?? "") };
							break;
						case "toolcall_start":
							content[i] = { type: "toolCall", id: u.id, name: u.toolName, arguments: {}, partialJson: "" };
							break;
						case "toolcall_delta":
							content[i] = { ...(cur ?? { type: "toolCall", id: "", name: "", arguments: {} }), partialJson: (cur?.partialJson ?? "") + u.delta };
							break;
						case "toolcall_end":
							content[i] = u.toolCall;
							break;
					}
					return { ...m, content };
				});
			}
			case "message_end": {
				const msgs = this.state.messages.slice();
				const i = msgs.length - 1;
				if (i >= 0 && msgs[i].role === ev.message.role) msgs[i] = ev.message;
				else msgs.push(ev.message);
				return this.set({ messages: msgs }, true);
			}
			case "tool_execution_start":
				return this.set({ tools: { ...this.state.tools, [ev.toolCallId]: { running: true } } });
			case "tool_execution_update": {
				const text = (ev.partialResult?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
				return this.set({ tools: { ...this.state.tools, [ev.toolCallId]: { running: true, partial: text } } });
			}
			case "tool_execution_end":
				return this.set({ tools: { ...this.state.tools, [ev.toolCallId]: { running: false, result: ev.result, isError: ev.isError, durationMs: ev.durationMs } } }, true);
			case "queue_update":
				return this.set({ queue: { steering: ev.steering ?? [], followUp: ev.followUp ?? [] } });
			case "session_info_changed":
				this.set({ sessionName: ev.name });
				this.onSessionChanged?.();
				return;
			case "thinking_level_changed":
				return this.set({ thinkingLevel: ev.level });
			case "compaction_start":
				return this.set({ compacting: true }, true);
			case "compaction_end":
				this.set({ compacting: false }, true);
				void this.request({ type: "get_messages" }).then((r) => this.set({ messages: r.messages ?? [] }, true));
				return;
			case "auto_retry_start": {
				// pi drops the failed attempt from the conversation before retrying (get_messages won't
				// return it either), so remove it here instead of stacking duplicate answers.
				const msgs = this.state.messages;
				const last = msgs[msgs.length - 1];
				const messages = last?.role === "assistant" && last.stopReason === "error" ? msgs.slice(0, -1) : msgs;
				return this.set({ messages, retry: { attempt: ev.attempt, maxAttempts: ev.maxAttempts, error: errorText(ev.errorMessage) } }, true);
			}
			case "auto_retry_end":
				return this.set({ retry: undefined }, true);
			case "entry_appended":
				if (ev.entry?.customType === "stzo-card" || ev.entry?.type === "custom") {
					const data = ev.entry.data;
					if (data?.title) this.set({ messages: [...this.state.messages, { role: "card", data, timestamp: Date.now() }] }, true);
				}
				return;
			case "extension_error":
				return this.notify({ id: ++noticeSeq, text: `插件出错：${ev.error}`, tone: "error" });
			case "extension_ui_request":
				return this.onUi(ev);
		}
	}

	private onUi(ev: any) {
		switch (ev.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
				return this.set({ dialogs: [...this.state.dialogs, ev as UiRequest] }, true);
			case "notify":
				return this.notify({ id: ++noticeSeq, text: stripAnsi(ev.message ?? ""), tone: ev.notifyType ?? "info" });
			case "setStatus": {
				const statuses = { ...this.state.statuses };
				if (ev.statusText) statuses[ev.statusKey] = stripAnsi(ev.statusText);
				else delete statuses[ev.statusKey];
				return this.set({ statuses });
			}
			case "setWidget": {
				const widgets = { ...this.state.widgets };
				if (ev.widgetLines?.length) widgets[ev.widgetKey] = ev.widgetLines.map(stripAnsi);
				else delete widgets[ev.widgetKey];
				return this.set({ widgets });
			}
			case "set_editor_text":
				return this.set({ editorText: { text: ev.text ?? "", seq: (this.state.editorText?.seq ?? 0) + 1 } });
		}
	}
}

const EMPTY = {} as AgentState;
export function useAgent<T>(agent: Agent | undefined, select: (s: AgentState) => T): T {
	return useSyncExternalStore(
		agent ? agent.subscribe : () => () => {},
		() => select(agent ? agent.state : EMPTY),
	);
}
