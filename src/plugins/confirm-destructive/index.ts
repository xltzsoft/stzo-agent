/**
 * Confirm Destructive Actions Extension
 *
 * Prompts for confirmation before leaving the current session (new, switch, fork) in the terminal.
 * The desktop app skips it: there every one of these is an explicit click and the old session stays
 * in the sidebar, so a second question only gets in the way (and blocks the RPC call until answered).
 */

import type { ExtensionAPI, SessionBeforeSwitchEvent, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

const desktop = () => process.env.STZO_DESKTOP === "1";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
		if (!ctx.hasUI || desktop()) return;

		if (event.reason === "new") {
			const confirmed = await ctx.ui.confirm("Start a new session?", "The current session is kept and can be resumed later.");

			if (!confirmed) {
				ctx.ui.notify("New session cancelled", "info");
				return { cancel: true };
			}
			return;
		}

		// reason === "resume" - check if there are unsaved changes (messages since last assistant response)
		const entries = ctx.sessionManager.getEntries();
		const hasUnsavedWork = entries.some(
			(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user",
		);

		if (hasUnsavedWork) {
			const confirmed = await ctx.ui.confirm(
				"Switch session?",
				"You have messages in the current session. Switch anyway?",
			);

			if (!confirmed) {
				ctx.ui.notify("Switch cancelled", "info");
				return { cancel: true };
			}
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI || desktop()) return;

		const choice = await ctx.ui.select(`Fork from entry ${event.entryId.slice(0, 8)}?`, [
			"Yes, create fork",
			"No, stay in current session",
		]);

		if (choice !== "Yes, create fork") {
			ctx.ui.notify("Fork cancelled", "info");
			return { cancel: true };
		}
	});
}
