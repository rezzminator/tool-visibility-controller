# Security policy

## Supported versions

Only the latest release of agent-scope gets security fixes. The current
version is in [CHANGELOG.md](./CHANGELOG.md).

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub's
[private vulnerability reporting](https://github.com/rezzminator/agent-scope/security/advisories/new)
(the repository's **Security** tab, **Report a vulnerability**).

Include what you found, the steps to reproduce it, the Claude Code version
(`claude --version`) and the agent-scope version.

## What agent-scope touches

Useful when judging impact:

- It reads the `.md` agent definitions in `$CLAUDE_CONFIG_DIR/agents` (else
  `~/.claude/agents`) and in `.claude/agents/` of the session's directory and
  each directory above it, once per session, and keeps only each agent's name
  and `available-to` list.
- It reads the `CLAUDE_CONFIG_DIR` and `HOME` environment variables, the
  session's directory, and the session's list of running agents (to learn a
  sub-agent's type from its id).
- It removes lines from the agent listing Claude Code sends to a loop, and
  refuses an Agent spawn the caller is not allowed; it changes nothing else.
- It logs failures through Claude Code's plugin log, prefixed `agent-scope:`.
- It writes no file, makes no network request and calls no model.

agent-scope is a convenience, not a security boundary: it fails open, so any
error leaves the listing whole and lets the spawn through. Use
`permissions.deny` for an agent that must never run.
