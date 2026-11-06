import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Command, Stats } from "../lib/rpc";
import { IconImage, IconSend, IconStop } from "./icons";

export interface Attachment {
	data: string;
	mimeType: string;
}

const HIDDEN_COMMANDS = new Set(["login", "logout", "quit", "exit", "theme", "hotkeys", "settings", "llama", "mcp", "signin", "signout", "update", "copy", "export", "share", "resume", "tree", "fork", "clone", "reload", "changelog", "scoped-models"]);

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
	onSend,
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
	onSend: (text: string, images: Attachment[]) => void;
	onAbort: () => void;
	focusKey?: unknown;
}) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<Attachment[]>([]);
	const [sel, setSel] = useState(0);
	const ta = useRef<HTMLTextAreaElement>(null);
	const file = useRef<HTMLInputElement>(null);
	const composing = useRef(false);

	useEffect(() => {
		if (editorText) {
			setText(editorText.text);
			ta.current?.focus();
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

	const slash = useMemo(() => {
		const m = /^\/(\S*)$/.exec(text);
		if (!m) return [];
		const q = m[1].toLowerCase();
		return commands.filter((c) => !HIDDEN_COMMANDS.has(c.name) && c.name.toLowerCase().includes(q)).slice(0, 12);
	}, [text, commands]);

	useEffect(() => setSel(0), [slash.length]);

	const submit = () => {
		const t = text.trim();
		if ((!t && !images.length) || disabled) return;
		onSend(t, images);
		setText("");
		setImages([]);
	};

	const addFiles = async (files: FileList | File[]) => {
		const imgs = [...files].filter((f) => f.type.startsWith("image/")).slice(0, 6);
		if (!imgs.length) return;
		const read = await Promise.all(imgs.map(readImage));
		setImages((cur) => [...cur, ...read].slice(0, 6));
	};

	const ctx = stats?.contextUsage;
	const statusList = Object.entries(statuses).filter(([k, v]) => v && k !== "stzo");
	const queued = [...queue.steering, ...queue.followUp];

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
				{queued.length > 0 && <div className="queue">排队中：{queued.map((q) => (q.length > 60 ? `${q.slice(0, 60)}…` : q)).join(" / ")}</div>}
				{slash.length > 0 && (
					<div className="slash" role="listbox">
						{slash.map((c, i) => (
							<button
								key={c.name}
								className={`option${i === sel ? " focus" : ""}`}
								onMouseDown={(e) => {
									e.preventDefault();
									setText(`/${c.name} `);
								}}
							>
								<b>/{c.name}</b>
								<span>{c.description}</span>
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
						onChange={(e) => setText(e.target.value)}
						onCompositionStart={() => (composing.current = true)}
						onCompositionEnd={() => (composing.current = false)}
						onPaste={(e) => {
							if (!supportsImages) return;
							const files = [...e.clipboardData.files];
							if (files.some((f) => f.type.startsWith("image/"))) {
								e.preventDefault();
								void addFiles(files);
							}
						}}
						onKeyDown={(e) => {
							if (composing.current || e.nativeEvent.isComposing) return;
							if (slash.length) {
								if (e.key === "ArrowDown") {
									e.preventDefault();
									return setSel((sel + 1) % slash.length);
								}
								if (e.key === "ArrowUp") {
									e.preventDefault();
									return setSel((sel - 1 + slash.length) % slash.length);
								}
								if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && text !== `/${slash[sel].name}`)) {
									e.preventDefault();
									return setText(`/${slash[sel].name} `);
								}
							}
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								submit();
							} else if (e.key === "Escape" && streaming) {
								onAbort();
							}
						}}
					/>
					<div className="composer-row">
						<div className="hint">
							{streaming ? (
								<>
									<span>继续输入会在下一步插入指令</span>
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
								</>
							)}
						</div>
						{supportsImages && (
							<>
								<input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} />
								<button className="icon-btn" title="添加图片" onClick={() => file.current?.click()} disabled={disabled}>
									<IconImage />
								</button>
							</>
						)}
						{streaming && !text.trim() ? (
							<button className="send stop" title="停止" onClick={onAbort}>
								<IconStop />
							</button>
						) : (
							<button className="send" title="发送" onClick={submit} disabled={disabled || (!text.trim() && !images.length)}>
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
					{ctx && ctx.contextWindow > 0 && (
						<span title={`${ctx.tokens.toLocaleString()} / ${ctx.contextWindow.toLocaleString()} tokens`}>上下文 {Math.round(ctx.percent)}%</span>
					)}
					{stats && stats.cost > 0 && <span>本会话 ${stats.cost.toFixed(stats.cost < 1 ? 3 : 2)}</span>}
				</div>
			</div>
		</div>
	);
}
