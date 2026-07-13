/**
 * Config schema and JSONC loader for pi-controls.
 *
 * Config file: pi-controls.jsonc  (falls back to pi-controls.json)
 * Global:  getAgentDir()/extensions/pi-controls.jsonc
 * Local:   .pi/extensions/pi-controls.jsonc  (walks up from CWD)
 *
 * Local definitions win on conflict (deep merge: global → local).
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import stripJsonComments from "strip-json-comments";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SAFE_BASH_PATTERNS } from "./utils/safe-commands.js";

// ─── Schema types ─────────────────────────────────────────────────────────────

export type Action = "allow" | "ask" | "deny" | "log" | "nudge";

export interface Rule {
	action: Action;
	tool: string;
	pattern?: string; // bash only
	/** Required when action is "nudge": the reminder message injected into the tool result. */
	message?: string;
	/**
	 * Permit a matching `allow` Bash rule to bypass the fallback action for
	 * interpreter source that cannot be statically analyzed. Use only for a
	 * command pattern whose source execution you explicitly trust.
	 */
	allowUnanalyzed?: boolean;
}

export interface Policy {
	defaultAction: Action;
	rules: Rule[];
}

// ─── Preset expansion ─────────────────────────────────────────────────────────
//
// A rule with pattern "$safe-bash" expands to one allow rule per safe command.
// Example: { "action": "allow", "tool": "bash", "pattern": "$safe-bash" }

const PATTERN_PRESETS: Record<string, string[]> = {
	"$safe-bash": SAFE_BASH_PATTERNS,
};

function expandRules(rules: Rule[]): Rule[] {
	return rules.flatMap((rule) => {
		if (rule.pattern && rule.pattern in PATTERN_PRESETS) {
			return PATTERN_PRESETS[rule.pattern].map((pattern) => ({
				...rule,
				pattern,
			}));
		}
		return [rule];
	});
}

function expandPolicies(
	policies: Record<string, Policy>,
): Record<string, Policy> {
	const expanded: Record<string, Policy> = {};
	for (const [name, policy] of Object.entries(policies)) {
		expanded[name] = { ...policy, rules: expandRules(policy.rules) };
	}
	return expanded;
}

/**
 * Configures automatic deny→ask escalation when the agent is denied too many
 * times in a rolling window (the "rogue agent" circuit breaker).
 *
 * When the agent accumulates `maxDenies` denied tool calls within
 * `windowSeconds` seconds, the *next* denied call is escalated from an
 * automatic "deny" to an interactive "ask", giving the user a chance to step
 * in and redirect the agent.
 *
 * The window is sliding: only denies within the last `windowSeconds` seconds
 * count. The escalation resets as soon as the window empties.
 */
export interface AgentTimeout {
	/** Number of denied calls within `windowSeconds` that triggers escalation. */
	maxDenies: number;
	/** Rolling window size in seconds. */
	windowSeconds: number;
}

/**
 * Configures automatic nudge→deny escalation when the agent ignores nudges
 * too many times for the same rule in a rolling window.
 *
 * When the same nudge rule fires `maxNudges` times within `windowSeconds`
 * seconds, the next occurrence is escalated to a hard deny with a strong
 * message demanding the agent change its approach. The per-rule counter resets
 * after escalation.
 */
export interface NudgeTimeout {
	/** Number of nudges for the same rule within `windowSeconds` that triggers escalation. */
	maxNudges: number;
	/** Rolling window size in seconds. */
	windowSeconds: number;
}

export interface InterpreterAnalysisConfig {
	/** Enable analysis of source supplied to Python, Node, Bun, and shell wrappers. */
	enabled: boolean;
	/** Conservative action when analysis cannot prove all effects and targets. */
	unknownAction: "ask" | "deny";
	/** Maximum embedded source size accepted for analysis. */
	maxSourceBytes: number;
	/** Maximum nested shell-wrapper depth. */
	maxDepth: number;
	/** Maximum syntax-tree nodes visited per source. */
	maxNodes: number;
}

export interface ControlsConfig {
	policies?: Record<string, Policy>;
	locations?: Record<string, string>;
	/**
	 * Fallback policy name when no location matches.
	 * null / absent = fail-open (all tool calls proceed unrestricted).
	 */
	defaultPolicy?: string | null;
	/**
	 * Keyboard shortcut for cycling through enforce → ignore → inform modes.
	 * Must be a valid pi KeyId string (e.g. "ctrl+shift+m", "alt+p").
	 * Defaults to "ctrl+shift+m" when absent.
	 */
	cycleKey?: string;
	/**
	 * Optional circuit-breaker: escalate deny→ask when the agent is denied
	 * too many times in a rolling window.
	 */
	agentTimeout?: AgentTimeout | null;
	/**
	 * Optional circuit-breaker: escalate nudge→deny when the agent ignores
	 * the same nudge rule too many times in a rolling window.
	 */
	nudgeTimeout?: NudgeTimeout | null;
	/**
	 * Cross-cutting path protection — patterns matched against file paths
	 * BEFORE location-based policies. A "deny" here blocks the tool call
	 * regardless of which tool is used (read, write, edit, bash, etc.).
	 *
	 * Patterns use minimatch globs (e.g. "*.env", "~/.ssh/*", "**&#47;secrets/**").
	 * This is the correct place to protect sensitive files from ALL tools.
	 */
	pathProtection?: Record<string, Action> | null;
	/** Conservative static analysis for source hidden in interpreter invocations. */
	interpreterAnalysis?: Partial<InterpreterAnalysisConfig> | null;
}

export interface ControlsResolvedConfig {
	policies: Record<string, Policy>;
	locations: Record<string, string>;
	defaultPolicy: string | null;
	cycleKey: string;
	agentTimeout: AgentTimeout | null;
	nudgeTimeout: NudgeTimeout | null;
	pathProtection: Record<string, Action> | null;
	/** Optional here so hand-built configs remain source compatible; the loader always supplies defaults. */
	interpreterAnalysis?: InterpreterAnalysisConfig | null;
}

export const DEFAULT_INTERPRETER_ANALYSIS: InterpreterAnalysisConfig = {
	enabled: true,
	unknownAction: "ask",
	maxSourceBytes: 256 * 1024,
	maxDepth: 4,
	maxNodes: 10_000,
};

function resolveInterpreterAnalysis(
	value: Partial<InterpreterAnalysisConfig> | null | undefined,
): InterpreterAnalysisConfig | null {
	if (value === null) return null;
	return {
		enabled: value?.enabled !== false,
		unknownAction: value?.unknownAction === "deny" ? "deny" : "ask",
		maxSourceBytes:
			typeof value?.maxSourceBytes === "number" && value.maxSourceBytes > 0
				? value.maxSourceBytes
				: DEFAULT_INTERPRETER_ANALYSIS.maxSourceBytes,
		maxDepth:
			typeof value?.maxDepth === "number" && value.maxDepth >= 0
				? value.maxDepth
				: DEFAULT_INTERPRETER_ANALYSIS.maxDepth,
		maxNodes:
			typeof value?.maxNodes === "number" && value.maxNodes > 0
				? value.maxNodes
				: DEFAULT_INTERPRETER_ANALYSIS.maxNodes,
	};
}

const DEFAULTS: ControlsResolvedConfig = {
	policies: {},
	locations: {},
	defaultPolicy: null,
	cycleKey: "ctrl+shift+m",
	agentTimeout: null,
	nudgeTimeout: null,
	pathProtection: null,
	interpreterAnalysis: DEFAULT_INTERPRETER_ANALYSIS,
};

// ─── File discovery ───────────────────────────────────────────────────────────

const FILENAMES = ["pi-controls.jsonc", "pi-controls.json"];

function findGlobalPath(): string {
	const base = resolve(getAgentDir(), "extensions");
	for (const name of FILENAMES) {
		const p = resolve(base, name);
		if (existsSync(p)) return p;
	}
	// Default to .jsonc for new files.
	return resolve(base, "pi-controls.jsonc");
}

function findLocalPath(): string | null {
	let dir = process.cwd();
	const home = homedir();
	while (true) {
		if (dir === home) break;
		for (const dirName of [".pi"]) {
			const piDir = resolve(dir, dirName);
			if (existsSync(piDir) && statSync(piDir).isDirectory()) {
				for (const name of FILENAMES) {
					const p = resolve(piDir, `extensions/${name}`);
					if (existsSync(p)) return p;
				}
				// Not found yet — return the canonical .jsonc path for writes.
				return resolve(piDir, "extensions/pi-controls.jsonc");
			}
		}
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// ─── Deep merge ───────────────────────────────────────────────────────────────

function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): void {
	for (const key of Object.keys(source)) {
		const sv = source[key];
		if (sv === undefined) continue;
		if (sv !== null && typeof sv === "object" && !Array.isArray(sv)) {
			if (!target[key] || typeof target[key] !== "object") target[key] = {};
			deepMerge(
				target[key] as Record<string, unknown>,
				sv as Record<string, unknown>,
			);
		} else {
			target[key] = sv;
		}
	}
}

// ─── Loader ───────────────────────────────────────────────────────────────────

async function readJsonc(path: string): Promise<ControlsConfig | null> {
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(stripJsonComments(raw)) as ControlsConfig;
	} catch {
		return null;
	}
}

export class ControlsConfigLoader {
	private resolved: ControlsResolvedConfig = structuredClone(DEFAULTS);

	async load(): Promise<void> {
		const merged = structuredClone(DEFAULTS) as unknown as Record<
			string,
			unknown
		>;

		const globalCfg = await readJsonc(findGlobalPath());
		if (globalCfg) deepMerge(merged, globalCfg as Record<string, unknown>);

		const localPath = findLocalPath();
		if (localPath) {
			const localCfg = await readJsonc(localPath);
			if (localCfg) deepMerge(merged, localCfg as Record<string, unknown>);
		}

		const raw = merged as unknown as ControlsResolvedConfig;
		this.resolved = {
			...raw,
			policies: expandPolicies(raw.policies),
			interpreterAnalysis: resolveInterpreterAnalysis(raw.interpreterAnalysis),
		};
	}

	getConfig(): ControlsResolvedConfig {
		return this.resolved;
	}
}

export function createConfigLoader(): ControlsConfigLoader {
	return new ControlsConfigLoader();
}
