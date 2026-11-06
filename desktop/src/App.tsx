import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { LoginDialog, RechargeDialog, SettingsDialog, UiRequestDialog } from "./components/Dialogs";
import { baseName, Sidebar, type Project } from "./components/Sidebar";
import { Thread } from "./components/Thread";
import { Topbar } from "./components/Topbar";
import { api, type AccountState, type ClientConfig, type SessionSummary } from "./lib/api";
import { appEnv, appVersion, checkAppUpdate, openExternal, pickFolder, type AppEnv, type UpdateInfo } from "./lib/native";
import { Agent, useAgent, type Notice } from "./lib/rpc";

const LS = {
	projects: "stzo.projects",
	project: "stzo.project",
	theme: "stzo.theme",
	sidebar: "stzo.sidebar",
};
const load = <T,>(k: string, d: T): T => {
	try {
		const v = localStorage.getItem(k);
		return v ? (JSON.parse(v) as T) : d;
	} catch {
		return d;
	}
};
const save = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));

type UpdateState = { state: "idle" | "checking" | "none" | "available" | "installing" | "error"; info?: UpdateInfo; progress?: number; error?: string };

const STARTERS = [
	{ text: "梳理这个项目的结构，告诉我从哪里读起", hint: "了解代码" },
	{ text: "运行测试，找出失败原因并修复", hint: "修复问题" },
	{ text: "检查最近的改动，指出潜在的 bug", hint: "代码审查" },
	{ text: "/plan ", hint: "先只读规划，再动手" },
];

export function App() {
	const [env, setEnv] = useState<AppEnv>();
	const [bootError, setBootError] = useState<string>();
	const [account, setAccount] = useState<AccountState>();
	const [config, setConfig] = useState<ClientConfig>();
	const [projects, setProjects] = useState<Project[]>(() => load(LS.projects, []));
	const [project, setProject] = useState<Project | undefined>(() => load<Project | undefined>(LS.project, undefined));
	const [agent, setAgent] = useState<Agent>();
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [notices, setNotices] = useState<Notice[]>([]);
	const [dialog, setDialog] = useState<null | "login" | "recharge" | "settings" | "account">(null);
	const [theme, setTheme] = useState<string>(() => load(LS.theme, "system"));
	const [collapsed, setCollapsed] = useState<boolean>(() => load(LS.sidebar, false));
	const [version, setVersion] = useState("");
	const [update, setUpdate] = useState<UpdateState>({ state: "idle" });
	const [updateDismissed, setUpdateDismissed] = useState(false);
	const lastAccountRefresh = useRef(0);
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);

	const toast = useCallback((n: Omit<Notice, "id"> & { id?: number }) => {
		const id = n.id ?? Date.now() + Math.random();
		setNotices((cur) => [...cur.slice(-3), { ...n, id }]);
		setTimeout(() => setNotices((cur) => cur.filter((x) => x.id !== id)), n.tone === "error" ? 7000 : 4000);
	}, []);

	// ---- boot -----------------------------------------------------------------------------
	useEffect(() => {
		appEnv()
			.then((e) => {
				setEnv(e);
				document.documentElement.classList.add(`platform-${e.platform}`);
			})
			.catch((e) => setBootError(String(e)));
		void appVersion().then(setVersion);
	}, []);

	const refreshAccount = useCallback(async () => {
		lastAccountRefresh.current = Date.now();
		try {
			const a = await api.account();
			setAccount(a);
			if (a.expired) toast({ text: "登录已过期，请重新登录", tone: "warning" });
			return a;
		} catch (e) {
			toast({ text: `读取账户失败：${(e as Error).message}`, tone: "error" });
		}
	}, [toast]);

	useEffect(() => {
		if (!env) return;
		void refreshAccount();
		api.config().then(setConfig).catch(() => {});
	}, [env, refreshAccount]);

	// ---- theme ----------------------------------------------------------------------------
	useEffect(() => {
		save(LS.theme, theme);
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			const dark = theme === "dark" || (theme === "system" && mq.matches);
			document.documentElement.dataset.theme = dark ? "dark" : "light";
		};
		apply();
		mq.addEventListener("change", apply);
		return () => mq.removeEventListener("change", apply);
	}, [theme]);

	useEffect(() => save(LS.sidebar, collapsed), [collapsed]);

	// Narrow windows: give the conversation the room, the sidebar comes back with ⌘B / the toggle.
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 720px)");
		const apply = () => mq.matches && setCollapsed(true);
		apply();
		mq.addEventListener("change", apply);
		return () => mq.removeEventListener("change", apply);
	}, []);

	// ---- updates --------------------------------------------------------------------------
	const checkUpdate = useCallback(async (manual: boolean) => {
		setUpdate({ state: "checking" });
		try {
			const info = await checkAppUpdate();
			if (!info) return setUpdate({ state: manual ? "none" : "idle" });
			const wrapped: UpdateInfo = {
				...info,
				install: async () => {
					setUpdate((u) => ({ ...u, state: "installing", progress: 0 }));
					try {
						await info.install((p) => setUpdate((u) => ({ ...u, progress: p })));
					} catch (e) {
						setUpdate({ state: "error", error: (e as Error).message ?? String(e) });
					}
				},
			};
			setUpdate({ state: "available", info: wrapped });
		} catch (e) {
			setUpdate(manual ? { state: "error", error: String((e as Error)?.message ?? e) } : { state: "idle" });
		}
	}, []);

	useEffect(() => {
		const t = setTimeout(() => void checkUpdate(false), 4000);
		const iv = setInterval(() => void checkUpdate(false), 6 * 3600_000);
		return () => {
			clearTimeout(t);
			clearInterval(iv);
		};
	}, [checkUpdate]);

	// ---- projects & agent -----------------------------------------------------------------
	const refreshSessions = useCallback(async (cwd?: string) => {
		if (!cwd) return setSessions([]);
		try {
			setSessions(await api.sessions(cwd));
		} catch {
			/* keep the old list */
		}
	}, []);

	const startAgent = useCallback(
		(cwd: string, sessionPath?: string) => {
			const a = new Agent(cwd, (n) => toast(n));
			let timer: ReturnType<typeof setTimeout> | undefined;
			a.onSessionChanged = () => {
				clearTimeout(timer);
				timer = setTimeout(() => void refreshSessions(cwd), 400);
			};
			a.onSettled = () => {
				if (Date.now() - lastAccountRefresh.current > 15_000) void refreshAccount();
			};
			setAgent((old) => {
				void old?.dispose();
				return a;
			});
			void a.start(sessionPath);
			return a;
		},
		[toast, refreshSessions, refreshAccount],
	);

	useEffect(() => {
		if (!env || !project) return;
		save(LS.project, project);
		startAgent(project.path);
		void refreshSessions(project.path);
	}, [env, project?.path]);

	useEffect(() => () => void agent?.dispose(), []);

	const restartAgent = useCallback(() => {
		if (!project) return;
		startAgent(project.path, agent?.state.sessionFile);
	}, [project, agent, startAgent]);

	const openProject = useCallback((p: Project) => {
		setProjects((cur) => {
			const next = [p, ...cur.filter((x) => x.path !== p.path)].slice(0, 12);
			save(LS.projects, next);
			return next;
		});
		setProject(p);
	}, []);

	const openFolder = useCallback(async () => {
		const path = await pickFolder(project?.path ?? env?.home);
		if (path) openProject({ path, name: baseName(path) });
	}, [project, env, openProject]);

	// ---- agent state ----------------------------------------------------------------------
	const st = useAgent(agent, (s) => s);
	const phase = agent ? st.phase : undefined;
	const messages = agent ? st.messages : [];
	const streaming = agent ? st.streaming : false;

	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [messages, st?.tools, streaming]);

	const newChat = useCallback(async () => {
		if (!agent || agent.state.phase !== "ready") return;
		if (agent.state.streaming) await agent.abort();
		try {
			await agent.newSession();
			stick.current = true;
		} catch (e) {
			toast({ text: (e as Error).message, tone: "error" });
		}
	}, [agent, toast]);

	const openSession = useCallback(
		async (s: SessionSummary) => {
			if (!agent || s.path === agent.state.sessionFile) return;
			if (agent.state.phase !== "ready") return startAgent(agent.state.cwd, s.path);
			if (agent.state.streaming) await agent.abort();
			try {
				await agent.switchSession(s.path);
				stick.current = true;
			} catch (e) {
				toast({ text: (e as Error).message, tone: "error" });
			}
		},
		[agent, startAgent, toast],
	);

	const send = useCallback(
		async (text: string, images: { data: string; mimeType: string }[]) => {
			if (!agent) return;
			stick.current = true;
			try {
				const d = await agent.prompt(text, images);
				if (d === "handled") void agent.refresh();
			} catch (e) {
				toast({ text: (e as Error).message, tone: "error" });
			}
		},
		[agent, toast],
	);

	// ---- keyboard -------------------------------------------------------------------------
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = env?.platform === "macos" ? e.metaKey : e.ctrlKey;
			if (!mod) return;
			if (e.key === "n") {
				e.preventDefault();
				void newChat();
			} else if (e.key === ",") {
				e.preventDefault();
				setDialog("settings");
			} else if (e.key === "b") {
				e.preventDefault();
				setCollapsed((c) => !c);
			} else if (e.key === "o") {
				e.preventDefault();
				void openFolder();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [env, newChat, openFolder]);

	// ---- render ---------------------------------------------------------------------------
	const loggedIn = !!account?.loggedIn;
	const title = useMemo(() => {
		if (!agent) return project?.name ?? "STZO Agent";
		if (st.sessionName) return st.sessionName;
		const first = messages.find((m) => m.role === "user");
		const t = first ? (typeof first.content === "string" ? first.content : (first.content ?? []).map((b: any) => b.text ?? "").join("")) : "";
		return t ? t.slice(0, 60) : "新对话";
	}, [agent, st?.sessionName, messages, project]);

	if (bootError)
		return (
			<div className="boot">
				<div style={{ maxWidth: 420, textAlign: "center" }}>
					<h2 className="wordmark" style={{ justifyContent: "center" }}>
						STZO Agent <span className="seal" />
					</h2>
					<p className="selectable">{bootError}</p>
				</div>
			</div>
		);
	if (!env) return <div className="boot">正在启动…</div>;

	const balanceLow = loggedIn && typeof account?.user?.balance === "number" && account.user.balance < 0.5;
	const dialogReq = agent ? st.dialogs[0] : undefined;
	const modelReady = !!st?.model;

	let body: React.ReactNode;
	if (!project) {
		body = (
			<div className="welcome">
				<h1>
					打开一个项目文件夹
					<span className="seal" />
				</h1>
				<p>智能体会在这个文件夹里阅读代码、运行命令、修改文件。每个项目有自己独立的对话记录。</p>
				<div className="gate">
					<button className="btn primary" onClick={() => void openFolder()}>
						打开文件夹
					</button>
				</div>
			</div>
		);
	} else if (!loggedIn && account) {
		body = (
			<div className="welcome">
				<h1>
					登录后开始使用
					<span className="seal" />
				</h1>
				<p>STZO Agent 使用你在 gc.stzo.cn 的账户余额调用 Claude 等模型。登录只需在浏览器里确认一次。</p>
				<div className="gate">
					<button className="btn primary" onClick={() => setDialog("login")}>
						在浏览器中登录
					</button>
					{config?.register_url && (
						<button className="btn ghost" onClick={() => void openExternal(config.register_url)}>
							注册账号
						</button>
					)}
				</div>
			</div>
		);
	} else if (messages.length === 0 && !streaming) {
		body = (
			<div className="welcome">
				<h1>
					{project.name}
					<span className="seal" />
				</h1>
				<p>描述你想完成的事。智能体会先读懂代码，再动手修改，每一步都会显示在这里。</p>
				<div className="starters">
					{STARTERS.map((s) => (
						<button
							key={s.text}
							className="starter"
							disabled={phase !== "ready" || !modelReady}
							onClick={() => (s.text.endsWith(" ") ? agent?.setEditorText(s.text) : void send(s.text, []))}
						>
							{s.text.trim()}
							<small>{s.hint}</small>
						</button>
					))}
				</div>
			</div>
		);
	} else {
		body = <Thread messages={messages} tools={st.tools} streaming={streaming} cwd={project.path} onAction={(a) => setDialog(a === "recharge" ? "recharge" : "login")} />;
	}

	let placeholder = "描述你想做的事…";
	if (!project) placeholder = "先打开一个项目文件夹";
	else if (!loggedIn) placeholder = "登录后即可开始";
	else if (phase === "starting") placeholder = "智能体启动中…";
	else if (!modelReady) placeholder = "没有可用模型，请检查账户分组";
	else if (streaming) placeholder = "补充指令，会在当前步骤后送达…";

	return (
		<div className={`shell${collapsed ? " collapsed" : ""}`}>
			{!collapsed ? (
				<Sidebar
					platform={env.platform}
					home={env.home}
					project={project}
					projects={projects}
					sessions={sessions}
					activeSession={st?.sessionFile}
					streaming={streaming}
					account={account}
					onPickProject={openProject}
					onOpenFolder={() => void openFolder()}
					onNewChat={() => void newChat()}
					onOpenSession={(s) => void openSession(s)}
					onAccount={() => setDialog("account")}
					onRecharge={() => setDialog("recharge")}
					onSettings={() => setDialog("settings")}
					onLogin={() => setDialog("login")}
					onCollapse={() => setCollapsed(true)}
				/>
			) : (
				<div />
			)}
			<main className="main">
				<Topbar
					title={title}
					subtitle={st?.sessionName || messages.length ? project?.name : undefined}
					collapsed={collapsed}
					onExpand={() => setCollapsed(false)}
					model={st?.model}
					models={loggedIn ? (st?.models ?? []) : []}
					groups={account?.groups ?? []}
					thinkingLevel={st?.thinkingLevel ?? "off"}
					thinkingLevels={st?.thinkingLevels ?? ["off"]}
					busy={streaming}
					onModel={(m) => agent?.setModel(m).catch((e) => toast({ text: (e as Error).message, tone: "error" }))}
					onThinking={(l) => agent?.setThinking(l).catch((e) => toast({ text: (e as Error).message, tone: "error" }))}
				/>
				{update.state === "available" && !updateDismissed && (
					<div className="banner">
						<span className="grow">新版本 {update.info?.version} 已就绪</span>
						<button className="btn small primary" onClick={() => void update.info?.install()}>
							更新并重启
						</button>
						<button className="btn small ghost" onClick={() => setUpdateDismissed(true)}>
							稍后
						</button>
					</div>
				)}
				{update.state === "installing" && (
					<div className="banner">
						<span className="spinner" />
						<span className="grow">正在下载更新 {update.progress ?? 0}%，完成后自动重启</span>
					</div>
				)}
				{balanceLow && (
					<div className="banner">
						<span className="grow">余额即将用完，充值后可继续使用。</span>
						<button className="btn small primary" onClick={() => setDialog("recharge")}>
							充值
						</button>
					</div>
				)}
				{phase === "exited" && (
					<div className="banner" style={{ background: "var(--vermilion-soft)" }}>
						<span className="grow selectable" style={{ whiteSpace: "pre-wrap", color: "var(--vermilion)" }}>
							智能体已停止：{st.exitInfo}
						</span>
						<button className="btn small" onClick={restartAgent}>
							重新启动
						</button>
					</div>
				)}
				{st?.retry && (
					<div className="banner">
						<span className="spinner" />
						<span className="grow">
							模型服务出错，正在重试（{st.retry.attempt}/{st.retry.maxAttempts}）{st.retry.error ? `：${st.retry.error}` : ""}
						</span>
					</div>
				)}
				{st?.compacting && (
					<div className="banner">
						<span className="spinner" />
						<span className="grow">正在压缩较早的对话以节省上下文…</span>
					</div>
				)}
				<div
					className="scroll"
					ref={scroller}
					onScroll={(e) => {
						const el = e.currentTarget;
						stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
					}}
				>
					{body}
				</div>
				<Composer
					streaming={streaming}
					disabled={!project || !loggedIn || phase !== "ready" || !modelReady}
					placeholder={placeholder}
					commands={st?.commands ?? []}
					editorText={st?.editorText}
					queue={st?.queue ?? { steering: [], followUp: [] }}
					widgets={st?.widgets ?? {}}
					statuses={st?.statuses ?? {}}
					stats={st?.stats}
					supportsImages={!!st?.model?.input?.includes("image")}
					onSend={(t, i) => void send(t, i)}
					onAbort={() => void agent?.abort()}
					focusKey={st?.sessionFile}
				/>
			</main>

			{dialog === "login" && (
				<LoginDialog
					registerUrl={config?.register_url}
					onClose={() => setDialog(null)}
					onDone={async () => {
						setDialog(null);
						await refreshAccount();
						toast({ text: "登录成功", tone: "success" });
						restartAgent();
					}}
				/>
			)}
			{dialog === "recharge" && <RechargeDialog account={account} onClose={() => setDialog(null)} onRedeemed={() => void refreshAccount()} />}
			{(dialog === "settings" || dialog === "account") && (
				<SettingsDialog
					initialTab={dialog === "account" ? "account" : "general"}
					account={account}
					theme={theme}
					onTheme={setTheme}
					version={version || "dev"}
					update={update}
					onCheckUpdate={() => void checkUpdate(true)}
					onPluginsChanged={restartAgent}
					onLogout={async () => {
						setDialog(null);
						try {
							await api.logout();
						} catch (e) {
							toast({ text: (e as Error).message, tone: "error" });
						}
						await refreshAccount();
						restartAgent();
					}}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialogReq && agent && !dialog && <UiRequestDialog key={dialogReq.id} req={dialogReq} onAnswer={(r) => agent.answer(dialogReq.id, r)} />}

			<div className="toasts" aria-live="polite">
				{notices.map((n) => (
					<div key={n.id} className={`toast ${n.tone}`}>
						<i />
						<span>{n.text}</span>
					</div>
				))}
			</div>
		</div>
	);
}
