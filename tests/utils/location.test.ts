import { describe, expect, it } from "bun:test";
import { resolvePolicy } from "../../src/utils/location.js";
import type { ControlsResolvedConfig, Policy } from "../../src/config.js";

const strict: Policy = { defaultAction: "deny", rules: [] };
const relaxed: Policy = { defaultAction: "allow", rules: [] };

const config: ControlsResolvedConfig = {
	policies: { strict, relaxed },
	locations: {
		"/home/user/project": "strict",
		"/home/user": "relaxed",
		"/tmp": "relaxed",
	},
	defaultPolicy: null,
};

const cwd = "/home/user";

describe("resolvePolicy", () => {
	it("returns the exact location policy", () => {
		expect(resolvePolicy("/tmp/foo", cwd, config)?.policy).toBe(relaxed);
	});

	it("returns the policy name", () => {
		expect(resolvePolicy("/tmp/foo", cwd, config)?.name).toBe("relaxed");
	});

	it("returns the most specific location (project over user home)", () => {
		expect(resolvePolicy("/home/user/project/src/file.ts", cwd, config)?.policy).toBe(strict);
	});

	it("falls back to parent location", () => {
		expect(resolvePolicy("/home/user/other/file.ts", cwd, config)?.policy).toBe(relaxed);
	});

	it("returns null when no location matches and no defaultPolicy", () => {
		expect(resolvePolicy("/var/log/syslog", cwd, config)).toBeNull();
	});

	it("returns defaultPolicy when no location matches and defaultPolicy is set", () => {
		const cfg: ControlsResolvedConfig = { ...config, defaultPolicy: "relaxed" };
		expect(resolvePolicy("/var/log/syslog", cwd, cfg)?.policy).toBe(relaxed);
	});

	it("handles exact match on location path", () => {
		expect(resolvePolicy("/home/user", cwd, config)?.policy).toBe(relaxed);
	});

	it("returns null for unknown defaultPolicy name", () => {
		const cfg: ControlsResolvedConfig = { ...config, defaultPolicy: "nonexistent" };
		expect(resolvePolicy("/var/log/syslog", cwd, cfg)).toBeNull();
	});
});
