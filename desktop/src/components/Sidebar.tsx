import { useEffect, useRef, useState } from "react";
import { displayName, money, type AccountState, type SessionSummary } from "../lib/api";
import { IconCheck, IconFolder, IconGear, IconPlus, IconSidebar } from "./icons";

export interface Project {
	path: string;
	name: string;
}

export const tildify = (p: string, home?: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

function bucket(ts: number) {
	const d = new Date(ts);
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (ts >= start) return "今天";
	if (ts >= start - 86400_000) return "昨天";
	if (ts >= start - 6 * 86400_000) return "近 7 天";
	if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月`;
	return `${d.getFullYear()} 年`;
}

export function Sidebar({
	platform,
	home,
	project,
	projects,
	sessions,
	activeSession,
	streaming,
	account,
	onPickProject,
	onOpenFolder,
	onNewChat,
	onOpenSession,
	onAccount,
	onRecharge,
	onSettings,
	onLogin,
	onCollapse,
}: {
	platform: string;
	home?: string;
	project?: Project;
	projects: Project[];
	sessions: SessionSummary[];
	activeSession?: string;
	streaming: boolean;
	account?: AccountState;
	onPickProject: (p: Project) => void;
	onOpenFolder: () => void;
	onNewChat: () => void;
	onOpenSession: (s: SessionSummary) => void;
	onAccount: () => void;
	onRecharge: () => void;
	onSettings: () => void;
	onLogin: () => void;
	onCollapse: () => void;
}) {
	const [menu, setMenu] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!menu) return;
		const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
		window.addEventListener("mousedown", close);
		return () => window.removeEventListener("mousedown", close);
	}, [menu]);

	const groups: [string, SessionSummary[]][] = [];
	for (const s of sessions) {
		const b = bucket(s.modified);
		const g = groups.find((x) => x[0] === b);
		if (g) g[1].push(s);
		else groups.push([b, [s]]);
	}
	const mod = platform === "macos" ? "⌘" : "Ctrl";
	const bal = account?.user?.balance;

	return (
		<aside className="sidebar">
			<div className="sidebar-top drag" data-tauri-drag-region>
				{platform !== "macos" && (
					<span className="wordmark">
						STZO <span className="seal" />
					</span>
				)}
				<button className="icon-btn no-drag" title="收起侧栏" onClick={onCollapse}>
					<IconSidebar />
				</button>
			</div>
			{platform === "macos" && (
				<div className="brand-row drag" data-tauri-drag-region>
					<span className="wordmark">
						STZO Agent <span className="seal" />
					</span>
				</div>
			)}

			<div className="project" ref={ref}>
				<button className="project-btn" onClick={() => setMenu(!menu)} aria-expanded={menu}>
					<span className="folder-glyph">{project ? baseName(project.path).slice(0, 1).toUpperCase() : <IconFolder width={14} />}</span>
					<span style={{ minWidth: 0, flex: 1 }}>
						<span className="name" style={{ display: "block" }}>
							{project ? project.name : "选择项目文件夹"}
						</span>
						{project && (
							<span className="path" style={{ display: "block" }}>
								{tildify(project.path, home)}
							</span>
						)}
					</span>
				</button>
				{menu && (
					<div className="popover left" style={{ width: "100%", minWidth: 0 }}>
						{projects.length > 0 && <h5>最近的项目</h5>}
						{projects.map((p) => (
							<button
								key={p.path}
								className="option"
								onClick={() => {
									setMenu(false);
									onPickProject(p);
								}}
							>
								<span className="check">{p.path === project?.path && <IconCheck width={14} />}</span>
								<span style={{ minWidth: 0 }}>
									{p.name}
									<span className="sub" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
										{tildify(p.path, home)}
									</span>
								</span>
							</button>
						))}
						{projects.length > 0 && <hr />}
						<button
							className="option"
							onClick={() => {
								setMenu(false);
								onOpenFolder();
							}}
						>
							<span className="check">
								<IconFolder width={14} />
							</span>
							打开文件夹…
						</button>
					</div>
				)}
			</div>

			<button className="new-chat" onClick={onNewChat} disabled={!project}>
				<IconPlus /> 新对话 <kbd>{mod} N</kbd>
			</button>

			<nav className="sessions" aria-label="历史会话">
				{project && sessions.length === 0 && <div className="empty">这个项目还没有对话。</div>}
				{groups.map(([label, list]) => (
					<div key={label}>
						<h4>{label}</h4>
						{list.map((s) => {
							const active = s.path === activeSession;
							return (
								<button key={s.path} className={`session${active ? " active" : ""}`} title={s.name || s.firstMessage} onClick={() => onOpenSession(s)}>
									{active && streaming && <span className="live" />}
									{s.name || s.firstMessage || "新对话"}
								</button>
							);
						})}
					</div>
				))}
			</nav>

			<div className="account">
				{account?.loggedIn ? (
					<>
						<button className="avatar" style={{ border: 0 }} onClick={onAccount} title="账户">
							{displayName(account.user).slice(0, 1).toUpperCase()}
						</button>
						<button className="who" style={{ border: 0, background: "none", textAlign: "left", padding: 0 }} onClick={onAccount}>
							<b>{displayName(account.user)}</b>
							<span className={`balance${typeof bal === "number" && bal < 1 ? " low" : ""}`}>余额 {money(bal)}</span>
						</button>
						<button className="btn small" onClick={onRecharge}>
							充值
						</button>
					</>
				) : (
					<>
						<div className="who">
							<b>未登录</b>
							<span className="balance">登录后即可使用</span>
						</div>
						<button className="btn small primary" onClick={onLogin}>
							登录
						</button>
					</>
				)}
				<button className="icon-btn" title="设置" onClick={onSettings}>
					<IconGear />
				</button>
			</div>
		</aside>
	);
}
