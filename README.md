<div align="center">

# agent-scope

**Scope Claude Code sub-agents to their parents: `available-to: [parent]` in an agent's frontmatter hides it from every other loop's agent listing and refuses every other dispatch.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-50%20passing-brightgreen)](#️-development)
[![Built with Professor](https://img.shields.io/badge/built%20with-Professor-8A2BE2)](https://github.com/rezzminator/professor)

</div>

```markdown
---
name: sub-tracer
description: Follows one thread of code for a tracer.
tools: Read, Grep, Glob, Bash, Agent
available-to: [tracer, sub-tracer]
---
```

<sup>`sub-tracer` now appears only in the agent listings of `tracer` and `sub-tracer` loops, and only they can spawn it. The main chat and every other agent neither see it nor can dispatch it by name.</sup>

## 🤔 Why

Some agents are helpers: they make sense only when a particular orchestrator sends them, with the brief it writes. Claude Code lists every agent to every loop, so the main chat and unrelated sub-agents see the helper and sometimes call it directly, with the wrong brief.

Claude Code's own tool is `permissions.deny: ["Agent(sub-tracer)"]` in `settings.json`. It hides the agent, but it also blocks the spawn in every loop, the orchestrator's included. You cannot say "hidden from everyone except its parent".

`available-to` says exactly that.

## 🚀 Quick start

Function hooks are experimental; turn them on first:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

Then install:

```text
/plugin marketplace add rezzminator/agent-scope
/plugin install agent-scope@agent-scope
```

Add `available-to` to any agent definition you own, in `~/.claude/agents/` or a project's `.claude/agents/`:

```yaml
available-to: [scope-parent]          # one parent
available-to: [tracer, main]          # main is the main chat
available-to:                         # a block list works too
  - tracer
  - sub-tracer
```

It requires function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) and is tested on Claude Code 2.1.295. To remove it:

```bash
claude plugin uninstall agent-scope@agent-scope
```

## 🧠 How it works

| Hook | What it does |
| --- | --- |
| `prompt.attachment` | On the agent listing (`agent_listing_delta`), removes the line of every scoped agent the receiving loop may not spawn. The loop is the main chat, or a sub-agent whose type comes from its id in the session's agent list. Every other byte stays as it was, so the same listing always renders the same way and the prompt cache holds. |
| `agent.spawn` | When the dispatched type is scoped and the calling loop is not in its `available-to`, refuses the spawn with a message naming who may spawn it. Hiding alone would not stop a dispatch by name. |
| `session.start` | Forgets the definitions read for the previous session. |

- An agent without `available-to` is untouched. A scoped agent is visible to, and spawnable by, exactly the types its list names; `main` is the main chat.
- Definitions are read from `$CLAUDE_CONFIG_DIR/agents` (else `~/.claude/agents`) and from `.claude/agents/` in the session's directory and each directory above it. A project definition replaces a user one of the same name, and the nearest project directory wins, so a project copy without `available-to` unscopes the agent there.
- Definitions are read once per session. Restart the session after editing a `available-to` list.
- `available-to: []` scopes the agent to nobody: hidden everywhere, and every dispatch refused.
- The refusal reads: `scope-child is available only to scope-parent (its available-to list); the main chat cannot dispatch it. Delegate the task to scope-parent, or choose another agent type.`
- It fails open. An unreadable definition, a loop id that names no agent, or any other error is logged with its context and leaves the listing and the spawn as they were. A malformed `available-to` (a scalar, an unclosed list, an item that is not a name) is logged and the agent treated as unscoped.
- A sub-agent receives the agent listing with its second request, after its first tool call. A sub-agent that dispatches on its very first request has seen no listing, scoped or not, and the spawn check still applies.
- Plugin agents (`plugin:name`) are out of scope: only definitions in the user and project agent directories are read.

## ❓ FAQ

**Does it cost anything?** One directory listing per agent directory and one read per definition, once per session. Per listing, one lookup in the session's agent list for a sub-agent's type, skipped when no definition is scoped.

**Can I scope a built-in agent such as `Explore`?** No; only agents defined in a `.md` file you own carry the key.

**Why not `permissions.deny`?** It blocks the spawn in every loop, the parent's included. agent-scope hides and refuses per caller.

## 🛠️ Development

```bash
npm install
npm test               # vitest: the frontmatter reader, the listing filter, and the hooks against a stand-in engine
npm run typecheck      # src and the hooks module against the plugin API types
npm run validate:plugin
```

A live run loads the checkout with `claude --plugin-dir plugins/agent-scope`, with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

| Module | Role |
| --- | --- |
| `src/scope.ts` | The `available-to` reader, the rule table and its precedence, who may use what, the listing filter, the deny text |
| `hooks/agent-scope.ts` | The adapter: reads the definitions, resolves a loop's agent type, wires the three hooks, and is the only file that touches `$` |

## 🎓 Built with Professor

agent-scope is built and maintained with [Professor](https://github.com/rezzminator/professor), a fleet controller and discipline layer for Claude Code, Codex and OpenCode: chats that message each other, agents held to the project's rules, and gated releases. This plugin came out of it: Professor's orchestrators ship helper agents meant only for them, and this plugin keeps those helpers out of every other loop.

## License

MIT

<sub>Keywords: Claude Code sub-agent visibility · scoped subagents · agent listing filter · restrict which agents can spawn an agent · nested sub-agents · Agent tool permissions · Claude Code plugin · function hooks · Claude Mods · multi-agent orchestration</sub>
