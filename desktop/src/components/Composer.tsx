import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Command, Stats } from "../lib/rpc";
import { IconEdit, IconFile, IconImage, IconSend, IconStop } from "./icons";

export interface Attachment {
	data: string;
	mimeType: string;
}

const HIDDEN_COMMANDS = new Set(["login", "logout", "quit", "exit", "theme", "hotkeys", "settings", "llama", "mcp", "signin", "signout", "update", "copy", "export", "share", "resume", "tree", "fork", "clone", "reload", "changelog", "scoped-models"]);
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";

function readImage(file: File): Promise<Attachment> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => {
			const s = String(r.result);
			resolve({ data: s.slice(s.indexOf(",") + 1), mimeType: file.type || "image/png" });
		};
		r.onerror = () => reject(r.error);
		r.readAsDataURL(file);
	});
}

// ---- drafts: unsent text per session, kept across restarts -------------------------------------

const DRAFTS = "stzo.drafts";
function loadDrafts(): Record<string, string> {
	try {
		return JSON.parse(localStorage.getItem(DRAFTS) || "{}");
	} catch {
		return {};
	}
}
function saveDraft(key: string, text: string) {
	const all = loadDrafts();
	if (text.trim()) all[key] = text;
	else delete all[key];
	const keys = Object.keys(all);
	for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete all[k];
	try {
		localStorage.setItem(DRAFTS, JSON.stringify(all));
	} catch {}
}

// ---- @ file mentions -----------------------------------------------------------------------------

/** Subsequence match scored toward the file name, contiguous runs and short paths. */
export function fuzzyScore(path: string, q: string): number {
	if (!q) return 1;
	const p = path.toLowerCase();
	const query = q.toLowerCase();
	const base = p.slice(p.lastIndexOf("/") + 1);
	if (base.startsWith(query)) return 1000 - p.length;
	if (base.includes(query)) return 800 - p.length;
	if (p.includes(query)) return 600 - p.length;
	let score = 0;
	let j = 0;
	let run = 0;
	for (let i = 0; i < p.length && j < query.length; i++) {
		if (p[i] === query[j]) {
			j++;
			run++;
			score += run * 2;
		} else run = 0;
	}
	return j === query.length ? score - p.length / 10 : -1;
}

const mentionAt = (text: string, caret: number) => /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));

interface Option {
	key: string;
	label: React.ReactNode;
	desc?: string;
	apply: () => void;
	/** Enter on an exact match should send instead of re-completing. */
	exact?: boolean;
}

function ContextRing({ ctx, stats }: { ctx: NonNullable<Stats["contextUsage"]>; stats?: Stats }) {
	const pct = Math.max(0, Math.min(100, ctx.percent));
	const tone = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";
	const r = 6;
	const c = 2 * Math.PI * r;
	return (
		<span className={`ctx-ring ${tone}`} tabIndex={0} aria-label={`上下文已用 ${Math.round(pct)}%`}>
			<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
				<circle cx="8" cy="8" r={r} className="track" />
				<circle cx="8" cy="8" r={r} className="fill" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 8 8)" />
			</svg>
			<span>{Math.round(pct)}%</span>
			<span className="ctx-card" role="tooltip">
				<b>上下文</b>
				<span>
					{ctx.tokens.toLocaleString()} / {ctx.contextWindow.toLocaleString()} tokens（{Math.round(pct)}%）
				</span>
				{stats && stats.cost > 0 && <span>本会话花费 ${stats.cost.toFixed(stats.cost < 1 ? 3 : 2)}</span>}
				<span className="tip">{pct >= 70 ? "快满了：输入 /compact 压缩较早的对话，或开一个新对话。" : "接近上限时会自动压缩较早的对话。"}</span>
			</span>
		</span>
	);
}

export function Composer({
	streaming,
	disabled,
	placeholder,
	commands,
	editorText,
	queue,
	widgets,
	statuses,
	stats,
	supportsImages,
	draftKey,
	listFiles,
	onSend,
	onFollowUp,
	onRemoveQueued,
	onAbort,
	focusKey,
}: {
	streaming: boolean;
	disabled?: boolean;
	placeholder: string;
	commands: Command[];
	editorText?: { text: string; seq: number };
	queue: { steering: string[]; followUp: string[] };
	widgets: Record<string, string[]>;
	statuses: Record<string, string>;
	stats?: Stats;
	supportsImages: boolean;
	/** Where the unsent draft is kept; one per session. */
	draftKey?: string;
	/** Project files for @ mentions (relative paths). */
	listFiles?: () => Promise<string[]>;
	/** Resolves false when the message was not accepted; the composer then restores it. */
	onSend: (text: string, images: Attachment[]) => Promise<boolean> | boolean | void;
	/** Queue a message to send after the agent finishes (instead of steering it now). */
	onFollowUp?: (text: string, images: Attachment[]) => Promise<boolean> | boolean | void;
	onRemoveQueued?: (kind: "steering" | "followUp", index: number) => Promise<string | undefined>;
	onAbort: () => void;
	focusKey?: unknown;
}) {
	const [text, setText] = useState(() => (draftKey ? loadDrafts()[draftKey] ?? "" : ""));
	const [images, setImages] = useState<Attachment[]>([]);
	const [sel, setSel] = useState(0);
	const [caret, setCaret] = useState(0);
	const [files, setFiles] = useState<string[]>();
	const [dismissed, setDismissed] = useState<string>();
	const ta = useRef<HTMLTextAreaElement>(null);
	const file = useRef<HTMLInputElement>(null);
	const composing = useRef(false);
	const filesReq = useRef<Promise<void> | undefined>(undefined);

	// Drafts: swap when the session changes, save as the user types.
	const draftRef = useRef(draftKey);
	const textRef = useRef(text);
	textRef.current = text;
	useEffect(() => {
		if (draftRef.current === draftKey) return;
		if (draftRef.current) saveDraft(draftRef.current, textRef.current);
		draftRef.current = draftKey;
		setText(draftKey ? loadDrafts()[draftKey] ?? "" : "");
		setImages([]);
	}, [draftKey]);
	useEffect(() => {
		if (!draftKey) return;
		const t = setTimeout(() => saveDraft(draftKey, text), 300);
		return () => clearTimeout(t);
	}, [text, draftKey]);
	useEffect(() => () => void (draftRef.current && saveDraft(draftRef.current, textRef.current)), []);

	// The file list belongs to the project; drop it when the source changes.
	useEffect(() => {
		setFiles(undefined);
		filesReq.current = undefined;
	}, [listFiles]);

	useEffect(() => {
		if (editorText) {
			setText(editorText.text);
			requestAnimationFrame(() => {
				const el = ta.current;
				if (!el) return;
				el.focus();
				el.setSelectionRange(el.value.length, el.value.length);
			});
		}
	}, [editorText?.seq]);

	useEffect(() => {
		ta.current?.focus();
	}, [focusKey]);

	const autosize = () => {
		const el = ta.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
	};
	useLayoutEffect(autosize, [text]);
	useEffect(() => {
		const el = ta.current;
		if (!el) return;
		let w = el.clientWidth;
		const ro = new ResizeObserver(() => {
			if (el.clientWidth !== w) {
				w = el.clientWidth;
				autosize();
			}
		});
		ro.observe(el);
		void document.fonts?.ready.then(autosize);
		return () => ro.disconnect();
	}, []);

	const mention = useMemo(() => mentionAt(text, caret), [text, caret]);
	useEffect(() => {
		if (!mention || files || filesReq.current || !listFiles) return;
		filesReq.current = listFiles()
			.then((f) => setFiles(f))
			.catch(() => setFiles([]));
	}, [mention, files, listFiles]);

	const replaceRange = (from: number, to: number, insert: string) => {
		const next = text.slice(0, from) + insert + text.slice(to);
		setText(next);
		const pos = from + insert.length;
		setCaret(pos);
		requestAnimationFrame(() => ta.current?.setSelectionRange(pos, pos));
	};

	const options = useMemo<Option[]>(() => {
		const slash = /^\/(\S*)$/.exec(text);
		if (slash) {
			const q = slash[1].toLowerCase();
			return commands
				.filter((c) => !HIDDEN_COMMANDS.has(c.name) && c.name.toLowerCase().includes(q))
				.slice(0, 12)
				.map((c) => ({
					key: `/${c.name}`,
					label: <b>/{c.name}</b>,
					desc: c.description,
					exact: text === `/${c.name}`,
					apply: () => {
						setText(`/${c.name} `);
						setCaret(c.name.length + 2);
					},
				}));
		}
		if (mention && listFiles) {
			const q = mention[2];
			const key = `${caret}:${q}`;
			if (dismissed === key) return [];
			const start = caret - q.length - 1;
			const hits = (files ?? [])
				.map((f) => [f, fuzzyScore(f, q)] as const)
				.filter(([, s]) => s >= 0)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10);
			return hits.map(([f]) => {
				const slashAt = f.lastIndexOf("/");
				return {
					key: f,
					label: (
						<>
							<IconFile width={13} />
							<b>{f.slice(slashAt + 1)}</b>
						</>
					),
					desc: slashAt > 0 ? f.slice(0, slashAt) : undefined,
					apply: () => replaceRange(start, caret, `@${/\s/.test(f) ? `"${f}"` : f} `),
				};
			});
		}
		return [];
	}, [text, commands, mention, files, caret, dismissed, listFiles]);
	const loadingFiles = !!mention && !!listFiles && !files && !/^\//.test(text);

	useEffect(() => setSel(0), [options.length, mention?.[2]]);

	const submit = (mode: "send" | "followUp" = "send") => {
		const t = text.trim();
		if ((!t && !images.length) || disabled) return;
		const sentImages = images;
		setText("");
		setImages([]);
		if (draftKey) saveDraft(draftKey, "");
		const fn = mode === "followUp" && onFollowUp ? onFollowUp : onSend;
		void Promise.resolve(fn(t, sentImages)).then((ok) => {
			if (ok !== false) return;
			// Put the message back unless the user already started typing something new.
			setText((cur) => cur || t);
			setImages((cur) => (cur.length ? cur : sentImages));
		});
	};

	const addFiles = async (files: FileList | File[]) => {
		const imgs = [...files].filter((f) => f.type.startsWith("image/")).slice(0, 6);
		if (!imgs.length) return;
		const read = await Promise.all(imgs.map(readImage));
		setImages((cur) => [...cur, ...read].slice(0, 6));
	};

	const editQueued = async (kind: "steering" | "followUp", i: number) => {
		const removed = await onRemoveQueued?.(kind, i);
		if (removed === undefined) return;
		setText((cur) => (cur.trim() ? `${removed}\n${cur}` : removed));
		ta.current?.focus();
	};

	const ctx = stats?.contextUsage;
	const statusList = Object.entries(statuses).filter(([k, v]) => v && k !== "stzo");
	const queued = [...queue.steering.map((t, i) => ({ t, i, kind: "steering" as const })), ...queue.followUp.map((t, i) => ({ t, i, kind: "followUp" as const }))];
	const syncCaret = (e: React.SyntheticEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart ?? 0);

	return (
		<div className="composer-wrap">
			<div className="composer-col">
				{Object.keys(widgets).length > 0 && (
					<div className="widgets">
						{Object.entries(widgets).map(([k, lines]) => (
							<div className="widget selectable" key={k}>
								{lines.join("\n")}
							</div>
						))}
					</div>
				)}
				{queued.length > 0 && (
					<div className="queue" aria-label="排队中的消息">
						{queued.map((q) => (
							<div className="queue-item" key={`${q.kind}${q.i}`}>
								<span className="kind">{q.kind === "steering" ? "下一步插入" : "完成后发送"}</span>
								<span className="t" title={q.t}>
									{q.t}
								</span>
								{onRemoveQueued && (
									<>
										<button title="取回编辑" aria-label="取回编辑" onClick={() => void editQueued(q.kind, q.i)}>
											<IconEdit width={12} />
										</button>
										<button title="删除" aria-label="删除" onClick={() => void onRemoveQueued(q.kind, q.i)}>
											×
										</button>
									</>
								)}
							</div>
						))}
					</div>
				)}
				{(options.length > 0 || loadingFiles) && (
					<div className="slash" role="listbox">
						{loadingFiles && <div className="option muted">正在读取项目文件…</div>}
						{options.map((o, i) => (
							<button
								key={o.key}
								role="option"
								aria-selected={i === sel}
								className={`option${i === sel ? " focus" : ""}`}
								onMouseEnter={() => setSel(i)}
								onMouseDown={(e) => {
									e.preventDefault();
									o.apply();
								}}
							>
								<span className="label">{o.label}</span>
								{o.desc && <span>{o.desc}</span>}
							</button>
						))}
					</div>
				)}
				<div
					className="composer"
					onDragOver={(e) => supportsImages && e.preventDefault()}
					onDrop={(e) => {
						if (!supportsImages) return;
						e.preventDefault();
						void addFiles(e.dataTransfer.files);
					}}
				>
					{images.length > 0 && (
						<div className="attachments">
							{images.map((im, i) => (
								<div className="attachment" key={i}>
									<img src={`data:${im.mimeType};base64,${im.data}`} alt="" />
									<button aria-label="移除图片" onClick={() => setImages(images.filter((_, j) => j !== i))}>
										×
									</button>
								</div>
							))}
						</div>
					)}
					<textarea
						ref={ta}
						rows={1}
						value={text}
						placeholder={placeholder}
						disabled={disabled}
						data-composer
						onChange={(e) => {
							setText(e.target.value);
							syncCaret(e);
						}}
						onSelect={syncCaret}
						onClick={syncCaret}
						onBlur={() => setDismissed(mention ? `${caret}:${mention[2]}` : undefined)}
						onCompositionStart={() => (composing.current = true)}
						onCompositionEnd={() => {
							// WebKit fires compositionend before the Enter keydown that confirmed the
							// candidate; keep the guard up until that keydown has passed.
							setTimeout(() => (composing.current = false), 0);
						}}
						onPaste={(e) => {
							if (!supportsImages) return;
							// Screenshots pasted in WKWebView may only show up in items, not files.
							const files = [...e.clipboardData.items]
								.filter((it) => it.kind === "file" && it.type.startsWith("image/"))
								.map((it) => it.getAsFile())
								.filter((f): f is File => !!f);
							if (files.length) {
								e.preventDefault();
								void addFiles(files);
							}
						}}
						onKeyDown={(e) => {
							if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
							if (options.length) {
								if (e.key === "ArrowDown") {
									e.preventDefault();
									return setSel((sel + 1) % options.length);
								}
								if (e.key === "ArrowUp") {
									e.preventDefault();
									return setSel((sel - 1 + options.length) % options.length);
								}
								if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !options[sel].exact)) {
									e.preventDefault();
									return options[sel].apply();
								}
								if (e.key === "Escape") {
									e.preventDefault();
									if (/^\//.test(text)) return setText("");
									return setDismissed(mention ? `${caret}:${mention[2]}` : undefined);
								}
							}
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								submit(streaming && (e.altKey || e.metaKey || e.ctrlKey) ? "followUp" : "send");
							} else if (e.key === "Escape" && streaming) {
								onAbort();
							}
						}}
					/>
					<div className="composer-row">
						<div className="hint">
							{streaming ? (
								<>
									<span>
										<kbd>Enter</kbd> 在下一步插入
									</span>
									{onFollowUp && (
										<span>
											<kbd>{isMac ? "⌥" : "Alt"}</kbd> + <kbd>Enter</kbd> 完成后发送
										</span>
									)}
									<span>
										<kbd>Esc</kbd> 停止
									</span>
								</>
							) : (
								<>
									<span>
										<kbd>Enter</kbd> 发送
									</span>
									<span>
										<kbd>Shift</kbd> + <kbd>Enter</kbd> 换行
									</span>
									<span>
										<kbd>/</kbd> 命令
									</span>
									{listFiles && (
										<span>
											<kbd>@</kbd> 文件
										</span>
									)}
								</>
							)}
						</div>
						{supportsImages && (
							<>
								<input
									ref={file}
									type="file"
									accept="image/*"
									multiple
									hidden
									onChange={(e) => {
										const input = e.currentTarget;
										if (input.files) void addFiles([...input.files]);
										input.value = ""; // allow picking the same file again
									}}
								/>
								<button className="icon-btn" title="添加图片" onClick={() => file.current?.click()} disabled={disabled}>
									<IconImage />
								</button>
							</>
						)}
						{streaming && !text.trim() && !images.length ? (
							<button className="send stop" title="停止 (Esc)" onClick={onAbort}>
								<IconStop />
							</button>
						) : (
							<button className="send" title={streaming ? "在下一步插入" : "发送"} onClick={() => submit()} disabled={disabled || (!text.trim() && !images.length)}>
								<IconSend />
							</button>
						)}
					</div>
				</div>
				<div className="statusline">
					{statusList.map(([k, v]) => (
						<span key={k} className="s-on">
							{v}
						</span>
					))}
					{ctx && ctx.contextWindow > 0 && <ContextRing ctx={ctx} stats={stats} />}
					{stats && stats.cost > 0 && <span>本会话 ${stats.cost.toFixed(stats.cost < 1 ? 3 : 2)}</span>}
				</div>
			</div>
		</div>
	);
}
