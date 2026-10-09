# agent-scope

Claude Code plugin for parent-scoped subagents — hide a helper from every other agent listing and refuse its dispatch.

Add `available-to: [parentA, parentB]` to an agent definition's frontmatter (`main` is the main chat). The agent's line is removed from the agent listing of every other loop, and a dispatch of it from any other loop is refused with a message naming who may spawn it. An agent without the key is untouched. Definitions are read once per session from `$CLAUDE_CONFIG_DIR/agents` (else `~/.claude/agents`) and every `.claude/agents/` from the session's directory up, a project definition replacing a user one of the same name. Any error is logged and leaves the listing and the spawn as they were; a malformed `available-to` is logged and the agent treated as unscoped.

Install with `/plugin install agent-scope --marketplace rezzminator/agent-scope` (where `--marketplace` is available). Requires function hooks (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`). Limits: a sub-agent receives the listing after its first tool call (the spawn check applies from its first request), and plugin and built-in agents cannot be scoped. Remove it with `claude plugin uninstall agent-scope@agent-scope`. Full documentation: https://github.com/rezzminator/agent-scope

Built and maintained with [Professor](https://github.com/rezzminator/professor).
