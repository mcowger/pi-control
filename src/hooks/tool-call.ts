import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { ControlsResolvedConfig, Action } from "../config.js";
import { resolvePolicy } from "../utils/location.js";
import { matchRule, mostRestrictive } from "../utils/matching.js";
import { normalizePath } from "../utils/path.js";
import { parseCommand } from "../utils/bash-ast.js";

/**
 * Determine the target paths for a tool call.
 *
 * - bash: handled by the caller (needs AST parse)
 * - tool with `path` or `file_path` in input: use that field
 * - anything else: fall back to CWD
 */
function getTargetPaths(event: ToolCallEvent, cwd: string): string[] {
	if (event.toolName === "bash") return []; // handled separately
	const input = event.input as Record<string, unknown>;
	for (const key of ["path", "file_path"]) {
		if (typeof input[key] === "string") {
			return [normalizePath(input[key] as string, cwd)];
		}
	}
	return [cwd];
}

async function executeAction(
	action: Action,
	toolName: string,
	command: string | null,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	switch (action) {
		case "allow":
			return undefined;

		case "log":
			ctx.ui.notify(
				`[pi-controls] ${toolName}${command ? `: ${command.slice(0, 80)}` : ""} — logged`,
				"info",
			);
			return undefined;

		case "ask": {
			const label = command ? command.slice(0, 120) : toolName;
			const confirmed = await ctx.ui.confirm(
				`[pi-controls] Allow ${toolName}?`,
				label,
			);
			if (!confirmed) {
				return { block: true, reason: `[pi-controls] Blocked by user: ${toolName}` };
			}
			return undefined;
		}

		case "deny":
			return {
				block: true,
				reason: `[pi-controls] Denied by policy: ${toolName}${command ? ` (${command.slice(0, 80)})` : ""}`,
			};
	}
}

export async function handleToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	config: ControlsResolvedConfig,
): Promise<ToolCallEventResult | undefined> {
	const cwd = ctx.cwd;

	// ── Bash: parse AST, check each stage against its location policies ───────
	if (event.toolName === "bash") {
		const input = event.input as { command: string };
		const stages = await parseCommand(input.command);

		const actions: Action[] = [];

		for (const stage of stages) {
			// Targets for this stage: redirect files + CWD fallback.
			const targets: string[] = stage.redirectFiles.length > 0
				? stage.redirectFiles.map((f) => normalizePath(f, cwd))
				: [cwd];

			const stageActions: Action[] = [];
			for (const target of targets) {
				const policy = resolvePolicy(target, cwd, config);
				if (policy) {
					stageActions.push(matchRule(policy, "bash", stage.command));
				}
			}
			if (stageActions.length > 0) {
				actions.push(mostRestrictive(stageActions));
			}
		}

		if (actions.length === 0) return undefined; // no applicable policy
		const finalAction = mostRestrictive(actions);
		const cmd = stages.map((s) => s.command).join(" | ");
		return executeAction(finalAction, "bash", cmd, ctx);
	}

	// ── Non-bash: resolve target paths, collect policy actions ───────────────
	const targets = getTargetPaths(event, cwd);
	const actions: Action[] = [];

	for (const target of targets) {
		const policy = resolvePolicy(target, cwd, config);
		if (policy) {
			actions.push(matchRule(policy, event.toolName, null));
		}
	}

	if (actions.length === 0) return undefined;
	const finalAction = mostRestrictive(actions);
	return executeAction(finalAction, event.toolName, null, ctx);
}
