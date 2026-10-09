# Security policy

## Supported versions

Only the latest release of tool-visibility-controller gets security fixes. The current
version is in [CHANGELOG.md](./CHANGELOG.md).

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub's
[private vulnerability reporting](https://github.com/rezzminator/tool-visibility-controller/security/advisories/new)
(the repository's **Security** tab, **Report a vulnerability**).

Include what you found, the steps to reproduce it, the Claude Code version
(`claude --version`) and the tool-visibility-controller version.

## What tool-visibility-controller touches

Useful when judging impact:

- It reads the agent, skill and command definitions (`agents/*.md`,
  `skills/*/SKILL.md`, `commands/**/*.md`) and the `tool-visibility-controller.json`
  scope file in `$CLAUDE_CONFIG_DIR` (else `~/.claude`) and in `.claude/` of the
  session's directory and each directory above it, once per session, and keeps
  only each definition's name and `visibility` rules.
- It reads the `CLAUDE_CONFIG_DIR` and `HOME` environment variables, the
  session's directory, and the session's list of running agents (to learn a
  sub-agent's type from its id), and the names of the session's tools (to know
  which tools an MCP server provides).
- It removes entries from the agent, skill, MCP-instructions and
  deferred-tools listings Claude Code sends to a loop, and refuses a spawn or a
  tool call the caller is not allowed; it changes nothing else.
- It logs failures through Claude Code's plugin log, prefixed `tool-visibility-controller:`.
- It writes no file, makes no network request and calls no model.

tool-visibility-controller is a convenience, not a security boundary: it fails open, so any
error leaves the listing whole and lets the call through, and a tool whose
schema is in the prompt stays listed. Use `permissions.deny` for a tool or an
agent that must never run.
