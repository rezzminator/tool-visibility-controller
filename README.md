<div align="center">

<img src="plugins/tool-visibility-controller/.claude-plugin/icon.svg" alt="tool-visibility-controller logo" width="96">

# tool-visibility-controller

**Claude Code plugin for per-agent tool visibility — hide and refuse subagents, skills, MCP and built-in tools per loop**

[![CI](https://github.com/rezzminator/tool-visibility-controller/actions/workflows/release.yml/badge.svg?branch=develop)](https://github.com/rezzminator/tool-visibility-controller/actions/workflows/release.yml)
[![Version](https://img.shields.io/badge/version-0.3.6-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://code.claude.com/docs/en/plugins)
[![Built with Professor](https://img.shields.io/badge/built%20with-Professor-8A2BE2)](https://github.com/rezzminator/professor)

**Contents:** [Why](#-why) · [Quick start](#-quick-start) · [Usage](#-usage) · [How it works](#-how-it-works) · [Logs](#logs) · [Limits](#-limits) · [FAQ](#-faq) · [Help](#-help) · [Contributing](#-contributing) · [Built with Professor](#-built-with-professor) · [License](#license) · [Changelog](./CHANGELOG.md)

</div>

One frontmatter field decides, per loop, what the main chat and each sub-agent type sees in its listings and may call:

```markdown
---
name: researcher
description: Searches the web and summarises sources.
visibility:
  visible-to:
    include: [research-lead]              # only research-lead may see and spawn this agent
  mcp:
    include: [harvester-professor/*]      # this agent's loop sees only these MCP tools
  tools:
    exclude: [Bash]                       # and every built-in tool but Bash
---
```

The main chat's agent listing, before and after:

```diff
 Available agent types for the Agent tool:
 - general-purpose: General-purpose agent for researching complex questions. (Tools: *)
 - research-lead: Plans a research question and delegates it. (Tools: Agent, Read)
-- researcher: Searches the web and summarises sources. (Tools: Read, WebFetch)
```

If the main chat dispatches `researcher` by name anyway, the spawn is refused with:

```text
Agent type researcher is not available to the main chat: visibility.visible-to in ~/.claude/agents/researcher.md admits only research-lead. Delegate the task to research-lead, or choose another agent type.
```

## 🤔 Why

- **Every loop gets the tools its job needs, not all of them.** Claude Code lists every agent, skill, MCP tool and deferred tool to every loop. A helper agent, a dangerous MCP server or a heavy skill now shows up only where you allow it.
- **Hidden and refused, not just hidden.** Each listing is filtered per loop, and a call by name from a loop that may not use the item is refused with a message naming the rule and what to do instead.
- **Parent → child chains keep working.** `permissions.deny` blocks a tool in every loop, the orchestrator included. Here the rule is per caller: `research-lead` spawns `researcher`, the main chat cannot.
- **Things you do not own are covered too.** Built-in agents (`Explore`), plugin agents and skills, MCP servers and built-in tools take their rules from a scope file, `tool-visibility-controller.json`.
- **Every other loop's context gets lighter, and the prompt cache holds.** A hidden entry leaves the listing; every other byte stays identical.
- **It never blocks your work by accident.** Any error is logged and the listing, the call and the spawn go on as they were; a loop or hook failure that leaves an action unchecked says which action went unchecked.

## 🚀 Quick start

Function hooks are experimental; turn them on before Claude Code starts:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

Install from the repository's own marketplace:

```bash
claude plugin marketplace add rezzminator/tool-visibility-controller
claude plugin install tool-visibility-controller@tool-visibility-controller
```

<details>
<summary>One step, or from inside a session</summary>

Where `claude plugin install --help` lists `--marketplace`, one command adds the marketplace and installs:

```bash
claude plugin install tool-visibility-controller --marketplace rezzminator/tool-visibility-controller
```

Inside a session:

```text
/plugin marketplace add rezzminator/tool-visibility-controller
/plugin install tool-visibility-controller@tool-visibility-controller
```

</details>

Add a `visibility` field to an agent, skill or command you own, or write a scope file, then run `/reload-plugins` or start a new session. The next policy use reads the files again.

## 🧭 Usage

### The `visibility` field

In the frontmatter of an agent (`agents/*.md`), a skill (`skills/*/SKILL.md`) or a command (`commands/**/*.md`):

```yaml
visibility:
  visible-to:            # who may see and invoke THIS item
    include: [rr, rr-pro, main]          # only these loops; main is the main chat
    exclude: []                          # every loop but these
  agents:                # what THIS agent's own loop sees (agent files only)
    include: [sub-rr]
  skills:  { exclude: [deploy, ops:*] }  # skills and model-invocable commands
  mcp:     { include: [harvester-professor/*] }   # server, or server/tool
  tools:   { exclude: [WebFetch, Bash] }          # built-in tools by name
```

- Every block and both keys are optional; an absent block restricts nothing. `include` keeps only matches, `exclude` drops matches, both together keep the included minus the excluded.
- A pattern is an exact name or a `*` glob. A loop is `main` or an agent type (`Explore`, `plugin:agent`).
- MCP patterns are `server` or `server/tool`, the server as configured (`claude.ai Docs/*` matches `mcp__claude_ai_Docs__*`), or a full `mcp__server__tool`.
- Skill patterns match the listed name (`plugin:skill`) or the bare name after the plugin.
- `agents`, `skills`, `mcp` and `tools` count only in agent files: a skill or command has no loop of its own. In a skill or command they are logged and ignored.

### The scope file

For what has no frontmatter you own: the main chat, built-in agents, plugin agents and skills, MCP servers, built-in tools. `$CLAUDE_CONFIG_DIR/tool-visibility-controller.json` (else `~/.claude/tool-visibility-controller.json`) and `.claude/tool-visibility-controller.json` in the session's directory and each directory above it, below your home directory:

```json
{
  "loops": {
    "main":    { "mcp": { "exclude": ["harvester-professor/*"] }, "agents": { "exclude": ["Explore"] } },
    "Explore": { "tools": { "exclude": ["WebFetch"] } }
  },
  "items": {
    "agents": { "Explore": { "visible-to": { "exclude": ["main"] } } },
    "skills": { "docs-kit:pdf": { "visible-to": { "include": ["writer"] } } },
    "mcp":    { "harvester-professor/*": { "visible-to": { "exclude": ["main"] } } },
    "tools":  {}
  }
}
```

- `loops.<loop>` holds the same set blocks as an agent's `visibility`; `items.<set>.<pattern>` holds a `visible-to`.
- A nearer file replaces a farther one key by key (`loops.main.mcp`, `items.agents.Explore`), the user file being the farthest.

### Who may use what

A loop may see and invoke an item only when every rule agrees: the item's `visible-to` admits the loop, the loop's own block for that set admits the item, and the scope file admits both. Any one says no, and the item is hidden from that loop and its call refused.

- Definitions are read from `$CLAUDE_CONFIG_DIR` (else `~/.claude`) and from `.claude/` in the session's directory and each directory above it, below your home directory as Claude Code reads them; the nearest definition of a name wins, so a project copy without `visibility` lifts the user copy's rules there. A definition that is missing (`ENOENT`) is skipped, never read as an empty definition, so it cannot override a farther valid one; the skip is logged once per path until `session.start` or `/reload-plugins` resets that suppression, and every other definition still loads. A definition that exists but cannot be read keeps the nearest-tier behavior and is reported as an error.
- Definitions and scope files are read lazily on the first policy use and cached until `session.start` or `/reload-plugins`. After an edit, run `/reload-plugins` or start a new session; the next policy use reads the files again. Reload invalidates the cache after the command finishes, even if it throws, and preserves the command's result or error without rerunning or rewriting it. Other commands and events keep the cached policy; a failed policy load is retried on the next use.
- A malformed block (a scalar where a list belongs, an unknown key, an unclosed list, a key given twice) is logged with its file and the reason, and only that block is ignored.

Remove it with:

```bash
claude plugin uninstall tool-visibility-controller@tool-visibility-controller
```

## 🧠 How it works

```mermaid
flowchart LR
  D["visibility frontmatter<br/>+ scope files"] -->|lazy read after session.start or /reload-plugins| P["cached rules"]
  L["listing for loop X<br/>agents · skills · MCP · deferred tools"] --> F{"X may see<br/>the entry?"}
  P --> F
  F -->|yes| K["entry kept"]
  F -->|no| H["entry removed"]
  C["Agent spawn, Skill call,<br/>MCP or built-in tool call from X"] --> G{"X may use<br/>it?"}
  P --> G
  G -->|yes| R["goes through"]
  G -->|no| N["refused, naming the rule<br/>and what to do instead"]
```

### prompt.attachment

Per loop, removes the entries that loop may not see from the agent listing (`agent_listing_delta`), the skill listing (`skill_listing`) and the deferred-tools notice (`deferred_tools_delta`), and drops an MCP server's block from `mcp_instructions_delta` when the loop may use none of that server's tools. The loop is the main chat, or a sub-agent whose type comes from its id: found in the session's agent list, else announced by `SubagentStart` or `SubagentStop`. Every other byte stays as it was.

### agent.spawn

Refuses the spawn of an agent type the calling loop may not use. Only an Agent tool call's own spawn is checked; a resume (a wake when an agent's children finish, or a message sent to a finished agent) runs under the resuming loop, not the agent's parent, and always goes through.

### tool.call

Refuses a built-in tool, an MCP tool, or a `Skill` call naming a skill or command the calling loop may not use.

### classic.SubagentStart / classic.SubagentStop

Learn each sub-agent's type by its id, for an id the session's agent list does not name: a workflow's agents are never in it, so these two announcements are their only source. A teammate's announcement carries its name, so the list's type wins for any id it names.

### session.start

Clears the cached policy and missing-definition path suppression, so the next policy use reads definitions and scope files again and may log a missing path again.

### command.run

Matches only `reload-plugins`. After `next(e)` finishes or throws, clears `cache.policy` and `cache.missing`, so the next policy use reads definitions and scope files again and may log a missing path again. It preserves the command's result or error, does not rerun or rewrite the command, and leaves other commands alone. This explicit reset is needed because reload sends `session.start` only to changed modules; an unchanged controller would otherwise keep its old policy.

### session.end

Drains pending plugin log writes.

It fails open: an unreadable file, a sub-agent the session's agent list or a `SubagentStart`/`SubagentStop` announcement names without an agent type (one diagnostic per loop, however many listings, calls and spawns it makes), a hook that throws or overruns its budget, or any other error is logged with its context and leaves the listing, the call and the spawn as they were.

A loop no agent list row or announcement ever names is the engine's own (a fork for compaction or memory: Claude Code gives those ids no list row and fires no `SubagentStart` for them). No visibility rule governs it: its listings, calls and spawns are left whole, and it is recorded once per loop as a debug row, never on screen. After `/reload-plugins` the controller starts with no announcements, so a workflow agent announced before the reload is taken for an engine loop.

When the loop's identity is unresolved, the diagnostic names the action that could not be checked (a listing, a call or a spawn) and how to recover: make the loop's type known through the session's agent list or a `SubagentStart` announcement. A hook that throws shows on screen the hook name, the kind and reason of the failure, the item or loop it concerned and the unchecked fallback that ran. Fail-open is a deliberate choice, not fail-closed enforcement: an unchecked action runs.

### Logs

Errors, warnings, narrowly scoped info events and debug events append to `errors.jsonl`, `warnings.jsonl`, `info.jsonl` and `debug.jsonl` under `$PLUGIN_LOG_DIR/tool-visibility-controller/`. Without `PLUGIN_LOG_DIR`, they use `$HOME/.local/state/tool-visibility-controller/logs/`. Rows identify the event, component and available session id; they never include prompt, transcript or tool-input bodies.

Rows stay within 4096 UTF-8 bytes; oversized detail is marked as truncated and the message is shortened. New directories and files use private modes (0700 and 0600); writes run off the policy path, with a five-second process timeout; session end drains pending writes. A level file over 20 MiB moves to `.1`, older generations shifting up to `.5`, and a `log-capped` warning follows; a lock in the log directory serializes the move. A failed write leaves policy behavior unchanged and shows one notice naming the directory and error per failing streak, re-armed after a successful write. The failed rows are kept and written with the next write, in this session or the next: at most 2000, past which the oldest go and the next successful write records how many in a `plugin-log-rows-dropped` error row. Rows whose environment or session lookup failed wait the same way, and only the last write at session end or start gives those up, said once. Identical screen lines collapse: the first shows, repeats are counted, and one `(and N more)` line follows after 30 seconds, on a timer and at session end. With neither `PLUGIN_LOG_DIR` nor `HOME`, a notice explicitly says logging is off. The screen shows only errors and the log's own failing or off notice: errors always appear on screen as well as in the plugin log; warning, info and debug rows go only to their files, or nowhere when the log cannot be written. An unavailable session id or engine clock is a warning (the row is still written, without the session or with local time); a file-cap notice is also log-only. Unreadable definitions or scope files, malformed or misplaced visibility blocks, a skipped user tier, a sub-agent with no resolvable type, failed checks or rewrites, and fail-open hook catches are errors because enforcement is incomplete; an engine-owned loop is a debug row. Denial reasons returned to the model are deliberate product output, not diagnostics, and are unchanged.

The log writer is a vendored copy of the shared plugin-log library (`src/plugin-log.ts`), kept byte-identical to its canonical source; it is plain source with no runtime dependency.

## ⚠️ Limits

- Requires function hooks (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`); tested live on Claude Code 2.1.295, which CI validates against.
- A tool whose schema sits in the prompt's tool list (built-in tools such as `Bash` and `Read`, and every MCP tool when tool search is off) cannot be hidden per loop: Claude Code renders tool schemas once per session for every loop. Such a tool stays listed; its call is refused. Deferred tools, listed by name behind ToolSearch, are hidden per loop. Tool search is on by default against Anthropic's API and off behind a custom `ANTHROPIC_BASE_URL`; `ENABLE_TOOL_SEARCH=true` turns it on.
- ToolSearch can still load a hidden deferred tool's schema when asked for it; the call is refused.
- A sub-agent receives the agent listing with its second request, after its first tool call. Refusals apply from its first request.
- A slash command the person types runs: only the model's `Skill` calls are checked.
- An MCP server's instructions are dropped only when the session knows its tools and the loop may use none of them. A `## ` heading inside a server's instructions reads as the next server's heading, so the text below it stays: the listing does not tell the two apart, and guessing would drop another server's instructions.
- A hidden skill's entry is removed up to the first blank line in its description; a description holding a blank line leaves its rest in the listing, since a skill entry marks no end of its own.
- Plugin-provided agents, skills and commands are not read for `visibility`; rule them in the scope file.
- It is a convenience, not a security boundary: it fails open. Use `permissions.deny` for a tool that must never run.

## ❓ FAQ

**Does it cost anything?** On the first policy use after `session.start` or `/reload-plugins`, one directory listing per definitions directory and one read per definition and scope file; subsequent uses reuse the cached policy. A failed load is retried on the next use. Per listing or call, one lookup in the session's agent list for a sub-agent's type, skipped when no rule speaks about that set. It makes no model call and no network request. Each nonempty plugin log flush runs one shell process per batch of at most 64 rows and appends to the level files described above.

**Why not `permissions.deny`?** It blocks a tool in every loop, the parent's included, and leaves the listing as it was. This plugin hides and refuses per caller.

**Why not a `tools:` list in the agent?** Use it where it fits: it limits that agent's own tools and takes their schemas out of its prompt. It cannot limit the main chat or a built-in agent, nor which agents and skills a loop is offered, and it cannot keep other loops from calling the agent. The two combine.

## 💬 Help

Questions and bugs go to [issues](https://github.com/rezzminator/tool-visibility-controller/issues/new/choose); [SUPPORT.md](./SUPPORT.md) says what to include. Security problems: [SECURITY.md](./SECURITY.md), never a public issue.

## 🤝 Contributing

[CONTRIBUTING.md](./CONTRIBUTING.md) covers the layout, the gates and where a change goes; open issues labelled [good first issue](https://github.com/rezzminator/tool-visibility-controller/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are a place to start. Everyone taking part follows the [Code of Conduct](./CODE_OF_CONDUCT.md).

## 🎓 Built with Professor

tool-visibility-controller is built and maintained with [Professor](https://github.com/rezzminator/professor), a fleet controller and discipline layer for Claude Code, Codex and OpenCode: chats that message each other, agents held to the project's rules, and gated releases. This plugin came out of it: Professor's orchestrators ship helper agents, skills and research tools meant only for them, and this plugin keeps each one in the loops that need it.

## License

[MIT](./LICENSE)
