import { describe, expect, it, beforeAll, mock } from "bun:test"; // mock kept for ctx stubs
import { initBashParser } from "../../src/utils/bash-ast.js";
import { handleToolCall } from "../../src/hooks/tool-call.js";
import type { ControlsResolvedConfig } from "../../src/config.js";
import type {
	BashToolCallEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

beforeAll(async () => {
	await initBashParser((msg) => console.warn(msg));
});

// Minimal ExtensionContext stub.
function makeCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		ui: {
			notify: mock(() => {}),
			confirm: mock(async () => true),
			setStatus: mock(() => {}),
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	} as any;
}

function bashEvent(command: string): BashToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "test-id",
		toolName: "bash",
		input: { command },
	};
}

// Config where:
//   /tmp  → open  (allow everything)
//   everything else → locked (deny everything)
const config: ControlsResolvedConfig = {
	policies: {
		open: { defaultAction: "allow", rules: [] },
		locked: { defaultAction: "deny", rules: [] },
	},
	locations: {
		"/tmp": "open",
	},
	defaultPolicy: "locked",
};

describe("tool-call handler — path arg location resolution", () => {
	// Bug regression: before the fix, `ls -la ~` used CWD for location resolution.
	// If CWD was under an allowed location, commands targeting restricted paths
	// were incorrectly allowed.
	it("denies ls -la ~ when home dir is not in any location (falls to locked defaultPolicy)", async () => {
		// CWD is /tmp (open), but ~ is the home dir which matches no location → locked.
		const result = await handleToolCall(
			bashEvent("ls -la ~"),
			makeCtx("/tmp"),
			config,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
	});

	it("allows ls /tmp/foo when /tmp is open, even from a locked CWD", async () => {
		// CWD is /home/user (no location → locked), but the path arg is under /tmp (open).
		const result = await handleToolCall(
			bashEvent("ls /tmp/foo"),
			makeCtx("/home/user"),
			config,
		);
		expect(result).toBeUndefined();
	});

	it("denies when one path arg is locked even if another is open", async () => {
		// cp from /tmp (open) to ~ (locked) — most restrictive wins.
		const result = await handleToolCall(
			bashEvent("cp /tmp/foo ~"),
			makeCtx("/tmp"),
			config,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
	});

	it("uses CWD when command has no path args or redirects", async () => {
		// No path args — CWD /tmp is open.
		const result = await handleToolCall(
			bashEvent("git status"),
			makeCtx("/tmp"),
			config,
		);
		expect(result).toBeUndefined();
	});

	it("uses CWD when command has no path args or redirects and CWD is locked", async () => {
		// No path args — CWD /home/user has no location → locked.
		const result = await handleToolCall(
			bashEvent("git status"),
			makeCtx("/home/user"),
			config,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
	});
});
