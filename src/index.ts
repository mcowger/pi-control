import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConfigLoader } from "./config.js";
import { handleToolCall } from "./hooks/tool-call.js";
import { initBashParser } from "./utils/bash-ast.js";

export default async function piControls(pi: ExtensionAPI): Promise<void> {
	const loader = createConfigLoader();

	pi.on("session_start", async (_event, ctx) => {
		await initBashParser((msg) => ctx.ui.notify(msg, "warning"));
		await loader.load();
	});

	pi.on("tool_call", async (event, ctx) => {
		const config = loader.getConfig();
		return handleToolCall(event, ctx, config);
	});
}
