import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConfigLoader } from "./config.js";
import { handleToolCall } from "./hooks/tool-call.js";
import { initBashParser } from "./utils/bash-ast.js";
import { logStartup } from "./utils/logger.js";

export type ControlsMode = "enforce" | "ignore" | "inform";

const MODES: ControlsMode[] = ["enforce", "ignore", "inform"];

const MODE_DESCRIPTIONS: Record<ControlsMode, string> = {
	enforce: "enforce — block tool calls that violate policy (default)",
	ignore: "ignore  — disable pi-controls entirely (no evaluation, no output)",
	inform: "inform  — show what would be blocked, but allow everything",
};

const MODE_NOTIFY_TYPE: Record<ControlsMode, "info" | "warning" | "error"> = {
	enforce: "info",
	ignore: "warning",
	inform: "info",
};

export default async function piControls(pi: ExtensionAPI): Promise<void> {
	const loader = createConfigLoader();
	let mode: ControlsMode = "enforce";

	function setWidgetForMode(ctx: { ui: { setWidget: (id: string, lines: string[]) => void } }): void {
		if (mode === "ignore") {
			ctx.ui.setWidget("pi-controls-mode", ["[pi-controls: IGNORE]"]);
		} else if (mode === "inform") {
			ctx.ui.setWidget("pi-controls-mode", ["[pi-controls: INFORM]"]);
		} else {
			// enforce is the default — no widget clutter
			ctx.ui.setWidget("pi-controls-mode", []);
		}
	}

	pi.registerCommand("controls", {
		description: "Set pi-controls mode: enforce | ignore | inform",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
			return MODES
				.filter((m) => m.startsWith(prefix))
				.map((m) => ({ value: m, label: m, description: MODE_DESCRIPTIONS[m] }));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase() as ControlsMode;
			if (!MODES.includes(arg)) {
				ctx.ui.notify(
					`[pi-controls] Unknown mode "${args}". Use: enforce, ignore, or inform.`,
					"error",
				);
				return;
			}
			mode = arg;
			setWidgetForMode(ctx);
			ctx.ui.notify(`[pi-controls] Mode set to: ${mode}`, MODE_NOTIFY_TYPE[mode]);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await initBashParser((msg) => {
			ctx.ui.notify(msg, "warning");
			logStartup(`bash-parser warning: ${msg}`);
		});

		// Restore widget state if mode was changed before a reload.
		setWidgetForMode(ctx);

		try {
			await loader.load();
			const config = loader.getConfig();
			const policyCount = Object.keys(config.policies).length;
			const locationCount = Object.keys(config.locations).length;
			await logStartup(
				`loaded: ${policyCount} policies, ${locationCount} locations, defaultPolicy=${config.defaultPolicy ?? "null"}`,
			);
			if (policyCount === 0 && locationCount === 0) {
				ctx.ui.notify(
					"[pi-controls] No config found — all tool calls are unrestricted. Create ~/.pi/agent/extensions/pi-controls.jsonc to enforce policies.",
					"warning",
				);
			}
		} catch (err) {
			const msg = `failed to load config: ${err}`;
			ctx.ui.notify(`[pi-controls] ${msg}`, "error");
			await logStartup(msg);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (mode === "ignore") return undefined;
		const config = loader.getConfig();
		return handleToolCall(event, ctx, config, mode);
	});
}
