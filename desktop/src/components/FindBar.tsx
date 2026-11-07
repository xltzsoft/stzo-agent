import { useEffect, useRef, useState } from "react";
import { IconChevron, IconSearch } from "./icons";

const highlights = (globalThis as any).CSS?.highlights as Map<string, unknown> | undefined;
const Highlight = (globalThis as any).Highlight as (new (...r: Range[]) => unknown) | undefined;

/**
 * ⌘F: find text in the visible thread. Matches are painted with the CSS Custom Highlight API, so
 * React's DOM is never touched. Collapsed tool output and thinking are not searched.
 */
export function FindBar({ root, version, onClose }: { root: React.RefObject<HTMLElement | null>; version: unknown; onClose: () => void }) {
	const [q, setQ] = useState("");
	const [ranges, setRanges] = useState<Range[]>([]);
	const [idx, setIdx] = useState(0);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		input.current?.focus();
		return () => {
			highlights?.delete("find");
			highlights?.delete("find-current");
		};
	}, []);

	// Re-focus and select when ⌘F is pressed again while open.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "f") {
				e.preventDefault();
				input.current?.focus();
				input.current?.select();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	useEffect(() => {
		const t = setTimeout(() => {
			const el = root.current;
			const query = q.trim().toLowerCase();
			const found: Range[] = [];
			if (el && query) {
				const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
					acceptNode: (n) => ((n.parentElement?.closest(".msg-actions, .step-copy, button.copy") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
				});
				for (let n = walker.nextNode(); n && found.length < 2000; n = walker.nextNode()) {
					const text = (n.nodeValue ?? "").toLowerCase();
					for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + query.length)) {
						const r = document.createRange();
						r.setStart(n, i);
						r.setEnd(n, i + query.length);
						found.push(r);
					}
				}
			}
			setRanges(found);
			setIdx((cur) => (found.length ? Math.min(cur, found.length - 1) : 0));
		}, 120);
		return () => clearTimeout(t);
	}, [q, version, root]);

	useEffect(() => {
		if (!highlights || !Highlight) return;
		if (ranges.length) highlights.set("find", new Highlight(...ranges));
		else highlights.delete("find");
		const cur = ranges[idx];
		if (cur) highlights.set("find-current", new Highlight(cur));
		else highlights.delete("find-current");
	}, [ranges, idx]);

	const go = (i: number) => {
		if (!ranges.length) return;
		const next = (i + ranges.length) % ranges.length;
		setIdx(next);
		const r = ranges[next];
		const host = r.startContainer.parentElement;
		host?.scrollIntoView({ block: "center" });
		// Without highlight support, fall back to selecting the match.
		if (!highlights) {
			const s = window.getSelection();
			s?.removeAllRanges();
			s?.addRange(r);
		}
	};
	// Jump to the first match when the query changes, not when streaming re-scans the thread.
	const scrolledFor = useRef("");
	useEffect(() => {
		const query = q.trim();
		if (!ranges.length || scrolledFor.current === query) return;
		scrolledFor.current = query;
		ranges[idx]?.startContainer.parentElement?.scrollIntoView({ block: "center" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ranges]);

	return (
		<div className="findbar" role="search">
			<IconSearch width={14} />
			<input
				ref={input}
				value={q}
				placeholder="在对话中查找"
				onChange={(e) => setQ(e.target.value)}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
					if (e.key === "Enter") {
						e.preventDefault();
						go(e.shiftKey ? idx - 1 : idx + 1);
					} else if (e.key === "Escape") {
						e.preventDefault();
						onClose();
					}
				}}
			/>
			<span className="count">{q.trim() ? (ranges.length ? `${idx + 1} / ${ranges.length}` : "无结果") : ""}</span>
			<button className="icon-btn" title="上一个 (Shift+Enter)" aria-label="上一个" disabled={!ranges.length} onClick={() => go(idx - 1)}>
				<IconChevron width={14} style={{ transform: "rotate(180deg)" }} />
			</button>
			<button className="icon-btn" title="下一个 (Enter)" aria-label="下一个" disabled={!ranges.length} onClick={() => go(idx + 1)}>
				<IconChevron width={14} />
			</button>
			<button className="icon-btn" title="关闭 (Esc)" aria-label="关闭查找" onClick={onClose}>
				×
			</button>
		</div>
	);
}
