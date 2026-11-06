import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import accountExtension from "./extensions/account.ts";
import brandingExtension from "./extensions/branding.ts";
import updaterExtension from "./extensions/updater.ts";
import confirmDestructive from "./plugins/confirm-destructive/index.ts";
import gitCheckpoint from "./plugins/git-checkpoint/index.ts";
import handoff from "./plugins/handoff/index.ts";
import notify from "./plugins/notify/index.ts";
import planMode from "./plugins/plan-mode/index.ts";
import protectedPaths from "./plugins/protected-paths/index.ts";
import question from "./plugins/question/index.ts";
import sessionName from "./plugins/session-name/index.ts";
import subagent from "./plugins/subagent/index.ts";
import todo from "./plugins/todo/index.ts";
import { PLUGIN_INFO } from "./plugin-info.ts";

const FACTORIES: Record<string, any> = {
	"plan-mode": planMode,
	todo,
	subagent,
	question,
	handoff,
	"session-name": sessionName,
	"confirm-destructive": confirmDestructive,
	"protected-paths": protectedPaths,
	notify,
	"git-checkpoint": gitCheckpoint,
};

/** Bundled plugins. Users toggle them with `stzo config`, the desktop settings, or `-builtin:<name>`. */
export const PLUGINS: InlineExtension[] = PLUGIN_INFO.map((p) => ({ name: p.name, factory: FACTORIES[p.name], builtin: true }));

export const CORE: InlineExtension[] = [
	{ name: "stzo-account", factory: accountExtension, hidden: true },
	{ name: "stzo-updater", factory: updaterExtension, hidden: true },
	{ name: "stzo-branding", factory: brandingExtension, hidden: true },
];
