# Getting help

- **Something still shows up, or is never refused.** Function hooks must be on
  (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) before Claude Code starts, and rules
  are read once per session: start a new session after an edit. Check that the
  definition lives under `~/.claude/` (or `$CLAUDE_CONFIG_DIR`) or a project's
  `.claude/`, that no nearer copy of the same name drops the field, and that no
  `tool-visibility-controller:` log line reports the block as malformed. Plugin
  and built-in items take their rules from the scope file, and a tool whose
  schema is in the prompt stays listed; see [Limits](./README.md#️-limits).
- **A question about using tool-visibility-controller.**
  [Open an issue](https://github.com/rezzminator/tool-visibility-controller/issues/new/choose)
  with the Question template.
- **A bug.** Use the bug report template; include `claude --version`, the
  tool-visibility-controller version, the `visibility` field or scope file, and any `tool-visibility-controller:` log
  line.
- **A security problem.** Follow [SECURITY.md](./SECURITY.md), never a public
  issue.
