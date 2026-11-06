import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, displayName, money, type AccountState, type PluginState, type Shop } from "../lib/api";
import { openExternal, type UpdateInfo } from "../lib/native";
import type { UiRequest } from "../lib/rpc";

export function Modal({ children, onClose, wide, label }: { children: ReactNode; onClose?: () => void; wide?: boolean; label: string }) {
	useEffect(() => {
		const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose?.();
		window.addEventListener("keydown", esc);
		return () => window.removeEventListener("keydown", esc);
	}, [onClose]);
	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
			<div className={`dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={label}>
				{children}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------

export function LoginDialog({ registerUrl, onDone, onClose }: { registerUrl?: string; onDone: () => void; onClose: () => void }) {
	const [device, setDevice] = useState<{ user_code: string; url: string }>();
	const [error, setError] = useState<string>();
	const [attempt, setAttempt] = useState(0);
	const ctrl = useRef<AbortController | undefined>(undefined);

	useEffect(() => {
		const c = new AbortController();
		ctrl.current = c;
		setError(undefined);
		setDevice(undefined);
		api
			.login((d) => {
				setDevice(d);
				void openExternal(d.url);
			}, c.signal)
			.then(() => onDone())
			.catch((e) => !c.signal.aborted && setError((e as Error).message));
		return () => c.abort();
	}, [attempt]);

	return (
		<Modal label="登录" onClose={onClose}>
			<h2>登录 STZO 账号</h2>
			<p className="lede">在浏览器中确认授权后，这里会自动完成登录。</p>
			{error ? (
				<>
					<div className="error-note">
						<span>{error}</span>
					</div>
					<div className="actions">
						<button className="btn ghost" onClick={onClose}>
							取消
						</button>
						<button className="btn primary" onClick={() => setAttempt(attempt + 1)}>
							重试
						</button>
					</div>
				</>
			) : device ? (
				<>
					<div className="code-display">{device.user_code}</div>
					<div className="waiting">
						<span className="spinner" />
						等待浏览器确认，请核对页面上的验证码与此处一致
					</div>
					<div className="actions">
						{registerUrl && (
							<button className="btn ghost" style={{ marginRight: "auto" }} onClick={() => void openExternal(registerUrl)}>
								注册新账号
							</button>
						)}
						<button className="btn ghost" onClick={onClose}>
							取消
						</button>
						<button className="btn primary" onClick={() => void openExternal(device.url)}>
							重新打开浏览器
						</button>
					</div>
				</>
			) : (
				<div className="waiting" style={{ padding: "20px 0" }}>
					<span className="spinner" />
					正在生成验证码…
				</div>
			)}
		</Modal>
	);
}

// ---------------------------------------------------------------------------------------------

export function RechargeDialog({ account, onRedeemed, onClose }: { account?: AccountState; onRedeemed: () => void; onClose: () => void }) {
	const [shop, setShop] = useState<Shop>();
	const [shopError, setShopError] = useState<string>();
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; text: string }>();

	useEffect(() => {
		api
			.shop()
			.then(setShop)
			.catch((e) => setShopError((e as Error).message));
	}, []);

	const redeem = async () => {
		const c = code.trim();
		if (!c) return;
		setBusy(true);
		setResult(undefined);
		try {
			const r = await api.redeem(c);
			setResult({ ok: true, text: r.type === "balance" ? `已到账 ${money(r.value)}，当前余额 ${money(r.user?.balance)}` : "兑换成功" });
			setCode("");
			onRedeemed();
		} catch (e) {
			setResult({ ok: false, text: (e as Error).message });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal label="充值" onClose={onClose} wide>
			<h2>充值</h2>
			<div className="balance-hero">
				<b>{money(account?.user?.balance)}</b>
				<span>当前余额</span>
			</div>

			<div className="section-label">1. 购买兑换码（在浏览器中完成付款）</div>
			{shopError ? (
				<div className="error-note">
					<span>商品加载失败：{shopError}</span>
				</div>
			) : !shop ? (
				<div className="waiting">
					<span className="spinner" />
					正在加载商品…
				</div>
			) : (
				<div className="goods">
					{shop.items.map((it) => (
						<button key={it.goods_no} className="good" onClick={() => void openExternal(it.url)} disabled={it.stock === 0}>
							<span className="price">
								<small>¥</small>
								{it.price}
							</span>
							<span className="gname">{it.name}</span>
							<span className="stock">{it.stock === 0 ? "暂时缺货" : "购买"}</span>
						</button>
					))}
					{shop.items.length === 0 && (
						<button className="good" onClick={() => void openExternal(shop.url)}>
							<span className="gname">打开店铺</span>
						</button>
					)}
				</div>
			)}

			<div className="section-label">2. 粘贴兑换码</div>
			<div className="split">
				<input
					className="input"
					placeholder="付款后收到的兑换码"
					value={code}
					onChange={(e) => setCode(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && void redeem()}
					autoFocus
				/>
				<button className="btn primary" style={{ height: 38 }} onClick={() => void redeem()} disabled={busy || !code.trim()}>
					{busy ? "兑换中…" : "兑换"}
				</button>
			</div>
			{result && (
				<p style={{ margin: "10px 0 0", color: result.ok ? "var(--celadon)" : "var(--vermilion)" }} className="selectable">
					{result.text}
				</p>
			)}
			{shop?.contact_qq && <p style={{ margin: "18px 0 0", fontSize: 12.5, color: "var(--ink-3)" }}>购买或到账问题请联系客服 QQ {shop.contact_qq}</p>}
		</Modal>
	);
}

// ---------------------------------------------------------------------------------------------

export function SettingsDialog({
	account,
	theme,
	onTheme,
	version,
	update,
	onCheckUpdate,
	onLogout,
	onPluginsChanged,
	onClose,
	initialTab,
}: {
	account?: AccountState;
	theme: string;
	onTheme: (t: string) => void;
	version: string;
	update: { state: "idle" | "checking" | "none" | "available" | "installing" | "error"; info?: UpdateInfo; progress?: number; error?: string };
	onCheckUpdate: () => void;
	onLogout: () => void;
	onPluginsChanged: () => void;
	onClose: () => void;
	initialTab?: "general" | "plugins" | "account";
}) {
	const [tab, setTab] = useState(initialTab ?? "general");
	const [plugins, setPlugins] = useState<PluginState[]>();
	const [changed, setChanged] = useState(false);
	const [err, setErr] = useState<string>();

	useEffect(() => {
		api
			.plugins()
			.then(setPlugins)
			.catch((e) => setErr((e as Error).message));
	}, []);

	const close = () => {
		if (changed) onPluginsChanged();
		onClose();
	};

	const toggle = async (p: PluginState) => {
		setPlugins(plugins?.map((x) => (x.name === p.name ? { ...x, enabled: !p.enabled } : x)));
		try {
			setPlugins(await api.setPlugin(p.name, !p.enabled));
			setChanged(true);
		} catch (e) {
			setErr((e as Error).message);
		}
	};

	return (
		<Modal label="设置" onClose={close} wide>
			<h2>设置</h2>
			<div className="tabs" role="tablist">
				{(
					[
						["general", "通用"],
						["plugins", "插件"],
						["account", "账户"],
					] as const
				).map(([k, l]) => (
					<button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>
						{l}
					</button>
				))}
			</div>

			{tab === "general" && (
				<div>
					<div className="setting">
						<div className="txt">
							<b>外观</b>
							<span>跟随系统，或固定为浅色、深色</span>
						</div>
						<div className="seg">
							{(
								[
									["system", "系统"],
									["light", "浅色"],
									["dark", "深色"],
								] as const
							).map(([k, l]) => (
								<button key={k} className={theme === k ? "on" : ""} onClick={() => onTheme(k)}>
									{l}
								</button>
							))}
						</div>
					</div>
					<div className="setting">
						<div className="txt">
							<b>版本 {version}</b>
							<span>
								{update.state === "checking" && "正在检查更新…"}
								{update.state === "none" && "已是最新版本"}
								{update.state === "available" && `新版本 ${update.info?.version} 可用`}
								{update.state === "installing" && `正在下载更新 ${update.progress ?? 0}%`}
								{update.state === "error" && `检查更新失败：${update.error}`}
								{update.state === "idle" && "应用会在启动时自动检查更新"}
							</span>
						</div>
						{update.state === "available" ? (
							<button className="btn primary small" onClick={() => void update.info?.install()}>
								更新并重启
							</button>
						) : (
							<button className="btn small" onClick={onCheckUpdate} disabled={update.state === "checking" || update.state === "installing"}>
								检查更新
							</button>
						)}
					</div>
				</div>
			)}

			{tab === "plugins" && (
				<div>
					{err && (
						<div className="error-note">
							<span>{err}</span>
						</div>
					)}
					{!plugins && !err && (
						<div className="waiting" style={{ padding: "14px 0" }}>
							<span className="spinner" />
							正在读取插件…
						</div>
					)}
					{plugins?.map((p) => (
						<div className="setting" key={p.name}>
							<div className="txt">
								<b>{p.title}</b>
								<span>{p.description}</span>
							</div>
							<button className={`switch${p.enabled ? " on" : ""}`} role="switch" aria-checked={p.enabled} aria-label={p.title} onClick={() => void toggle(p)} />
						</div>
					))}
					{changed && <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "10px 0 0" }}>关闭设置后，当前项目的智能体会重新启动以应用插件变更。</p>}
				</div>
			)}

			{tab === "account" && (
				<div>
					{account?.loggedIn ? (
						<>
							<div className="setting">
								<div className="txt">
									<b>{displayName(account.user)}</b>
									<span>{account.user?.email}</span>
								</div>
								<button className="btn small danger" onClick={onLogout}>
									退出登录
								</button>
							</div>
							<div className="setting">
								<div className="txt">
									<b>余额 {money(account.user?.balance)}</b>
									<span>累计充值 {money(account.user?.total_recharged)}</span>
								</div>
							</div>
							<div className="setting">
								<div className="txt">
									<b>可用分组</b>
									<span>{account.groups?.map((g) => `${g.name}（${g.rate}x）`).join("，") || "无"}</span>
								</div>
							</div>
						</>
					) : (
						<p className="lede">当前未登录。</p>
					)}
				</div>
			)}
		</Modal>
	);
}

// ---------------------------------------------------------------------------------------------

export function UiRequestDialog({ req, onAnswer }: { req: UiRequest; onAnswer: (r: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void }) {
	const [value, setValue] = useState(req.prefill ?? "");
	const cancel = () => onAnswer({ cancelled: true });
	return (
		<Modal label={req.title} onClose={cancel}>
			<h2>{req.title}</h2>
			{req.message && <p className="lede selectable" style={{ whiteSpace: "pre-wrap" }}>{req.message}</p>}
			{req.method === "select" && (
				<div className="options-list" style={{ marginTop: 12 }}>
					{(req.options ?? []).map((o, i) => (
						<button key={i} className="option" onClick={() => onAnswer({ value: o })} autoFocus={i === 0}>
							{o}
						</button>
					))}
				</div>
			)}
			{req.method === "input" && (
				<input
					className="input"
					autoFocus
					placeholder={req.placeholder}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && onAnswer({ value })}
				/>
			)}
			{req.method === "editor" && <textarea className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />}
			<div className="actions">
				{req.method === "confirm" ? (
					<>
						<button className="btn ghost" onClick={() => onAnswer({ confirmed: false })}>
							否
						</button>
						<button className="btn primary" autoFocus onClick={() => onAnswer({ confirmed: true })}>
							是
						</button>
					</>
				) : (
					<>
						<button className="btn ghost" onClick={cancel}>
							取消
						</button>
						{req.method !== "select" && (
							<button className="btn primary" onClick={() => onAnswer({ value })}>
								确定
							</button>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}
