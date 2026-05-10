import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { ControlsResolvedConfig, Action } from "../config.js";
import { resolvePolicy } from "../utils/location.js";
import { matchRule, mostRestrictive } from "../utils/matching.js";
import { normalizePath } from "../utils/path.js";
import { parseCommand } from "../utils/bash-ast.js";
import { logDecision } from "../utils/logger.js";

export const MESSAGE_TYPE = "pi-controls-decision";

export interface DecisionDetails {
	action: Action | "pass";
	tool: string;
	command?: string;
	policyName: string | null;
}

function getTargetPaths(event: ToolCallEvent, cwd: string): string[] {
	if (event.toolName === "bash") return [];
	const input = event.input as Record<string, unknown>;
	for (const key of ["path", "file_path"]) {
		if (typeof input[key] === "string") {
			return [normalizePath(input[key] as string, cwd)];
		}
	}
	return [cwd];
}

function emitDecision(pi: ExtensionAPI, details: DecisionDetails): void {
	pi.sendMessage({
		customType: MESSAGE_TYPE,
		content: "",
		display: true,
		details,
	});
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
			const confirmed = await ctx.ui.confirm(`[pi-controls] Allow ${toolName}?`, label);
			if (!confirmed) {
				return { block: true, reason: `[pi-controls] Blocked by user: ${toolName}` };
			}
			return undefined;
		}

		case "deny":
			return {
				block: true,
				reason: `[pi-controls] Access denied by policy: ${toolName}${command ? ` (${command.slice(0, 80)})` : ""}. This is a policy enforcement decision — do not retry with alternative paths or rephrased commands.`,
			};
	}
}

export function makeHandleToolCall(pi: ExtensionAPI) {
	return async function handleToolCall(
		event: ToolCallEvent,
		ctx: ExtensionContext,
		config: ControlsResolvedConfig,
	): Promise<ToolCallEventResult | undefined> {
		const cwd = ctx.cwd;

		// ── Bash ─────────────────────────────────────────────────────────────────
		if (event.toolName === "bash") {
			const input = event.input as { command: string };
			const stages = await parseCommand(input.command);
			const cmd = stages.map((s) => s.command).join(" | ");

			const actions: Action[] = [];
			const targets: string[] = [];
			let policyName: string | null = null;

			for (const stage of stages) {
				// Targets: redirect files + path args — fall back to CWD only if neither present.
				const explicitPaths = [
					...stage.redirectFiles,
					...stage.pathArgs,
				].map((f) => normalizePath(f, cwd));
				const stageTargets = explicitPaths.length > 0 ? explicitPaths : [cwd];

				for (const target of stageTargets) {
					targets.push(target);
					const resolved = resolvePolicy(target, cwd, config);
					if (resolved) {
						policyName = resolved.name;
						actions.push(matchRule(resolved.policy, "bash", stage.command));
					}
				}
			}

			if (actions.length === 0) {
				const details: DecisionDetails = { action: "pass", tool: "bash", command: cmd, policyName: null };
				await logDecision({ ts: new Date().toISOString(), tool: "bash", command: cmd, cwd, targets, policyName: null, action: "pass" });
				emitDecision(pi, details);
				return undefined;
			}

			const finalAction = mostRestrictive(actions);
			const details: DecisionDetails = { action: finalAction, tool: "bash", command: cmd, policyName };
			await logDecision({ ts: new Date().toISOString(), tool: "bash", command: cmd, cwd, targets, policyName, action: finalAction });
			emitDecision(pi, details);
			return executeAction(finalAction, "bash", cmd, ctx);
		}

		// ── Non-bash ──────────────────────────────────────────────────────────────
		const targets = getTargetPaths(event, cwd);
		const actions: Action[] = [];
		let policyName: string | null = null;

		for (const target of targets) {
			const resolved = resolvePolicy(target, cwd, config);
			if (resolved) {
				policyName = resolved.name;
				actions.push(matchRule(resolved.policy, event.toolName, null));
			}
		}

		if (actions.length === 0) {
			const details: DecisionDetails = { action: "pass", tool: event.toolName, policyName: null };
			await logDecision({ ts: new Date().toISOString(), tool: event.toolName, cwd, targets, policyName: null, action: "pass" });
			emitDecision(pi, details);
			return undefined;
		}

		const finalAction = mostRestrictive(actions);
		const details: DecisionDetails = { action: finalAction, tool: event.toolName, policyName };
		await logDecision({ ts: new Date().toISOString(), tool: event.toolName, cwd, targets, policyName, action: finalAction });
		emitDecision(pi, details);
		return executeAction(finalAction, event.toolName, null, ctx);
	};
}
