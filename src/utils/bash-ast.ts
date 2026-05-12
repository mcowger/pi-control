/**
 * Bash command parsing via bash-parser.
 *
 * Extracts, per pipeline stage (Command node):
 *   - The full command string (name + args)
 *   - File paths from redirect targets (skips fd-to-fd redirects)
 *
 * Falls back to a simple regex tokenizer if the parser fails.
 */

export interface CommandStage {
	/** Reconstructed command string for pattern matching. */
	command: string;
	/** File paths from redirect targets (e.g. `> /tmp/out.txt`). */
	redirectFiles: string[];
	/** Path-like non-flag arguments (e.g. `~`, `/tmp/foo`, `./bar`). */
	pathArgs: string[];
}

// bash-parser is CJS with no type declarations — import dynamically.
type BashParserFn = (src: string) => BashAST;

interface BashAST {
	type: "Script";
	commands: ASTNode[];
}

interface ASTNode {
	type: string;
	// Command
	name?: { text: string };
	suffix?: ASTNode[];
	// Redirect
	op?: { text: string };
	file?: { text: string };
	// Pipeline
	commands?: ASTNode[];
	// LogicalExpression / Pipe
	left?: ASTNode;
	right?: ASTNode;
}

// ─── Module state ────────────────────────────────────────────────────────────

let parserFn: BashParserFn | null = null;
let parserUnavailable = false;

export async function initBashParser(
	onWarning: (msg: string) => void,
): Promise<void> {
	try {
		const mod = await import("bash-parser");
		const fn = mod.default ?? mod;
		if (typeof fn !== "function")
			throw new Error("bash-parser: no default export");
		// Smoke-test.
		fn("echo test");
		parserFn = fn as BashParserFn;
	} catch (err) {
		parserUnavailable = true;
		onWarning(
			`[pi-controls] bash-parser failed to load (${err}). ` +
				"Falling back to regex tokenizer for bash command analysis.",
		);
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true for tokens that are likely filesystem paths rather than flags or bare words. */
function isPathLike(token: string): boolean {
	return (
		token === "~" ||
		token.startsWith("~/") ||
		token.startsWith("/") ||
		token.startsWith("./") ||
		token.startsWith("../")
	);
}

// ─── AST traversal ────────────────────────────────────────────────────────────

function extractFromNode(node: ASTNode, stages: CommandStage[]): void {
	switch (node.type) {
		case "Script":
			for (const cmd of node.commands ?? []) extractFromNode(cmd, stages);
			break;

		case "Command": {
			const parts: string[] = [];
			if (node.name?.text) parts.push(node.name.text);

			const redirectFiles: string[] = [];
			const pathArgs: string[] = [];
			for (const item of node.suffix ?? []) {
				if (item.type === "Redirect") {
					// Skip redirects with a numeric fd source (e.g. 2>/dev/null, 2>&1).
					const hasFdSource =
						item.numberIo !== undefined && item.numberIo !== null;
					if (!hasFdSource && item.file?.text)
						redirectFiles.push(item.file.text);
				} else if (item.type === "Word" && item.text !== undefined) {
					const text = (item as ASTNode & { text: string }).text;
					parts.push(text);
					// Collect path-like args for location resolution.
					if (isPathLike(text)) pathArgs.push(text);
				}
			}
			stages.push({ command: parts.join(" "), redirectFiles, pathArgs });
			break;
		}

		case "Pipeline":
			for (const cmd of node.commands ?? []) extractFromNode(cmd, stages);
			break;

		case "LogicalExpression":
			if (node.left) extractFromNode(node.left, stages);
			if (node.right) extractFromNode(node.right, stages);
			break;

		case "Subshell":
			for (const cmd of node.commands ?? []) extractFromNode(cmd, stages);
			break;
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function parseCommand(command: string): Promise<CommandStage[]> {
	if (!parserUnavailable && parserFn) {
		try {
			const ast = parserFn(command);
			const stages: CommandStage[] = [];
			extractFromNode(ast as unknown as ASTNode, stages);
			if (stages.length > 0) return stages;
		} catch {
			// Fall through to regex fallback.
		}
	}
	return regexFallback(command);
}

function regexFallback(command: string): CommandStage[] {
	const tokenRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
	const pathArgs: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = tokenRe.exec(command)) !== null) {
		const tok = m[1] ?? m[2] ?? m[3] ?? "";
		if (isPathLike(tok)) pathArgs.push(tok);
	}
	return [{ command, redirectFiles: [], pathArgs }];
}
