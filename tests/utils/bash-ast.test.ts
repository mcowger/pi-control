import { describe, expect, it, beforeAll } from "bun:test";
import { initBashParser, parseCommand } from "../../src/utils/bash-ast.js";

beforeAll(async () => {
	await initBashParser((msg) => console.warn(msg));
});

describe("parseCommand", () => {
	it("parses a simple command", async () => {
		const stages = await parseCommand("git status");
		expect(stages).toHaveLength(1);
		expect(stages[0].command).toBe("git status");
		expect(stages[0].redirectFiles).toHaveLength(0);
	});

	it("parses a command with a redirect target", async () => {
		const stages = await parseCommand("echo hello > /tmp/out.txt");
		expect(stages).toHaveLength(1);
		expect(stages[0].redirectFiles).toContain("/tmp/out.txt");
	});

	it("parses a piped command into multiple stages", async () => {
		const stages = await parseCommand("cat file.txt | grep foo");
		expect(stages.length).toBeGreaterThanOrEqual(2);
	});

	it("parses && separated commands", async () => {
		const stages = await parseCommand("git add . && git commit -m 'msg'");
		expect(stages.length).toBeGreaterThanOrEqual(2);
	});

	it("skips fd redirects like 2>&1", async () => {
		const stages = await parseCommand("make 2>&1");
		expect(stages[0].redirectFiles).toHaveLength(0);
	});

	it("returns a stage even for a bare command", async () => {
		const stages = await parseCommand("ls");
		expect(stages).toHaveLength(1);
		expect(stages[0].command).toBe("ls");
	});
});
