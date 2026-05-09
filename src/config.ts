/**
 * Config schema and loader for pi-controls.
 *
 * Config file: pi-controls.json
 * Global:  getAgentDir()/extensions/pi-controls.json
 * Local:   .pi/extensions/pi-controls.json (walks up from CWD)
 *
 * Local definitions win on conflict (deep merge, local > global).
 */

import { ConfigLoader } from "@aliou/pi-utils-settings";

// ─── Raw config types (what users write) ────────────────────────────────────

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

/** Raw shape written by users in pi-controls.json */
export interface ControlsConfig {
	/** Named policies. */
	policies?: Record<string, Policy>;
	/** Maps filesystem paths to policy names. */
	locations?: Record<string, string>;
	/**
	 * Fallback policy name when no location matches.
	 * null = fail-open (all tool calls proceed).
	 */
	defaultPolicy?: string | null;
}

// ─── Resolved config (after merge + defaults) ────────────────────────────────

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

// ─── Loader ──────────────────────────────────────────────────────────────────

export function createConfigLoader(): ConfigLoader<ControlsConfig, ControlsResolvedConfig> {
	return new ConfigLoader<ControlsConfig, ControlsResolvedConfig>("pi-controls", DEFAULTS);
}
