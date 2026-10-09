# Getting help

- **A scoped agent still shows up, or is never refused.** Function hooks must
  be on (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) before Claude Code starts, and
  definitions are read once per session: start a new session after editing an
  `available-to` list. Check that the definition lives in `~/.claude/agents/`
  (or `$CLAUDE_CONFIG_DIR/agents`) or a project's `.claude/agents/`, and that
  no nearer project copy of the same name drops the key. Plugin and built-in
  agents cannot be scoped; see [Limits](./README.md#️-limits).
- **A question about using agent-scope.**
  [Open an issue](https://github.com/rezzminator/agent-scope/issues/new/choose)
  with the Question template.
- **A bug.** Use the bug report template; include `claude --version`, the
  agent-scope version, the agent's frontmatter, and any `agent-scope:` log
  line.
- **A security problem.** Follow [SECURITY.md](./SECURITY.md), never a public
  issue.
