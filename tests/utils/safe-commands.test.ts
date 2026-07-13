import { describe, expect, it } from "bun:test";
import { SAFE_BASH_PATTERNS } from "../../src/utils/safe-commands.js";

describe("SAFE_BASH_PATTERNS", () => {
	it("excludes inline interpreter evaluation", () => {
		for (const pattern of [
			"python -c *",
			"python3 -c *",
			"node -e *",
			"node --eval *",
			"bun -e *",
			"bun --eval *",
			"deno eval *",
		]) {
			expect(SAFE_BASH_PATTERNS).not.toContain(pattern);
		}
	});
});
