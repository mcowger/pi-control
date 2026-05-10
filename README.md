# pi-controls

A [pi](https://github.com/earendil-works/pi) extension that enforces action-based policies on tool calls, scoped by filesystem location.

When the agent tries to run a bash command, read a file, write to a path, or call any other tool, pi-controls checks which policy governs that location and either allows, logs, asks for confirmation, or denies the call — before execution.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Config File Locations](#config-file-locations)
- [Core Concepts](#core-concepts)
  - [Policies](#policies)
  - [Rules](#rules)
  - [Actions](#actions)
  - [Locations](#locations)
- [Rule Matching and Specificity](#rule-matching-and-specificity)
- [Multi-Target Resolution](#multi-target-resolution)
- [Bash Command Parsing](#bash-command-parsing)
- [Safe Command Patterns](#safe-command-patterns)
- [Examples](#examples)
  - [Protect production configs](#protect-production-configs)
  - [Audit-only mode](#audit-only-mode)
  - [Interactive gate on destructive commands](#interactive-gate-on-destructive-commands)
  - [Allow git, block everything else](#allow-git-block-everything-else)
  - [GitHub tool lockdown](#github-tool-lockdown)
  - [Per-project policy with global fallback](#per-project-policy-with-global-fallback)
  - [Layered home and project policies](#layered-home-and-project-policies)
  - [Redirect-aware bash policies](#redirect-aware-bash-policies)
  - [Mixed restrictiveness across pipeline stages](#mixed-restrictiveness-across-pipeline-stages)
- [Config Reference](#config-reference)
- [Development](#development)

---

## Installation

pi-controls is installed via pi's built-in package manager using the `git:` source prefix. No npm publish required.

### Global install (all projects)

```sh
pi install git:github.com/mcowger/pi-controls
```

This clones the repo, runs `bun install`, and records the package in `~/.pi/agent/settings.json`. The extension is active in every pi session.

### Project-local install

```sh
pi install git:github.com/mcowger/pi-controls --local
```

Same as above but records the package in `.pi/settings.json` in the current directory. Only active when pi runs from that project.

### Pinning to a specific version

Append `@<ref>` to pin to a branch, tag, or commit. Pinned packages are excluded from `pi update`.

```sh
pi install git:github.com/mcowger/pi-controls@v1.0.0
pi install git:github.com/mcowger/pi-controls@main
pi install git:github.com/mcowger/pi-controls@abc1234
```

### Updating

```sh
pi update                             # update all packages
pi update git:github.com/mcowger/pi-controls  # update this package only
```

### Removing

```sh
pi remove git:github.com/mcowger/pi-controls
pi remove git:github.com/mcowger/pi-controls --local  # project-local
```

---

## Quick Start

Create `~/.pi/agent/extensions/pi-controls.json`:

```json
{
  "policies": {
    "strict": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "git *" },
        { "action": "ask",   "tool": "bash", "pattern": "git push *" },
        { "action": "deny",  "tool": "bash", "pattern": "rm *" }
      ]
    }
  },
  "locations": {
    "/home/user/work": "strict"
  }
}
```

Any tool call made while the agent's target is inside `/home/user/work` now follows the `strict` policy. Reads are allowed, git commands are allowed (pushes need confirmation), `rm` is denied, and everything else is denied by the `defaultAction`.

---

## Config File Locations

pi-controls loads config from two places and deep-merges them. **Project-local wins on conflict.**

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/extensions/pi-controls.jsonc` |
| Project-local | `.pi/extensions/pi-controls.jsonc` (walks up from CWD) |

Config files use **JSONC** (JSON with Comments), so `//` and `/* */` comments are supported. Plain `.json` is also accepted as a fallback.

See [`examples/sample.jsonc`](examples/sample.jsonc) for a fully annotated starting point.

This means you can define your base policies globally and override or extend them per project.

**Global** (`~/.pi/agent/extensions/pi-controls.jsonc`):
```json
{
  "policies": {
    "default": {
      "defaultAction": "allow",
      "rules": [
        { "action": "ask", "tool": "bash", "pattern": "rm *" }
      ]
    }
  },
  "locations": {
    "/home/user": "default"
  }
}
```

**Project-local** (`.pi/extensions/pi-controls.jsonc` at project root):
```json
{
  "policies": {
    "strict": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "git *" }
      ]
    }
  },
  "locations": {
    "/home/user/work/myproject": "strict"
  }
}
```

At runtime both `default` and `strict` are available. `/home/user/work/myproject` uses `strict`; the rest of `/home/user` uses `default`.

---

## Core Concepts

### Policies

A **policy** is a named set of rules with a `defaultAction` that applies when no rule matches.

```json
{
  "policies": {
    "my-policy": {
      "defaultAction": "deny",
      "rules": [ ... ]
    }
  }
}
```

Policies are referenced by name from `locations`. You can define as many as you need — one per project, one per risk tier, etc.

### Rules

Each rule has:

| Field | Required | Description |
|-------|----------|-------------|
| `action` | always | `"allow"`, `"ask"`, `"deny"`, or `"log"` |
| `tool` | always | Tool name or glob (e.g. `"bash"`, `"github_*"`, `"*"`) |
| `pattern` | bash only | Glob matched against the full command string |

`pattern` is only evaluated when `tool` is `"bash"`. For all other tools, the location boundary is the only scope — no pattern is needed or used.

```json
{ "action": "allow", "tool": "read" }
{ "action": "deny",  "tool": "write" }
{ "action": "ask",   "tool": "bash", "pattern": "git push *" }
{ "action": "log",   "tool": "github_*" }
{ "action": "deny",  "tool": "*" }
```

### Actions

| Action | Behavior |
|--------|----------|
| `allow` | Silent permit. Tool call proceeds with no interruption. |
| `log` | Tool call proceeds, but a notification is shown in the pi UI. Useful for auditing. |
| `ask` | Execution pauses and pi asks for confirmation. Approved → proceeds. Denied → blocked, and the LLM receives a reason message. |
| `deny` | Tool call is blocked immediately. The LLM receives a reason message. |

`defaultAction` follows the same four behaviors and is used when no rule in the policy matches the current tool call.

### Locations

A **location** maps a filesystem path to a policy name. The most specific (longest) matching path wins.

```json
{
  "locations": {
    "/home/user/work/secret-project": "strict",
    "/home/user/work":                "relaxed",
    "/home/user":                     "permissive"
  }
}
```

A tool call targeting `/home/user/work/secret-project/src/main.ts` matches all three locations, but `/home/user/work/secret-project` is longest, so `strict` applies.

**Fallback:** if no location matches, the global `defaultPolicy` is used. If that is also unset (or `null`), the call proceeds unrestricted (fail-open).

```json
{
  "defaultPolicy": "relaxed"
}
```

---

## Rule Matching and Specificity

Rules within a policy do not have an explicit order. Instead, pi-controls scores each matching rule by **specificity** and picks the winner automatically.

**Specificity = number of literal characters before the first wildcard.**

| Pattern | Score |
|---------|-------|
| `"git commit *"` | 11 |
| `"git *"` | 4 |
| `"*"` | 0 |
| `"github_create_pull_request"` | 26 (no wildcard) |
| `"github_*"` | 7 |

**Example:** given these two rules in the same policy:

```json
{ "action": "allow", "tool": "bash", "pattern": "git *" },
{ "action": "ask",   "tool": "bash", "pattern": "git commit *" }
```

Running `git commit -m "fix"`:
- Both patterns match.
- `"git commit *"` scores 11, `"git *"` scores 4.
- Score 11 wins → **ask**.

Running `git status`:
- Only `"git *"` matches (score 4).
- Result → **allow**.

**Tiebreaker:** when two rules have the same specificity score, `allow > ask > deny > log`. This means the least-disruptive action wins ties — you never accidentally block something more than the rules intend.

```json
{ "action": "allow", "tool": "bash", "pattern": "git *" },
{ "action": "deny",  "tool": "bash", "pattern": "git *" }
```

Both score 4. Tiebreaker: **allow** wins.

---

## Multi-Target Resolution

When a bash command touches files in multiple locations — through redirect targets — each location's policy is evaluated independently. The **most restrictive** action across all of them wins.

Restrictiveness order: `deny > ask > log > allow`

**Example config:**

```json
{
  "policies": {
    "strict":  { "defaultAction": "deny",  "rules": [] },
    "relaxed": { "defaultAction": "allow", "rules": [] }
  },
  "locations": {
    "/home/user/project": "strict",
    "/tmp":               "relaxed"
  }
}
```

**Command:** `cat /home/user/project/secrets.txt > /tmp/out.txt`

- The redirect target `/tmp/out.txt` → `relaxed` → **allow**
- The source file `/home/user/project/secrets.txt` → `strict` → **deny**
- Most restrictive: **deny**

Even though `/tmp` is relaxed, the fact that the command touches a strict location locks the whole operation.

---

## Bash Command Parsing

Bash commands are parsed using [bash-parser](https://www.npmjs.com/package/bash-parser), which produces a full AST with command names, arguments, and redirect targets.

From each pipeline stage, pi-controls extracts:
- **Command name + arguments** — used for pattern matching against bash rules
- **File redirect targets** — paths like `> /tmp/out.txt` or `>> log.txt` checked against location policies
- **fd-to-fd redirects** like `2>&1` — recognized and skipped (they don't target files)

Each pipeline stage (`|`, `&&`, `;`) is evaluated independently. The most restrictive action across all stages wins.

**If parsing fails** (malformed input), pi-controls falls back to a regex tokenizer that treats the raw command string as a single stage with no redirect targets. This is conservative — the command is still checked against the CWD policy.

**If bash-parser fails to load at startup**, a warning is shown in the pi UI and the regex fallback is used for all bash calls.

---

## Safe Command Patterns

pi-controls ships a built-in preset, `"$safe-bash"`, that expands to ~90 allow rules for non-mutating bash commands. Use it anywhere in a `rules` array instead of listing the patterns by hand.

The preset covers:

| Category | Examples |
|----------|----------|
| File reading | `cat *`, `head *`, `tail *`, `xxd *` |
| File metadata | `ls *`, `stat *`, `du *`, `df *`, `find *` |
| Search | `grep *`, `rg *`, `ag *` |
| Text processing | `wc *`, `sort *`, `diff *`, `jq *`, `yq *` |
| Git (read-only) | `git status`, `git log *`, `git diff *`, `git blame *` |
| System info | `echo *`, `env`, `which *`, `ps *`, `uname *` |
| Package info | `npm list *`, `pip show *`, `bun pm ls *` |

The list is intentionally conservative. Commands that can mutate files under certain flags (e.g. `sed -i`, `awk` with output redirection) are excluded.

### Usage

Place `"$safe-bash"` as an entry in `rules`. It mixes freely with regular rule objects and expands in place:

```jsonc
{
  "policies": {
    "readonly": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "grep" },
        { "action": "allow", "tool": "find" },
        { "action": "allow", "tool": "ls" },
        { "action": "deny",  "tool": "write" },
        { "action": "deny",  "tool": "edit" },
        { "action": "allow", "tool": "bash", "pattern": "$safe-bash" } // expands to ~90 rules
      ]
    }
  }
}
```

See [`examples/sample.jsonc`](examples/sample.jsonc) for a complete working example, and [`src/utils/safe-commands.ts`](src/utils/safe-commands.ts) for the full pattern list.

---

## Examples

### Protect production configs

Block all writes inside a sensitive config directory, but allow reads.

```json
{
  "policies": {
    "config-readonly": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "grep" },
        { "action": "allow", "tool": "find" },
        { "action": "allow", "tool": "ls" },
        { "action": "deny",  "tool": "write" },
        { "action": "deny",  "tool": "edit" },
        { "action": "deny",  "tool": "bash", "pattern": "* > *" },
        { "action": "deny",  "tool": "bash", "pattern": "* >> *" }
      ]
    }
  },
  "locations": {
    "/etc/myapp": "config-readonly"
  }
}
```

---

### Audit-only mode

Log every tool call in a directory without blocking anything. Useful when first introducing controls to an existing project.

```json
{
  "policies": {
    "audit": {
      "defaultAction": "log",
      "rules": []
    }
  },
  "locations": {
    "/home/user/work": "audit"
  }
}
```

Every tool call targeting `/home/user/work` will surface a notification in the pi UI and proceed. No rules needed — `defaultAction: "log"` handles everything.

---

### Interactive gate on destructive commands

Require confirmation before any `rm`, `chmod`, or `truncate` command, but let everything else through silently.

```json
{
  "policies": {
    "cautious": {
      "defaultAction": "allow",
      "rules": [
        { "action": "ask", "tool": "bash", "pattern": "rm *" },
        { "action": "ask", "tool": "bash", "pattern": "rm -rf *" },
        { "action": "ask", "tool": "bash", "pattern": "chmod *" },
        { "action": "ask", "tool": "bash", "pattern": "truncate *" },
        { "action": "ask", "tool": "bash", "pattern": "dd *" }
      ]
    }
  },
  "locations": {
    "/home/user": "cautious"
  }
}
```

Note: `"rm -rf *"` (score 8) is more specific than `"rm *"` (score 3), so both rules can coexist and both produce `ask`. The tiebreaker doesn't matter here — they have the same action.

---

### Allow git, block everything else

A strict allowlist policy: only git commands and file reads are permitted. Everything else is denied.

```json
{
  "policies": {
    "git-only": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "grep" },
        { "action": "allow", "tool": "find" },
        { "action": "allow", "tool": "ls" },
        { "action": "allow", "tool": "bash", "pattern": "git status" },
        { "action": "allow", "tool": "bash", "pattern": "git log *" },
        { "action": "allow", "tool": "bash", "pattern": "git diff *" },
        { "action": "allow", "tool": "bash", "pattern": "git add *" },
        { "action": "allow", "tool": "bash", "pattern": "git commit *" },
        { "action": "ask",   "tool": "bash", "pattern": "git push *" },
        { "action": "deny",  "tool": "bash", "pattern": "git push --force *" }
      ]
    }
  },
  "locations": {
    "/home/user/work": "git-only"
  }
}
```

Force pushes are denied outright. Regular pushes require confirmation. All other git subcommands are allowed. Any non-git bash command is caught by `defaultAction: "deny"`.

---

### GitHub tool lockdown

Block all GitHub MCP tools to prevent the agent from opening PRs, creating issues, or merging branches without explicit approval.

```json
{
  "policies": {
    "no-github": {
      "defaultAction": "allow",
      "rules": [
        { "action": "deny", "tool": "github_*" }
      ]
    },
    "github-with-approval": {
      "defaultAction": "allow",
      "rules": [
        { "action": "ask",  "tool": "github_create_pull_request" },
        { "action": "ask",  "tool": "github_merge_pull_request" },
        { "action": "deny", "tool": "github_delete_*" },
        { "action": "log",  "tool": "github_*" }
      ]
    }
  },
  "locations": {
    "/home/user/experiments": "no-github",
    "/home/user/work":        "github-with-approval"
  }
}
```

In `experiments`, all `github_*` tools are denied (score 7 for `"github_*"`).

In `work`, the specific tools `github_create_pull_request` and `github_merge_pull_request` score 26 and 26 respectively, beating the catch-all `"github_*"` (score 7). Delete operations are denied. All other GitHub tools are logged and allowed.

---

### Per-project policy with global fallback

Set a permissive global fallback so unrecognized paths don't get blocked, while applying a strict policy to specific projects.

```json
{
  "policies": {
    "strict": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "grep" },
        { "action": "allow", "tool": "bash", "pattern": "git *" },
        { "action": "ask",   "tool": "bash", "pattern": "git push *" },
        { "action": "deny",  "tool": "write" },
        { "action": "deny",  "tool": "edit" }
      ]
    },
    "open": {
      "defaultAction": "allow",
      "rules": []
    }
  },
  "locations": {
    "/home/user/work/critical-service": "strict"
  },
  "defaultPolicy": "open"
}
```

Any path inside `/home/user/work/critical-service` gets the `strict` policy. Everything else — `/tmp`, `/home/user/scratch`, etc. — falls through to `open` (fully permissive).

Without `defaultPolicy`, any path that doesn't match a location would be unrestricted anyway (fail-open). Setting `defaultPolicy: "open"` makes that intent explicit.

---

### Layered home and project policies

Apply a moderate policy to the whole home directory, and a stricter one to a specific project. The most specific location always wins.

```json
{
  "policies": {
    "moderate": {
      "defaultAction": "allow",
      "rules": [
        { "action": "ask", "tool": "bash", "pattern": "rm *" },
        { "action": "ask", "tool": "bash", "pattern": "sudo *" },
        { "action": "log", "tool": "write" }
      ]
    },
    "strict": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "git *" },
        { "action": "deny",  "tool": "bash", "pattern": "rm *" }
      ]
    }
  },
  "locations": {
    "/home/user":                 "moderate",
    "/home/user/work/production": "strict"
  }
}
```

| Path | Policy | `rm /tmp/foo` result |
|------|--------|----------------------|
| `/home/user/scratch/test.ts` | `moderate` | **ask** |
| `/home/user/work/production/src/main.ts` | `strict` | **deny** |
| `/var/log/app.log` | _(no match, no defaultPolicy)_ | **allow** (fail-open) |

---

### Redirect-aware bash policies

Policies apply not just to the command itself, but to any files it writes via redirects. This catches commands that would smuggle data out of a restricted location.

```json
{
  "policies": {
    "confidential": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "cat *" }
      ]
    },
    "open": {
      "defaultAction": "allow",
      "rules": []
    }
  },
  "locations": {
    "/home/user/secrets": "confidential",
    "/tmp":               "open"
  }
}
```

- `cat /home/user/secrets/key.pem` — source is in `confidential` → **allow** (matches `cat *`)
- `cat /home/user/secrets/key.pem > /tmp/key.pem` — redirect target `/tmp/key.pem` is in `open` (**allow**), but source is in `confidential` (**allow** via `cat *`). Most restrictive: **allow**. The cat is permitted.
- `cp /home/user/secrets/key.pem /tmp/key.pem` — `cp` doesn't match any rule in `confidential` → `defaultAction: deny` → **deny**.

> Note: pi-controls extracts redirect targets (`>`, `>>`, `<`, etc.) from the bash AST. It does not track the contents of files or data flowing through pipes — only where the command writes to explicitly.

---

### Mixed restrictiveness across pipeline stages

Each stage in a piped or `&&`-chained command is evaluated independently. The most restrictive result across all stages applies to the entire command.

```json
{
  "policies": {
    "safe": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "bash", "pattern": "grep *" },
        { "action": "allow", "tool": "bash", "pattern": "cat *" },
        { "action": "deny",  "tool": "bash", "pattern": "curl *" }
      ]
    }
  },
  "locations": {
    "/home/user/work": "safe"
  }
}
```

| Command | Stage results | Final |
|---------|---------------|-------|
| `cat file.txt \| grep foo` | allow, allow | **allow** |
| `curl https://example.com \| grep secret` | deny, allow | **deny** |
| `grep pattern file.txt && curl https://log-server.io` | allow, deny | **deny** |

The `curl` stage is denied, which locks the entire pipeline regardless of what the other stages do.

---

## Config Reference

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `policies` | `Record<string, Policy>` | No | Named policies available for use in `locations`. |
| `locations` | `Record<string, string>` | No | Maps filesystem paths to policy names. |
| `defaultPolicy` | `string \| null` | No | Policy to apply when no location matches. `null` or absent = fail-open. |

### Policy fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `defaultAction` | `"allow" \| "ask" \| "deny" \| "log"` | Yes | Action when no rule matches. |
| `rules` | `Rule[]` | Yes | Ordered list of rules (order does not affect matching — specificity does). |

### Rule fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `"allow" \| "ask" \| "deny" \| "log"` | Yes | What to do when this rule matches. |
| `tool` | `string` | Yes | Tool name or glob. Wildcards: `*` (any chars), `?` (one char). |
| `pattern` | `string` | bash only | Glob matched against the full command string. Only used when `tool` is `"bash"`. |

### Glob syntax

Both `tool` and `pattern` support `*` and `?` wildcards:

| Pattern | Matches |
|---------|---------|
| `"bash"` | exactly `bash` |
| `"github_*"` | `github_create_pr`, `github_list_issues`, … |
| `"git *"` | `git status`, `git commit -m "x"`, `git push origin main`, … |
| `"git commit *"` | `git commit -m "x"`, `git commit --amend`, … |
| `"rm *"` | `rm foo`, `rm -rf /tmp`, … |
| `"*"` | everything |

In `pattern`, `*` matches any character including spaces, slashes, and flags — it matches the entire remainder of the command string, not just a single word.

---

## Development

```sh
bun install       # install dependencies
bun test          # run all tests
bun run check     # lint with Biome
bun run format    # format with Biome
```

Tests live in `tests/` and use `bun:test`. Each utility module has its own test file.

```
src/
  index.ts          # Extension entry point
  config.ts         # Config schema and ConfigLoader setup
  hooks/
    tool-call.ts    # Main tool_call event handler
  utils/
    path.ts         # Path normalization and ~ expansion
    location.ts     # Path → policy resolution
    matching.ts     # Rule matching, specificity scoring, action resolution
    bash-ast.ts     # bash-parser wrapper with regex fallback
tests/
  utils/
    path.test.ts
    location.test.ts
    matching.test.ts
    bash-ast.test.ts
```
