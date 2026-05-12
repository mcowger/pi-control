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
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import stripJsonComments from "strip-json-comments";
import { SAFE_BASH_PATTERNS } from "./utils/safe-commands.js";

// ─── Schema types ─────────────────────────────────────────────────────────────

export type Action = "allow" | "ask" | "deny" | "log";

export interface Rule {
	action: Action;
	tool: string;
	pattern?: string; // bash only
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

export interface ControlsConfig {
	policies?: Record<string, Policy>;
	locations?: Record<string, string>;
	/**
	 * Fallback policy name when no location matches.
	 * null / absent = fail-open (all tool calls proceed unrestricted).
	 */
	defaultPolicy?: string | null;
}

export interface ControlsResolvedConfig {
	policies: Record<string, Policy>;
	locations: Record<string, string>;
	defaultPolicy: string | null;
}

const DEFAULTS: ControlsResolvedConfig = {
	policies: {},
	locations: {},
	defaultPolicy: null,
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
		const piDir = resolve(dir, ".pi");
		if (existsSync(piDir) && statSync(piDir).isDirectory()) {
			for (const name of FILENAMES) {
				const p = resolve(piDir, `extensions/${name}`);
				if (existsSync(p)) return p;
			}
			// Not found yet — return the canonical .jsonc path for writes.
			return resolve(piDir, "extensions/pi-controls.jsonc");
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
		const merged = structuredClone(DEFAULTS) as Record<string, unknown>;

		const globalCfg = await readJsonc(findGlobalPath());
		if (globalCfg) deepMerge(merged, globalCfg as Record<string, unknown>);

		const localPath = findLocalPath();
		if (localPath) {
			const localCfg = await readJsonc(localPath);
			if (localCfg) deepMerge(merged, localCfg as Record<string, unknown>);
		}

		const raw = merged as unknown as ControlsResolvedConfig;
		this.resolved = { ...raw, policies: expandPolicies(raw.policies) };
	}

	getConfig(): ControlsResolvedConfig {
		return this.resolved;
	}
}

export function createConfigLoader(): ControlsConfigLoader {
	return new ControlsConfigLoader();
}
