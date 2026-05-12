import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { ControlsMode } from "../index.js";
import type { ControlsResolvedConfig, Action } from "../config.js";
import { resolvePolicy } from "../utils/location.js";
import { matchRuleWithDetails, mostRestrictive } from "../utils/matching.js";
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

function buildContextSuffix(
	deniedPaths: string[],
	matchedPattern?: string,
): string {
	const parts: string[] = [];
	if (deniedPaths.length > 0) {
		parts.push(
			`blocked path${deniedPaths.length > 1 ? "s" : ""}: ${deniedPaths.map((p) => `"${p}"`).join(", ")}`,
		);
	}
	if (matchedPattern !== undefined) {
		parts.push(`pattern: "${matchedPattern}"`);
	}
	return parts.length > 0 ? ` — ${parts.join(", ")}` : "";
}

function notifyDecision(
	ctx: ExtensionContext,
	action: Action,
	toolName: string,
	command: string | null,
	policyName: string | null,
	mode: ControlsMode = "enforce",
	deniedPaths: string[] = [],
	matchedPattern?: string,
): void {
	// In inform mode show everything (including allow) so user sees the full picture.
	// In enforce mode, allow is silent — only show non-allow decisions.
	if (mode !== "inform" && action === "allow") return;
	const policy = policyName ? ` [${policyName}]` : "";
	const cmd = command ? `: ${command.slice(0, 80)}` : "";
	const context = buildContextSuffix(deniedPaths, matchedPattern);
	// In inform mode: prefix non-allow actions with "would-" and always use info
	// so it's clear nothing was actually blocked.
	const label =
		mode === "inform" && action !== "allow" ? `would-${action}` : action;
	const type =
		mode === "inform"
			? "info"
			: action === "deny"
				? "error"
				: action === "ask"
					? "warning"
					: "info";
	ctx.ui.notify(`pi-controls: ${label}${policy}${cmd}${context}`, type);
}

async function executeAction(
	action: Action,
	toolName: string,
	command: string | null,
	ctx: ExtensionContext,
	deniedPaths: string[] = [],
	matchedPattern?: string,
): Promise<ToolCallEventResult | undefined> {
	switch (action) {
		case "allow":
			return undefined;

		case "log":
			return undefined;

		case "ask": {
			const context = buildContextSuffix(deniedPaths, matchedPattern);
			const label = command ? command.slice(0, 120) : toolName;
			const detail = context.length > 0 ? context : "";
			const confirmed = await ctx.ui.confirm(
				`[pi-controls] Allow ${toolName}?${detail}`,
				label,
			);
			if (!confirmed) {
				return {
					block: true,
					reason: `[pi-controls] Blocked by user: ${toolName}${command ? ` (${command.slice(0, 80)})` : ""}`,
				};
			}
			return undefined;
		}

		case "deny": {
			const cmdPart = command ? ` (${command.slice(0, 80)})` : "";
			const context = buildContextSuffix(deniedPaths, matchedPattern);
			return {
				block: true,
				reason: `[pi-controls] Access denied by policy: ${toolName}${cmdPart}${context}. Avoid the blocked pattern in any retry.`,
			};
		}
	}
}

export async function handleToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	config: ControlsResolvedConfig,
	mode: ControlsMode = "enforce",
): Promise<ToolCallEventResult | undefined> {
	const cwd = ctx.cwd;

	// ── Bash ─────────────────────────────────────────────────────────────────
	if (event.toolName === "bash") {
		const input = event.input as { command: string };
		const stages = await parseCommand(input.command);
		const cmd = stages.map((s) => s.command).join(" | ");

		const matchResults: { action: Action; matchedPattern?: string }[] = [];
		const targets: string[] = [];
		let policyName: string | null = null;

		for (const stage of stages) {
			const explicitPaths = [...stage.redirectFiles, ...stage.pathArgs].map(
				(f) => normalizePath(f, cwd),
			);
			const stageTargets = explicitPaths.length > 0 ? explicitPaths : [cwd];

			for (const target of stageTargets) {
				targets.push(target);
				const resolved = resolvePolicy(target, cwd, config);
				if (resolved) {
					policyName = resolved.name;
					const result = matchRuleWithDetails(
						resolved.policy,
						"bash",
						stage.command,
					);
					matchResults.push({
						action: result.action,
						matchedPattern: result.matchedPattern,
					});
				}
			}
		}

		if (matchResults.length === 0) {
			await logDecision({
				ts: new Date().toISOString(),
				tool: "bash",
				command: cmd,
				cwd,
				targets,
				policyName: null,
				action: "pass",
			});
			return undefined;
		}

		const actions = matchResults.map((r) => r.action);
		const finalAction = mostRestrictive(actions);

		// Find the most specific matched pattern (prefer actions with patterns)
		const matchedPattern = matchResults
			.filter((r) => r.action === finalAction && r.matchedPattern !== undefined)
			.map((r) => r.matchedPattern!)
			.sort((a, b) => b.length - a.length)[0];

		const deniedTargets = finalAction === "deny" ? targets : [];

		await logDecision({
			ts: new Date().toISOString(),
			tool: "bash",
			command: cmd,
			cwd,
			targets,
			policyName,
			action: finalAction,
		});
		notifyDecision(
			ctx,
			finalAction,
			"bash",
			cmd,
			policyName,
			mode,
			deniedTargets,
			matchedPattern,
		);
		if (mode === "inform") return undefined;
		return executeAction(
			finalAction,
			"bash",
			cmd,
			ctx,
			deniedTargets,
			matchedPattern,
		);
	}

	// ── Non-bash ──────────────────────────────────────────────────────────────
	const targets = getTargetPaths(event, cwd);
	const actions: Action[] = [];
	let policyName: string | null = null;

	for (const target of targets) {
		const resolved = resolvePolicy(target, cwd, config);
		if (resolved) {
			policyName = resolved.name;
			actions.push(
				matchRuleWithDetails(resolved.policy, event.toolName, null).action,
			);
		}
	}

	if (actions.length === 0) {
		await logDecision({
			ts: new Date().toISOString(),
			tool: event.toolName,
			cwd,
			targets,
			policyName: null,
			action: "pass",
		});
		return undefined;
	}

	const finalAction = mostRestrictive(actions);
	await logDecision({
		ts: new Date().toISOString(),
		tool: event.toolName,
		cwd,
		targets,
		policyName,
		action: finalAction,
	});
	notifyDecision(
		ctx,
		finalAction,
		event.toolName,
		null,
		policyName,
		mode,
		targets,
	);
	if (mode === "inform") return undefined;
	return executeAction(finalAction, event.toolName, null, ctx, targets);
}
