import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { ControlsResolvedConfig, Action } from "../config.js";
import { resolvePolicy } from "../utils/location.js";
import { matchRule, mostRestrictive } from "../utils/matching.js";
import { normalizePath } from "../utils/path.js";
import { parseCommand } from "../utils/bash-ast.js";
import { logDecision } from "../utils/logger.js";

const STATUS_KEY = "pi-controls";

function statusText(ctx: ExtensionContext, action: Action | "pass"): string {
	const theme = ctx.ui.theme;
	const prefix = "pi-controls:";
	switch (action) {
		case "allow": return theme.fg("dim", `${prefix} allow`);
		case "deny":  return theme.fg("error", `${prefix} deny`);
		case "ask":   return theme.fg("warning", `${prefix} ask`);
		case "log":   return theme.fg("muted", `${prefix} log`);
		case "pass":  return theme.fg("dim", `${prefix} pass`);
	}
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

	// ── Bash ─────────────────────────────────────────────────────────────────
	if (event.toolName === "bash") {
		const input = event.input as { command: string };
		const stages = await parseCommand(input.command);
		const cmd = stages.map((s) => s.command).join(" | ");

		const actions: Action[] = [];
		const targets: string[] = [];
		let policyName: string | null = null;

		for (const stage of stages) {
			const stageTargets = stage.redirectFiles.length > 0
				? stage.redirectFiles.map((f) => normalizePath(f, cwd))
				: [cwd];

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
			ctx.ui.setStatus(STATUS_KEY, statusText(ctx, "pass"));
			return undefined;
		}

		const finalAction = mostRestrictive(actions);
		await logDecision({ ts: new Date().toISOString(), tool: "bash", command: cmd, cwd, targets, policyName, action: finalAction });
		ctx.ui.setStatus(STATUS_KEY, statusText(ctx, finalAction));
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
		ctx.ui.setStatus(STATUS_KEY, statusText(ctx, "pass"));
		return undefined;
	}

	const finalAction = mostRestrictive(actions);
	await logDecision({ ts: new Date().toISOString(), tool: event.toolName, cwd, targets, policyName, action: finalAction });
	ctx.ui.setStatus(STATUS_KEY, statusText(ctx, finalAction));
	return executeAction(finalAction, event.toolName, null, ctx);
}
