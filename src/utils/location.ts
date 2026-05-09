import { normalizePath } from "./path.js";
import type { ControlsResolvedConfig, Policy } from "../config.js";

/**
 * Given a target path and the loaded config, return the applicable Policy
 * (most specific matching location wins). Returns null if no location matches
 * and there is no defaultPolicy.
 */
export function resolvePolicy(
	targetPath: string,
	cwd: string,
	config: ControlsResolvedConfig,
): Policy | null {
	const normalTarget = normalizePath(targetPath, cwd);

	let bestMatch: string | null = null;

	for (const locationPath of Object.keys(config.locations)) {
		const normalLocation = normalizePath(locationPath, cwd);

		// Target must be equal to or nested inside the location directory.
		if (
			normalTarget === normalLocation ||
			normalTarget.startsWith(`${normalLocation}/`)
		) {
			// Longest (most specific) location wins.
			if (bestMatch === null || normalLocation.length > bestMatch.length) {
				bestMatch = normalLocation;
				// Store normalised key so we can look up the policy name.
				// Re-map: find the original key that normalises to bestMatch.
			}
		}
	}

	// Look up the original key whose normalised form equals bestMatch.
	const policyName = bestMatch
		? (() => {
				for (const [k, v] of Object.entries(config.locations)) {
					if (normalizePath(k, cwd) === bestMatch) return v;
				}
				return null;
			})()
		: null;

	if (policyName) {
		return config.policies[policyName] ?? null;
	}

	// Fall back to the global defaultPolicy.
	if (config.defaultPolicy) {
		return config.policies[config.defaultPolicy] ?? null;
	}

	return null;
}
