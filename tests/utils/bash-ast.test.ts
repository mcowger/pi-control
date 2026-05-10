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

	// Bug: path args like ~ were not extracted, so location resolution
	// always fell back to CWD instead of checking the actual target path.
	it("extracts ~ as a path arg", async () => {
		const stages = await parseCommand("ls -la ~");
		expect(stages[0].pathArgs).toContain("~");
	});

	it("extracts absolute path args", async () => {
		const stages = await parseCommand("cat /etc/hosts");
		expect(stages[0].pathArgs).toContain("/etc/hosts");
	});

	it("extracts multiple path args", async () => {
		const stages = await parseCommand("rm /tmp/foo /home/user/bar");
		expect(stages[0].pathArgs).toContain("/tmp/foo");
		expect(stages[0].pathArgs).toContain("/home/user/bar");
	});

	it("extracts ./ and ../ path args", async () => {
		const stages = await parseCommand("cp ./src ../dest");
		expect(stages[0].pathArgs).toContain("./src");
		expect(stages[0].pathArgs).toContain("../dest");
	});

	it("does not extract flags as path args", async () => {
		const stages = await parseCommand("ls -la --color=auto");
		expect(stages[0].pathArgs).toHaveLength(0);
	});

	it("does not extract bare words as path args", async () => {
		const stages = await parseCommand("git status");
		expect(stages[0].pathArgs).toHaveLength(0);
	});

	// Regression: 2>/dev/null was treated as a file redirect target, causing
	// /dev/null to be checked against location policies and denied.
	it("does not extract numeric fd redirects like 2>/dev/null as redirect files", async () => {
		const stages = await parseCommand("ls /tmp 2>/dev/null");
		expect(stages[0].redirectFiles).toHaveLength(0);
	});

	it("still extracts plain stdout redirects as redirect files", async () => {
		const stages = await parseCommand("ls /tmp > /tmp/out.txt");
		expect(stages[0].redirectFiles).toContain("/tmp/out.txt");
	});
});
