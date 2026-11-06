import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Group } from "../lib/api";
import type { Model } from "../lib/rpc";
import { IconCheck, IconChevron, IconSidebar } from "./icons";

export const THINKING_LABEL: Record<string, string> = {
	off: "关闭",
	minimal: "极少",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "超高",
	max: "最大",
};

function Picker({ label, children, disabled, title }: { label: ReactNode; children: (close: () => void) => ReactNode; disabled?: boolean; title?: string }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
		const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		window.addEventListener("mousedown", close);
		window.addEventListener("keydown", esc);
		return () => {
			window.removeEventListener("mousedown", close);
			window.removeEventListener("keydown", esc);
		};
	}, [open]);
	return (
		<div className="picker no-drag" ref={ref}>
			<button className="picker-btn" onClick={() => setOpen(!open)} disabled={disabled} aria-expanded={open} title={title}>
				{label}
				<IconChevron width={12} />
			</button>
			{open && <div className="popover">{children(() => setOpen(false))}</div>}
		</div>
	);
}

const perM = (v: number) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));

export function Topbar({
	title,
	subtitle,
	collapsed,
	onExpand,
	model,
	models,
	groups,
	thinkingLevel,
	thinkingLevels,
	onModel,
	onThinking,
	busy,
}: {
	title: string;
	subtitle?: string;
	collapsed: boolean;
	onExpand: () => void;
	model?: Model;
	models: Model[];
	groups: Group[];
	thinkingLevel: string;
	thinkingLevels: string[];
	onModel: (m: Model) => void;
	onThinking: (l: string) => void;
	busy: boolean;
}) {
	const byProvider = new Map<string, Model[]>();
	for (const m of models) {
		const l = byProvider.get(m.provider) ?? [];
		l.push(m);
		byProvider.set(m.provider, l);
	}
	const groupName = (provider: string) => groups.find((g) => g.provider === provider)?.name ?? provider;
	const showGroup = byProvider.size > 1;

	return (
		<header className="topbar drag" data-tauri-drag-region>
			{collapsed && (
				<button className="icon-btn no-drag" title="展开侧栏" onClick={onExpand}>
					<IconSidebar />
				</button>
			)}
			<div className="title" data-tauri-drag-region>
				{title}
				{subtitle && <span>{subtitle}</span>}
			</div>
			{models.length > 0 && (
				<Picker
					disabled={busy}
					title="选择模型"
					label={
						<span className="label">
							{model ? model.name : "选择模型"}
							{model && showGroup && <span className="dim"> {groupName(model.provider)}</span>}
						</span>
					}
				>
					{(close) =>
						[...byProvider.entries()].map(([provider, list]) => (
							<div key={provider}>
								{showGroup && <h5>{groupName(provider)}</h5>}
								{list.map((m) => (
									<button
										key={`${m.provider}/${m.id}`}
										className="option"
										onClick={() => {
											close();
											onModel(m);
										}}
									>
										<span className="check">{model?.id === m.id && model?.provider === m.provider && <IconCheck width={14} />}</span>
										<span>{m.name}</span>
										{m.cost?.input > 0 && (
											<span className="meta" title="每百万 token 价格（输入 / 输出）">
												${perM(m.cost.input)} / ${perM(m.cost.output)}
											</span>
										)}
									</button>
								))}
							</div>
						))
					}
				</Picker>
			)}
			{model?.reasoning && thinkingLevels.length > 1 && (
				<Picker label={<span className="label">思考：{THINKING_LABEL[thinkingLevel] ?? thinkingLevel}</span>} title="思考强度">
					{(close) => (
						<>
							<h5>思考强度</h5>
							{thinkingLevels.map((l) => (
								<button
									key={l}
									className="option"
									onClick={() => {
										close();
										onThinking(l);
									}}
								>
									<span className="check">{l === thinkingLevel && <IconCheck width={14} />}</span>
									{THINKING_LABEL[l] ?? l}
								</button>
							))}
						</>
					)}
				</Picker>
			)}
		</header>
	);
}
