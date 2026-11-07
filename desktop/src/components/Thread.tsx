import { memo, useEffect, useMemo, useState } from "react";
import { errorText, type Block, type ChatMessage, type ToolRun } from "../lib/rpc";
import { IconChevron, IconChevronRight, IconCopy, IconEdit, IconRetry } from "./icons";
import { Markdown } from "./Markdown";

const rel = (p: unknown, cwd: string) => {
	const s = String(p ?? "");
	if (!cwd) return s;
	// Windows paths may use either separator and differ in case.
	const norm = (x: string) => x.replace(/\\/g, "/");
	const win = /^[a-z]:[\\/]/i.test(cwd);
	const base = norm(cwd).replace(/\/$/, "") + "/";
	const path = norm(s);
	const hit = win ? path.toLowerCase().startsWith(base.toLowerCase()) : path.startsWith(base);
	return hit ? path.slice(base.length) : s;
};

// One stable ToolRun per historical toolResult message, so memoized messages don't re-render on
// every streamed frame just because the lookup table was rebuilt.
const historyRuns = new WeakMap<ChatMessage, ToolRun>();
const historyRun = (m: ChatMessage): ToolRun => {
	let run = historyRuns.get(m);
	if (!run) {
		run = { running: false, result: { content: m.content as Block[], details: m.details }, isError: m.isError };
		historyRuns.set(m, run);
	}
	return run;
};
const toolCallIds = (m: ChatMessage) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "toolCall").map((b: any) => b.id as string) : []);
const firstLine = (s: string) => {
	const l = s.split("\n")[0];
	return s.includes("\n") ? `${l} …` : l;
};
const textBlocks = (content: ChatMessage["content"] | undefined) =>
	typeof content === "string" ? content : (content ?? []).filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("");

function partialArgs(call: Extract<Block, { type: "toolCall" }>): Record<string, any> {
	if (call.arguments && Object.keys(call.arguments).length) return call.arguments;
	const raw = call.partialJson ?? "";
	const out: Record<string, any> = {};
	// Pull complete "key": "value" pairs out of a partially streamed JSON object.
	for (const m of raw.matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
		try {
			out[m[1]] = JSON.parse(`"${m[2]}"`);
		} catch {
			out[m[1]] = m[2];
		}
	}
	return out;
}

interface Summary {
	verb: string;
	target: string;
	meta?: React.ReactNode;
}

function diffStats(diff: string) {
	let a = 0;
	let d = 0;
	for (const l of diff.split("\n")) {
		if (l.startsWith("+")) a++;
		else if (l.startsWith("-")) d++;
	}
	return { a, d };
}

function summarize(name: string, args: Record<string, any>, run: ToolRun | undefined, cwd: string): Summary {
	const details = run?.result?.details;
	switch (name) {
		case "bash":
		case "powershell":
			return { verb: "运行", target: firstLine(String(args.command ?? "")) };
		case "read":
			return {
				verb: "读取",
				target: rel(args.path, cwd),
				meta: args.offset ? `第 ${args.offset} 行起` : undefined,
			};
		case "edit": {
			const diff = typeof details?.diff === "string" ? details.diff : "";
			const st = diff ? diffStats(diff) : undefined;
			return {
				verb: "编辑",
				target: rel(args.path, cwd),
				meta: st ? (
					<>
						<span className="add">+{st.a}</span> <span className="del">−{st.d}</span>
					</>
				) : undefined,
			};
		}
		case "write": {
			const lines = typeof args.content === "string" ? args.content.split("\n").length : 0;
			return { verb: "写入", target: rel(args.path, cwd), meta: lines ? `${lines} 行` : undefined };
		}
		case "grep":
			return { verb: "搜索", target: String(args.pattern ?? ""), meta: args.path ? rel(args.path, cwd) : undefined };
		case "find":
			return { verb: "查找", target: String(args.pattern ?? args.path ?? "") };
		case "ls":
			return { verb: "列出", target: rel(args.path ?? ".", cwd) };
		case "subagent":
			return { verb: "子代理", target: firstLine(String(args.task ?? args.agent ?? (args.tasks ? `${args.tasks.length} 个并行任务` : ""))) };
		case "todo":
			return { verb: "待办", target: String(args.action ?? "") + (args.text ? ` ${args.text}` : "") };
		case "question":
			return { verb: "提问", target: String(args.question ?? "") };
		default: {
			const v = Object.values(args).find((x) => typeof x === "string") as string | undefined;
			return { verb: name, target: v ? firstLine(v) : "" };
		}
	}
}

function resultText(run: ToolRun | undefined) {
	if (!run) return "";
	if (run.running) return run.partial ?? "";
	return (run.result?.content ?? []).filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
}

function DiffView({ diff }: { diff: string }) {
	return (
		<div className="diff selectable">
			{diff.split("\n").map((l, i) => (
				<div key={i} className={l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : l.trim() === "..." ? "h" : ""}>
					{l || " "}
				</div>
			))}
		</div>
	);
}

function ToolStep({ call, run, cwd, onCopy }: { call: Extract<Block, { type: "toolCall" }>; run?: ToolRun; cwd: string; onCopy?: (t: string) => void }) {
	const [open, setOpen] = useState(false);
	const args = partialArgs(call);
	const s = summarize(call.name, args, run, cwd);
	const state = !run ? (call.partialJson !== undefined ? "run" : "") : run.running ? "run" : run.isError ? "err" : "ok";
	const out = resultText(run);
	const diff = call.name === "edit" && typeof run?.result?.details?.diff === "string" ? (run.result.details.diff as string) : "";
	const secs = run?.durationMs && run.durationMs > 1500 ? `${(run.durationMs / 1000).toFixed(1)}s` : undefined;
	return (
		<div className={`step ${state}`}>
			<span className="dot" />
			<button className="step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className="verb">{s.verb}</span>
				<span className="target" title={s.target}>
					{s.target}
				</span>
				<span className="meta">
					{s.meta}
					{s.meta && secs ? "  " : ""}
					{secs}
				</span>
				{open ? <IconChevron width={13} /> : <IconChevronRight width={13} />}
			</button>
			{open && (
				<div className="step-body">
					{onCopy && (out || diff || args.command) && (
						<button
							className="step-copy"
							title="复制"
							onClick={() => onCopy([args.command ? `$ ${args.command}` : "", diff || out].filter(Boolean).join("\n"))}
						>
							<IconCopy width={13} />
						</button>
					)}
					{(call.name === "bash" || call.name === "powershell") && <div className="cmd selectable">{String(args.command ?? "")}</div>}
					{diff ? (
						<DiffView diff={diff} />
					) : call.name === "write" && typeof args.content === "string" ? (
						<pre className="selectable">{args.content}</pre>
					) : out ? (
						<pre className="selectable">{out.length > 20000 ? `${out.slice(0, 20000)}\n…（已截断）` : out}</pre>
					) : !run || run.running ? (
						<pre>执行中…</pre>
					) : (
						<pre>（无输出）</pre>
					)}
				</div>
			)}
		</div>
	);
}

function Thinking({ text, live }: { text: string; live: boolean }) {
	const [open, setOpen] = useState(false);
	if (!text.trim() && !live) return null;
	return (
		<div className={`thinking${live ? " live" : ""}`}>
			<button onClick={() => setOpen(!open)} aria-expanded={open}>
				{open ? <IconChevron width={13} /> : <IconChevronRight width={13} />}
				{live ? "正在思考…" : "思考过程"}
			</button>
			{open && <div className="body selectable">{text}</div>}
		</div>
	);
}

function friendlyError(raw: string) {
	const msg = errorText(raw);
	if (/insufficient|余额|balance|quota|\b402\b/i.test(msg)) return { text: "账户余额不足，充值后即可继续。", action: "recharge" as const };
	if (/\b401\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|api key (is )?(invalid|expired|disabled)/i.test(msg)) return { text: "授权已失效，请重新登录。", action: "login" as const };
	if (/abort/i.test(msg)) return { text: "已停止。", action: undefined };
	if (/upstream|502|503|504|unavailable|overloaded|terminal|timed? ?out/i.test(msg))
		return { text: `模型服务暂时出错（${msg}）。回复可能不完整，可以重新发送，或在右上角换一个模型。`, action: undefined };
	return { text: msg || "请求失败", action: undefined };
}

const AssistantMessage = memo(function AssistantMessage({
	msg,
	tools,
	cwd,
	live,
	onAction,
	onCopy,
}: {
	msg: ChatMessage;
	tools: Record<string, ToolRun>;
	cwd: string;
	live: boolean;
	onAction: (a: "recharge" | "login") => void;
	onCopy?: (t: string) => void;
}) {
	const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") } as Block];
	// Group consecutive tool calls into one timeline.
	const groups: (Block | Block[])[] = [];
	for (const b of blocks) {
		if (b.type === "toolCall") {
			const last = groups[groups.length - 1];
			if (Array.isArray(last)) last.push(b);
			else groups.push([b]);
		} else groups.push(b);
	}
	const lastIdx = groups.length - 1;
	return (
		<div className="assistant">
			{groups.map((g, i) => {
				if (Array.isArray(g))
					return (
						<div className="trace" key={i}>
							{g.map((c: any) => (
								<ToolStep key={c.id || i} call={c} run={tools[c.id]} cwd={cwd} onCopy={onCopy} />
							))}
						</div>
					);
				if (g.type === "text") {
					if (!g.text) return null;
					return (
						<div key={i}>
							<Markdown text={g.text} streaming={live && i === lastIdx} />
						</div>
					);
				}
				if (g.type === "thinking") return <Thinking key={i} text={g.thinking} live={live && i === lastIdx} />;
				return null;
			})}
			{msg.stopReason === "error" &&
				(() => {
					const e = friendlyError(msg.errorMessage ?? "");
					return (
						<div className="error-note">
							<span>{e.text}</span>
							{e.action && (
								<button className="btn small" onClick={() => onAction(e.action!)}>
									{e.action === "recharge" ? "去充值" : "重新登录"}
								</button>
							)}
						</div>
					);
				})()}
			{msg.stopReason === "aborted" && <div className="muted-note">已停止</div>}
		</div>
	);
},
(a, b) =>
	a.msg === b.msg &&
	a.cwd === b.cwd &&
	a.live === b.live &&
	a.onAction === b.onAction &&
	a.onCopy === b.onCopy &&
	toolCallIds(b.msg).every((id) => a.tools[id] === b.tools[id]));

const UserMessage = memo(function UserMessage({
	msg,
	busy,
	onCopy,
	onEdit,
}: {
	msg: ChatMessage;
	busy: boolean;
	onCopy?: (t: string) => void;
	onEdit?: (m: ChatMessage) => void;
}) {
	const images = Array.isArray(msg.content) ? (msg.content.filter((b) => b.type === "image") as Extract<Block, { type: "image" }>[]) : [];
	const text = textBlocks(msg.content);
	return (
		<div className="turn-user">
			<div className="bubble selectable">
				{text}
				{images.map((im, i) => (
					<img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt="" />
				))}
			</div>
			{(onCopy || onEdit) && (
				<div className="msg-actions">
					{onCopy && text && (
						<button title="复制" aria-label="复制" onClick={() => onCopy(text)}>
							<IconCopy width={13} />
						</button>
					)}
					{onEdit && (
						<button
							title={busy ? "当前任务结束后才能编辑" : "从这里重新编辑（原对话保留在历史记录中）"}
							aria-label="从这里重新编辑"
							disabled={busy}
							onClick={() => onEdit(msg)}
						>
							<IconEdit width={13} />
						</button>
					)}
				</div>
			)}
		</div>
	);
});

// ---- turns ---------------------------------------------------------------------------------

export function fmtDuration(ms: number) {
	const s = Math.max(1, Math.round(ms / 1000));
	if (s < 60) return `${s} 秒`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} 分 ${s % 60} 秒`;
	return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function RunTimer({ since }: { since?: number }) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const iv = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(iv);
	}, []);
	const ms = since ? now - since : 0;
	return (
		<div className="run-timer" role="status">
			<span className="spinner" style={{ width: 11, height: 11 }} />
			<span>{ms >= 1000 ? `已工作 ${fmtDuration(ms)}` : "正在工作"}</span>
		</div>
	);
}

interface FileChange {
	path: string;
	adds: number;
	dels: number;
	diffs: string[];
	created: boolean;
}

/** Files edited or written in a turn, from the edit/write calls that succeeded. */
function turnChanges(msgs: ChatMessage[], tools: Record<string, ToolRun>, cwd: string): FileChange[] {
	const byPath = new Map<string, FileChange>();
	for (const m of msgs) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (b.type !== "toolCall" || (b.name !== "edit" && b.name !== "write")) continue;
			const run = tools[b.id];
			if (!run || run.running || run.isError) continue;
			const path = rel(b.arguments?.path, cwd);
			if (!path) continue;
			const fc = byPath.get(path) ?? { path, adds: 0, dels: 0, diffs: [], created: false };
			if (b.name === "edit") {
				const diff = typeof run.result?.details?.diff === "string" ? (run.result.details.diff as string) : "";
				if (diff) {
					const st = diffStats(diff);
					fc.adds += st.a;
					fc.dels += st.d;
					fc.diffs.push(diff);
				}
			} else {
				const content = typeof b.arguments?.content === "string" ? (b.arguments.content as string) : "";
				const lines = content ? content.split("\n") : [];
				fc.adds += lines.length;
				fc.created = !fc.diffs.length;
				fc.diffs.push(lines.slice(0, 400).map((l) => `+${l}`).join("\n") + (lines.length > 400 ? "\n..." : ""));
			}
			byPath.set(path, fc);
		}
	}
	return [...byPath.values()];
}

function ChangeCard({ changes }: { changes: FileChange[] }) {
	const [open, setOpen] = useState(false);
	const [file, setFile] = useState<string>();
	const adds = changes.reduce((n, c) => n + c.adds, 0);
	const dels = changes.reduce((n, c) => n + c.dels, 0);
	return (
		<div className={`changes${open ? " open" : ""}`}>
			<button className="changes-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				{open ? <IconChevron width={13} /> : <IconChevronRight width={13} />}
				<span>修改了 {changes.length} 个文件</span>
				<span className="add">+{adds}</span>
				<span className="del">−{dels}</span>
			</button>
			{open && (
				<div className="changes-list">
					{changes.map((c) => (
						<div key={c.path}>
							<button className={`change-row${file === c.path ? " on" : ""}`} onClick={() => setFile(file === c.path ? undefined : c.path)} aria-expanded={file === c.path}>
								<span className="path" title={c.path}>
									{c.path}
								</span>
								{c.created && <span className="tag">新建</span>}
								<span className="add">+{c.adds}</span>
								<span className="del">−{c.dels}</span>
							</button>
							{file === c.path && c.diffs.map((d, i) => <DiffView key={i} diff={d} />)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

const TurnFooter = memo(
	function TurnFooter({
		msgs,
		user,
		tools,
		cwd,
		durationMs,
		onCopy,
		onRetry,
	}: {
		msgs: ChatMessage[];
		user?: ChatMessage;
		tools: Record<string, ToolRun>;
		cwd: string;
		durationMs?: number;
		onCopy?: (t: string) => void;
		onRetry?: (m: ChatMessage) => void;
	}) {
		const changes = useMemo(() => turnChanges(msgs, tools, cwd), [msgs, tools, cwd]);
		let last: ChatMessage | undefined;
		let reply = "";
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i].role !== "assistant") continue;
			last ??= msgs[i];
			reply = textBlocks(msgs[i].content).trim();
			if (reply) break;
		}
		const failed = last?.stopReason === "error";
		if (!user && !changes.length) return null;
		if (!changes.length && !reply && !failed && !durationMs) return null;
		return (
			<div className="turn-foot">
				{changes.length > 0 && <ChangeCard changes={changes} />}
				<div className="turn-meta">
					{durationMs ? <span className="took">用时 {fmtDuration(durationMs)}</span> : null}
					<span className="msg-actions inline">
						{onCopy && reply && (
							<button title="复制回复" aria-label="复制回复" onClick={() => onCopy(reply)}>
								<IconCopy width={13} />
							</button>
						)}
						{onRetry && user && failed && (
							<button className="labelled" title="在新分支中重新发送这条消息" onClick={() => onRetry(user)}>
								<IconRetry width={13} />
								<span>重试</span>
							</button>
						)}
					</span>
				</div>
			</div>
		);
	},
	(a, b) =>
		a.msgs.length === b.msgs.length &&
		a.msgs.every((m, i) => m === b.msgs[i]) &&
		a.user === b.user &&
		a.durationMs === b.durationMs &&
		a.cwd === b.cwd &&
		a.onCopy === b.onCopy &&
		a.onRetry === b.onRetry &&
		a.msgs.every((m) => toolCallIds(m).every((id) => a.tools[id] === b.tools[id])),
);

export function Thread({
	messages,
	tools,
	streaming,
	runStartedAt,
	durations,
	cwd,
	onAction,
	onCopy,
	onEdit,
	onRetry,
}: {
	messages: ChatMessage[];
	tools: Record<string, ToolRun>;
	streaming: boolean;
	runStartedAt?: number;
	durations?: Record<string, number>;
	cwd: string;
	onAction: (a: "recharge" | "login") => void;
	onCopy?: (t: string) => void;
	onEdit?: (m: ChatMessage) => void;
	onRetry?: (m: ChatMessage) => void;
}) {
	// Tool results from history (no live run info): synthesize runs from toolResult messages.
	const allTools = useMemo(() => {
		const map: Record<string, ToolRun> = {};
		for (const m of messages) {
			if (m.role === "toolResult" && m.toolCallId) {
				map[m.toolCallId] = historyRun(m);
			}
		}
		return { ...map, ...tools };
	}, [messages, tools]);

	// A turn runs from a user message up to the next one. Its footer (time taken, changed files,
	// copy/retry) goes after its last message once that turn is no longer running.
	const turns = useMemo(() => {
		const ends = new Map<number, { msgs: ChatMessage[]; user?: ChatMessage }>();
		let start = 0;
		const close = (end: number) => {
			const first = messages[start];
			ends.set(end, { msgs: messages.slice(start, end + 1), user: first?.role === "user" ? first : undefined });
		};
		for (let i = 1; i < messages.length; i++) {
			if (messages[i].role === "user") {
				close(i - 1);
				start = i;
			}
		}
		if (messages.length) close(messages.length - 1);
		return ends;
	}, [messages]);

	const lastAssistant = messages.length - 1;
	const footer = (i: number) => {
		const t = turns.get(i);
		if (!t || (streaming && i === messages.length - 1)) return null;
		const ts = t.user?.timestamp;
		return (
			<TurnFooter
				key={`foot-${i}`}
				msgs={t.msgs}
				user={t.user}
				tools={allTools}
				cwd={cwd}
				durationMs={ts ? durations?.[String(ts)] : undefined}
				onCopy={onCopy}
				onRetry={onRetry}
			/>
		);
	};
	const render = (m: ChatMessage, i: number) => {
		switch (m.role) {
			case "user":
				return <UserMessage key={i} msg={m} busy={streaming} onCopy={onCopy} onEdit={onEdit} />;
			case "assistant":
				return <AssistantMessage key={i} msg={m} tools={allTools} cwd={cwd} live={streaming && i === lastAssistant} onAction={onAction} onCopy={onCopy} />;
			case "bashExecution":
				return (
					<div className="trace" key={i}>
						<ToolStep
							call={{ type: "toolCall", id: `bash-${i}`, name: "bash", arguments: { command: m.command } }}
							run={{ running: false, isError: (m.exitCode ?? 0) !== 0, result: { content: [{ type: "text", text: m.output ?? "" }] } }}
							cwd={cwd}
							onCopy={onCopy}
						/>
					</div>
				);
			case "custom":
				if (m.display === false) return null;
				return (
					<div className="card-note selectable" key={i}>
						<div>{textBlocks(m.content)}</div>
					</div>
				);
			case "card":
				return (
					<div className="card-note selectable" key={i}>
						<b>{m.data?.title}</b>
						<div>{(m.data?.lines ?? []).join("\n")}</div>
					</div>
				);
			case "compactionSummary":
				return (
					<div className="muted-note" key={i}>
						较早的对话已压缩为摘要
					</div>
				);
			case "branchSummary":
				return (
					<div className="muted-note" key={i}>
						已从分支返回
					</div>
				);
			default:
				return null;
		}
	};
	return (
		<div className="thread">
			{messages.flatMap((m, i) => [render(m, i), footer(i)])}
			{streaming && <RunTimer since={runStartedAt} />}
		</div>
	);
}
