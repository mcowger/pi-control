import { minimatch } from "minimatch";
import type { Action, Policy, Rule } from "../config.js";

// ─── Glob helpers ────────────────────────────────────────────────────────────

/** Match a tool name against a tool glob pattern (e.g. "github_*"). */
function matchTool(pattern: string, toolName: string): boolean {
	return minimatch(toolName, pattern, { nocase: false, dot: true });
}

/**
 * Match a bash command string against a command pattern (e.g. "git commit *").
 * We convert single `*` → `**` so the wildcard spans slashes and spaces.
 */
function matchCommand(pattern: string, command: string): boolean {
	// Replace `*` that is NOT already `**` with `**`.
	const expanded = pattern.replace(/(?<!\*)\*(?!\*)/g, "**");
	return minimatch(command, expanded, { nocase: false, dot: true });
}

// ─── Specificity scoring ─────────────────────────────────────────────────────

/**
 * Count literal characters before the first wildcard (`*` or `?`).
 * Used to rank rules: higher score = more specific.
 */
export function specificityScore(pattern: string): number {
	const idx = pattern.search(/[*?]/);
	return idx === -1 ? pattern.length : idx;
}

/** Tiebreaker: lower number = higher priority in a tie. */
const ACTION_PRIORITY: Record<Action, number> = {
	allow: 0,
	ask: 1,
	deny: 2,
	log: 3,
};

// ─── Rule matching ────────────────────────────────────────────────────────────

/**
 * Find the winning action for a tool call within a single policy.
 * Returns the policy's defaultAction if no rule matches.
 */
export function matchRule(
	policy: Policy,
	toolName: string,
	command: string | null, // null for non-bash tools
): Action {
	let bestScore = -1;
	let bestPriority = Number.MAX_SAFE_INTEGER;
	let bestAction: Action | null = null;

	for (const rule of policy.rules) {
		// Tool glob must match.
		if (!matchTool(rule.tool, toolName)) continue;

		// For bash, the command pattern must also match (if specified).
		if (toolName === "bash" && rule.pattern !== undefined) {
			if (command === null || !matchCommand(rule.pattern, command)) continue;
		}

		const scorePattern = toolName === "bash" && rule.pattern !== undefined
			? rule.pattern
			: rule.tool;
		const score = specificityScore(scorePattern);
		const priority = ACTION_PRIORITY[rule.action];

		if (
			score > bestScore ||
			(score === bestScore && priority < bestPriority)
		) {
			bestScore = score;
			bestPriority = priority;
			bestAction = rule.action;
		}
	}

	return bestAction ?? policy.defaultAction;
}

// ─── Multi-target resolution ──────────────────────────────────────────────────

/** Restrictiveness order: deny > ask > log > allow */
const RESTRICTIVENESS: Action[] = ["deny", "ask", "log", "allow"];

/**
 * Given actions from multiple policies (one per target), return the most
 * restrictive one.
 */
export function mostRestrictive(actions: Action[]): Action {
	for (const a of RESTRICTIVENESS) {
		if (actions.includes(a)) return a;
	}
	return "allow";
}
