import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConfigLoader } from "./config.js";
import { handleToolCall } from "./hooks/tool-call.js";
import { initBashParser } from "./utils/bash-ast.js";
import { logStartup } from "./utils/logger.js";

export default async function piControls(pi: ExtensionAPI): Promise<void> {
	const loader = createConfigLoader();

	pi.on("session_start", async (_event, ctx) => {
		await initBashParser((msg) => {
			ctx.ui.notify(msg, "warning");
			logStartup(`bash-parser warning: ${msg}`);
		});

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
		const config = loader.getConfig();
		return handleToolCall(event, ctx, config);
	});
}
