import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { ControlsResolvedConfig, Action } from "../config.js";
import { resolvePolicy } from "../utils/location.js";
import { matchRule, mostRestrictive } from "../utils/matching.js";
import { normalizePath } from "../utils/path.js";
import { parseCommand } from "../utils/bash-ast.js";
import { logDecision } from "../utils/logger.js";

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

function notifyDecision(
	ctx: ExtensionContext,
	action: Action,
	toolName: string,
	command: string | null,
	policyName: string | null,
): void {
	// Only notify for non-allow decisions — allow is silent.
	if (action === "allow") return;
	const policy = policyName ? ` [${policyName}]` : "";
	const cmd = command ? `: ${command.slice(0, 80)}` : "";
	const type = action === "deny" ? "error" : action === "ask" ? "warning" : "info";
	ctx.ui.notify(`pi-controls: ${action}${policy}${cmd}`, type);
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

export async function handleToolCall(
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
			await logDecision({ ts: new Date().toISOString(), tool: "bash", command: cmd, cwd, targets, policyName: null, action: "pass" });
			return undefined;
		}

		const finalAction = mostRestrictive(actions);
		await logDecision({ ts: new Date().toISOString(), tool: "bash", command: cmd, cwd, targets, policyName, action: finalAction });
		notifyDecision(ctx, finalAction, "bash", cmd, policyName);
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
		await logDecision({ ts: new Date().toISOString(), tool: event.toolName, cwd, targets, policyName: null, action: "pass" });
		return undefined;
	}

	const finalAction = mostRestrictive(actions);
	await logDecision({ ts: new Date().toISOString(), tool: event.toolName, cwd, targets, policyName, action: finalAction });
	notifyDecision(ctx, finalAction, event.toolName, null, policyName);
	return executeAction(finalAction, event.toolName, null, ctx);
}
