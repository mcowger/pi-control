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
import { DenyTracker } from "../utils/deny-tracker.js";

/**
 * Nudge messages pending injection into tool results, keyed by toolCallId.
 * Populated during tool_call handling; consumed during tool_result handling.
 */
export const pendingNudges = new Map<string, string>();

/**
 * Sliding-window deny counter for the agentTimeout circuit breaker.
 * Exported so tests can reset it between runs.
 */
export const denyTracker = new DenyTracker();

/**
 * Per-rule sliding-window nudge counters for the nudgeTimeout circuit breaker.
 * Keyed by "tool:pattern" (pattern omitted for non-bash rules). Exported so
 * tests can inspect and reset individual counters between runs.
 */
export const nudgeTrackers = new Map<string, DenyTracker>();

/** Return (creating if absent) the nudge tracker for a given rule key. */
function getNudgeTracker(key: string): DenyTracker {
	let tracker = nudgeTrackers.get(key);
	if (!tracker) {
		tracker = new DenyTracker();
		nudgeTrackers.set(key, tracker);
	}
	return tracker;
}

/**
 * Build the canonical key used to track nudge counts for a rule.
 * tool:pattern — pattern omitted for tool-level (non-bash) rules.
 */
export function nudgeKey(tool: string, pattern?: string): string {
	return pattern !== undefined ? `${tool}:${pattern}` : tool;
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

function buildContextSuffix(
	paths: string[],
	matchedPattern?: string,
	pathLabel = "blocked path",
): string {
	const parts: string[] = [];
	if (paths.length > 0) {
		const label = paths.length > 1 ? `${pathLabel}s` : pathLabel;
		parts.push(`${label}: ${paths.map((p) => `"${p}"`).join(", ")}`);
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
	nudgeMessage?: string,
): void {
	// In inform mode show everything (including allow) so user sees the full picture.
	// In enforce mode, allow is silent — only show non-allow decisions.
	if (mode !== "inform" && action === "allow") return;
	const policy = policyName ? ` [${policyName}]` : "";
	const cmd = command ? `: ${command.slice(0, 80)}` : "";
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
	if (action === "nudge" && nudgeMessage) {
		// Single line: no path label (not blocked), nudge message inline.
		ctx.ui.notify(`pi-controls: nudge${policy} — ${nudgeMessage}`, "warning");
	} else {
		// Use "path" for log/ask (not yet blocked); "blocked path" only for deny.
		const pathLabel = action === "deny" ? "blocked path" : "path";
		const context = buildContextSuffix(deniedPaths, matchedPattern, pathLabel);
		ctx.ui.notify(`pi-controls: ${label}${policy}${cmd}${context}`, type);
	}
}

async function executeAction(
	action: Action,
	toolName: string,
	command: string | null,
	ctx: ExtensionContext,
	deniedPaths: string[] = [],
	matchedPattern?: string,
	toolCallId?: string,
	nudgeMessage?: string,
	escalatedFromNudge?: string,
): Promise<ToolCallEventResult | undefined> {
	switch (action) {
		case "allow":
			return undefined;

		case "log":
			return undefined;

		case "nudge": {
			// Allow the tool call but register a message to be injected into the result.
			if (toolCallId && nudgeMessage) {
				pendingNudges.set(toolCallId, nudgeMessage);
			}
			return undefined;
		}

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
			const pathNote =
				deniedPaths.length > 0
					? ` The restriction is on the PATH${deniedPaths.length > 1 ? "S" : ""} ${deniedPaths.map((p) => `"${p}"`).join(", ")} — not on the tool. Do NOT retry with a different tool (read, ls, glob, cat, etc.); all access to these paths is blocked.`
					: " Do NOT retry with a different tool; this path is blocked regardless of which tool is used.";
			const nudgeNote = escalatedFromNudge
				? ` You were repeatedly warned: "${escalatedFromNudge}". You MUST switch approach now.`
				: "";
			return {
				block: true,
				reason: `[pi-controls] Access denied by policy: ${toolName}${cmdPart}${context}.${pathNote}${nudgeNote}`,
			};
		}
	}
}

/**
 * Apply the nudgeTimeout circuit breaker.
 *
 * If the resolved action is "nudge" and nudgeTimeout is configured:
 *  - Record the nudge in the per-rule tracker.
 *  - If the threshold has been reached for this rule, escalate to "deny" so
 *    the agent is forced to change approach. Reset the counter after escalation
 *    so the cycle can begin again if the agent keeps trying.
 *
 * Returns the (possibly escalated) action, and the nudge key used for tracking.
 */
function applyNudgeTimeout(
	action: Action,
	ruleKey: string,
	config: ControlsResolvedConfig,
	ctx: ExtensionContext,
): Action {
	if (action !== "nudge") return action;
	const timeout = config.nudgeTimeout;
	if (!timeout) return action;

	const tracker = getNudgeTracker(ruleKey);
	tracker.record();
	if (tracker.isTriggered(timeout.maxNudges, timeout.windowSeconds)) {
		tracker.reset();
		ctx.ui.notify(
			`[pi-controls] nudgeTimeout: repeated nudge ignored ${timeout.maxNudges} times — escalating to deny`,
			"error",
		);
		return "deny";
	}
	return action;
}

/**
 * Apply the agentTimeout circuit breaker.
 *
 * If the resolved action is "deny" and agentTimeout is configured:
 *  - Record the deny in the tracker.
 *  - If the threshold has been reached, escalate to "ask" so the user can
 *    step in and redirect the agent rather than letting it spin.
 *
 * Returns the (possibly escalated) action.
 */
function applyAgentTimeout(
	action: Action,
	config: ControlsResolvedConfig,
	ctx: ExtensionContext,
): Action {
	if (action !== "deny") return action;
	const timeout = config.agentTimeout;
	if (!timeout) return action;

	denyTracker.record();
	if (denyTracker.isTriggered(timeout.maxDenies, timeout.windowSeconds)) {
		ctx.ui.notify(
			`[pi-controls] agentTimeout: ${timeout.maxDenies} denies in ${timeout.windowSeconds}s — escalating to interactive confirm`,
			"warning",
		);
		return "ask";
	}
	return action;
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

		const matchResults: {
			action: Action;
			matchedPattern?: string;
			nudgeMessage?: string;
			ruleKey?: string;
		}[] = [];
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
						nudgeMessage: result.nudgeMessage,
						ruleKey: nudgeKey("bash", result.matchedPattern),
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

		// Pick the nudge message and rule key from any result that contributed to the final action.
		const nudgeMatch = matchResults.find(
			(r) => r.action === finalAction && r.nudgeMessage !== undefined,
		);
		const nudgeMessage = nudgeMatch?.nudgeMessage;
		const bashNudgeKey =
			nudgeMatch?.ruleKey ?? nudgeKey("bash", matchedPattern);

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
			nudgeMessage,
		);
		if (mode === "inform") return undefined;
		const effectiveBashAction = applyNudgeTimeout(
			applyAgentTimeout(finalAction, config, ctx),
			bashNudgeKey,
			config,
			ctx,
		);
		const bashEscalatedFromNudge =
			finalAction === "nudge" && effectiveBashAction === "deny"
				? nudgeMessage
				: undefined;
		return executeAction(
			effectiveBashAction,
			"bash",
			cmd,
			ctx,
			effectiveBashAction === "deny" ? targets : deniedTargets,
			matchedPattern,
			event.toolCallId,
			nudgeMessage,
			bashEscalatedFromNudge,
		);
	}

	// ── Non-bash ──────────────────────────────────────────────────────────────
	const targets = getTargetPaths(event, cwd);
	const matchResults: {
		action: Action;
		nudgeMessage?: string;
		ruleKey: string;
	}[] = [];
	let policyName: string | null = null;

	for (const target of targets) {
		const resolved = resolvePolicy(target, cwd, config);
		if (resolved) {
			policyName = resolved.name;
			const result = matchRuleWithDetails(
				resolved.policy,
				event.toolName,
				null,
			);
			matchResults.push({
				action: result.action,
				nudgeMessage: result.nudgeMessage,
				ruleKey: nudgeKey(event.toolName),
			});
		}
	}

	if (matchResults.length === 0) {
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

	const actions = matchResults.map((r) => r.action);
	const finalAction = mostRestrictive(actions);
	const nudgeMatch = matchResults.find(
		(r) => r.action === finalAction && r.nudgeMessage !== undefined,
	);
	const nudgeMessage = nudgeMatch?.nudgeMessage;
	const toolNudgeKey = nudgeMatch?.ruleKey ?? nudgeKey(event.toolName);

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
		undefined,
		nudgeMessage,
	);
	if (mode === "inform") return undefined;
	const effectiveAction = applyNudgeTimeout(
		applyAgentTimeout(finalAction, config, ctx),
		toolNudgeKey,
		config,
		ctx,
	);
	const escalatedFromNudge =
		finalAction === "nudge" && effectiveAction === "deny"
			? nudgeMessage
			: undefined;
	return executeAction(
		effectiveAction,
		event.toolName,
		null,
		ctx,
		effectiveAction === "deny" ? targets : [],
		undefined,
		event.toolCallId,
		nudgeMessage,
		escalatedFromNudge,
	);
}
