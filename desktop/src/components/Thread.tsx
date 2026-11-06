import { memo, useMemo, useState } from "react";
import { errorText, type Block, type ChatMessage, type ToolRun } from "../lib/rpc";
import { IconChevron, IconChevronRight } from "./icons";
import { Markdown } from "./Markdown";

const rel = (p: unknown, cwd: string) => {
	const s = String(p ?? "");
	return cwd && s.startsWith(`${cwd}/`) ? s.slice(cwd.length + 1) : s;
};
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

function ToolStep({ call, run, cwd }: { call: Extract<Block, { type: "toolCall" }>; run?: ToolRun; cwd: string }) {
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
}: {
	msg: ChatMessage;
	tools: Record<string, ToolRun>;
	cwd: string;
	live: boolean;
	onAction: (a: "recharge" | "login") => void;
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
								<ToolStep key={c.id || i} call={c} run={tools[c.id]} cwd={cwd} />
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
});

function UserMessage({ msg }: { msg: ChatMessage }) {
	const images = Array.isArray(msg.content) ? (msg.content.filter((b) => b.type === "image") as Extract<Block, { type: "image" }>[]) : [];
	return (
		<div className="turn-user">
			<div className="bubble selectable">
				{textBlocks(msg.content)}
				{images.map((im, i) => (
					<img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt="" />
				))}
			</div>
		</div>
	);
}

export function Thread({
	messages,
	tools,
	streaming,
	cwd,
	onAction,
}: {
	messages: ChatMessage[];
	tools: Record<string, ToolRun>;
	streaming: boolean;
	cwd: string;
	onAction: (a: "recharge" | "login") => void;
}) {
	// Tool results from history (no live run info): synthesize runs from toolResult messages.
	const allTools = useMemo(() => {
		const map: Record<string, ToolRun> = {};
		for (const m of messages) {
			if (m.role === "toolResult" && m.toolCallId) {
				map[m.toolCallId] = { running: false, result: { content: m.content as Block[], details: m.details }, isError: m.isError };
			}
		}
		return { ...map, ...tools };
	}, [messages, tools]);

	const lastAssistant = messages.length - 1;
	return (
		<div className="thread">
			{messages.map((m, i) => {
				switch (m.role) {
					case "user":
						return <UserMessage key={i} msg={m} />;
					case "assistant":
						return <AssistantMessage key={i} msg={m} tools={allTools} cwd={cwd} live={streaming && i === lastAssistant} onAction={onAction} />;
					case "bashExecution":
						return (
							<div className="trace" key={i}>
								<ToolStep
									call={{ type: "toolCall", id: `bash-${i}`, name: "bash", arguments: { command: m.command } }}
									run={{ running: false, isError: (m.exitCode ?? 0) !== 0, result: { content: [{ type: "text", text: m.output ?? "" }] } }}
									cwd={cwd}
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
			})}
			{streaming && messages[messages.length - 1]?.role !== "assistant" && (
				<div className="assistant">
					<div className="thinking live">
						<button disabled>
							<span className="spinner" style={{ width: 11, height: 11 }} /> 正在处理…
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
