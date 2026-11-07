import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyScore } from "./Composer";
import { IconSearch } from "./icons";

export interface PaletteItem {
	id: string;
	group: string;
	title: string;
	/** Extra words to match on (not shown). */
	keywords?: string;
	/** Right-aligned detail: a shortcut or the current state. */
	hint?: string;
	run: () => void;
}

/** ⌘K: one searchable list of everything the app can do. */
export function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
	const [q, setQ] = useState("");
	const [sel, setSel] = useState(0);
	const list = useRef<HTMLDivElement>(null);

	const shown = useMemo(() => {
		const query = q.trim();
		if (!query) return items;
		return items
			.map((it) => [it, Math.max(fuzzyScore(it.title, query), fuzzyScore(`${it.group} ${it.title} ${it.keywords ?? ""}`, query) - 50)] as const)
			.filter(([, s]) => s >= 0)
			.sort((a, b) => b[1] - a[1])
			.map(([it]) => it);
	}, [items, q]);

	useEffect(() => setSel(0), [q]);
	useEffect(() => {
		list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
	}, [sel]);

	const run = (it?: PaletteItem) => {
		if (!it) return;
		onClose();
		it.run();
	};

	let lastGroup = "";
	return (
		<div className="scrim palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="palette" role="dialog" aria-label="命令面板">
				<div className="palette-input">
					<IconSearch width={15} />
					<input
						autoFocus
						value={q}
						placeholder="搜索命令、对话、模型…"
						onChange={(e) => setQ(e.target.value)}
						onKeyDown={(e) => {
							if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setSel((s) => Math.min(s + 1, shown.length - 1));
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								setSel((s) => Math.max(s - 1, 0));
							} else if (e.key === "Enter") {
								e.preventDefault();
								run(shown[sel]);
							} else if (e.key === "Escape") {
								e.preventDefault();
								onClose();
							}
						}}
					/>
				</div>
				<div className="palette-list" ref={list} role="listbox">
					{shown.length === 0 && <div className="palette-empty">没有匹配的结果</div>}
					{shown.map((it, i) => {
						const head = !q.trim() && it.group !== lastGroup ? it.group : null;
						lastGroup = it.group;
						return (
							<div key={it.id}>
								{head && <div className="palette-group">{head}</div>}
								<button
									data-i={i}
									role="option"
									aria-selected={i === sel}
									className={`palette-item${i === sel ? " on" : ""}`}
									onMouseMove={() => sel !== i && setSel(i)}
									onClick={() => run(it)}
								>
									<span className="t">{it.title}</span>
									{q.trim() && <span className="g">{it.group}</span>}
									{it.hint && <span className="h">{it.hint}</span>}
								</button>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
