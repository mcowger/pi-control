import { describe, expect, it, beforeAll, beforeEach, mock } from "bun:test"; // mock kept for ctx stubs
import { initBashParser } from "../../src/utils/bash-ast.js";
import { handleToolCall, pendingNudges, denyTracker } from "../../src/hooks/tool-call.js";
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

function bashEvent(command: string, id = "test-id"): BashToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: id,
		toolName: "bash",
		input: { command },
	};
}

function toolEvent(
	toolName: string,
	id = "test-id",
	extraInput: Record<string, unknown> = {},
): any {
	return {
		type: "tool_call",
		toolCallId: id,
		toolName,
		input: { ...extraInput },
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
	agentTimeout: null,
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

describe("nudge action", () => {
	const nudgeConfig: ControlsResolvedConfig = {
		policies: {
			nudged: {
				defaultAction: "allow",
				rules: [
					{
						action: "nudge",
						tool: "read",
						message: "use pluck_read instead",
					},
				],
			},
		},
		locations: { "/tmp": "nudged" },
		defaultPolicy: null,
		agentTimeout: null,
	};

	it("allows the tool call (returns undefined) when action is nudge", async () => {
		const event = toolEvent("read", "nudge-call-1", {
			file_path: "/tmp/foo.ts",
		});
		const result = await handleToolCall(event, makeCtx("/tmp"), nudgeConfig);
		expect(result).toBeUndefined();
	});

	it("registers a pending nudge keyed by toolCallId", async () => {
		pendingNudges.clear();
		const event = toolEvent("read", "nudge-call-2", {
			file_path: "/tmp/bar.ts",
		});
		await handleToolCall(event, makeCtx("/tmp"), nudgeConfig);
		expect(pendingNudges.get("nudge-call-2")).toBe("use pluck_read instead");
	});

	it("does not register a pending nudge for allowed (non-nudge) tools", async () => {
		pendingNudges.clear();
		const event = toolEvent("grep", "nudge-call-3");
		await handleToolCall(event, makeCtx("/tmp"), nudgeConfig);
		expect(pendingNudges.has("nudge-call-3")).toBe(false);
	});
});

describe("agentTimeout escalation (deny → ask)", () => {
	// All calls land on /home/user which has no location → defaultPolicy=locked (deny all).
	const timeoutConfig: ControlsResolvedConfig = {
		policies: {
			locked: { defaultAction: "deny", rules: [] },
		},
		locations: {},
		defaultPolicy: "locked",
		agentTimeout: { maxDenies: 3, windowSeconds: 60 },
	};

	// Config without agentTimeout — baseline to confirm deny stays deny.
	const noTimeoutConfig: ControlsResolvedConfig = {
		...timeoutConfig,
		agentTimeout: null,
	};

	beforeEach(() => {
		denyTracker.reset();
	});

	it("denies without escalation when below the threshold", async () => {
		// First 2 denies — below maxDenies=3, no escalation.
		const r1 = await handleToolCall(bashEvent("rm -rf /"), makeCtx("/home/user"), timeoutConfig);
		expect(r1).toEqual({ block: true, reason: expect.stringContaining("Access denied") });

		const r2 = await handleToolCall(bashEvent("rm -rf /"), makeCtx("/home/user"), timeoutConfig);
		expect(r2).toEqual({ block: true, reason: expect.stringContaining("Access denied") });
	});

	it("escalates to ask on the Nth denied call that meets the threshold", async () => {
		// Trigger threshold: record 3 denies — 3rd call should escalate.
		const ctx = makeCtx("/home/user");
		await handleToolCall(bashEvent("rm -rf /"), ctx, timeoutConfig);
		await handleToolCall(bashEvent("rm -rf /"), ctx, timeoutConfig);

		// The confirm stub returns true (user allows), so result is undefined (not blocked).
		const r3 = await handleToolCall(bashEvent("rm -rf /"), ctx, timeoutConfig);
		// ctx.ui.confirm was called (escalation happened); since mock returns true, not blocked.
		expect(r3).toBeUndefined();
		expect((ctx.ui.confirm as ReturnType<typeof mock>).mock.calls.length).toBe(1);
	});

	it("does not escalate when agentTimeout is null", async () => {
		// Even with 5 denies, no escalation without config.
		const ctx = makeCtx("/home/user");
		for (let i = 0; i < 5; i++) {
			const r = await handleToolCall(bashEvent("rm -rf /"), ctx, noTimeoutConfig);
			expect(r).toEqual({ block: true, reason: expect.stringContaining("Access denied") });
		}
		expect((ctx.ui.confirm as ReturnType<typeof mock>).mock.calls.length).toBe(0);
	});

	it("escalates for non-bash tools too", async () => {
		// write tool calls on /home/user → locked → deny → escalate on 3rd.
		const ctx = makeCtx("/home/user");
		await handleToolCall(toolEvent("write", "w1", { file_path: "/home/user/x" }), ctx, timeoutConfig);
		await handleToolCall(toolEvent("write", "w2", { file_path: "/home/user/x" }), ctx, timeoutConfig);

		const r3 = await handleToolCall(toolEvent("write", "w3", { file_path: "/home/user/x" }), ctx, timeoutConfig);
		expect(r3).toBeUndefined(); // confirm returned true → not blocked
		expect((ctx.ui.confirm as ReturnType<typeof mock>).mock.calls.length).toBe(1);
	});

	it("continues escalating after the threshold is met until the window expires", async () => {
		const ctx = makeCtx("/home/user");
		// Reach the threshold.
		await handleToolCall(bashEvent("rm /"), ctx, timeoutConfig);
		await handleToolCall(bashEvent("rm /"), ctx, timeoutConfig);
		await handleToolCall(bashEvent("rm /"), ctx, timeoutConfig); // 3rd → ask

		// 4th denied call should still escalate (tracker still above threshold).
		const r4 = await handleToolCall(bashEvent("rm /"), ctx, timeoutConfig);
		expect(r4).toBeUndefined(); // confirm returned true
		expect((ctx.ui.confirm as ReturnType<typeof mock>).mock.calls.length).toBe(2);
	});
});
