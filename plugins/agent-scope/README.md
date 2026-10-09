# agent-scope

Scope Claude Code sub-agents to their parents: add `available-to: [parentA, parentB]` to an agent definition's frontmatter (`main` is the main chat). The agent's line is removed from the agent listing of every other loop, and a dispatch of it from any other loop is refused with a message naming who may spawn it. An agent without the key is untouched. Definitions are read from `$CLAUDE_CONFIG_DIR/agents` (else `~/.claude/agents`) and every `.claude/agents/` from the session's directory up, a project definition replacing a user one of the same name, once per session. Any error is logged and leaves the listing and the spawn as they were; a malformed `available-to` is logged and the agent treated as unscoped.

It requires function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) and is tested on Claude Code 2.1.295. Remove it with `claude plugin uninstall agent-scope@agent-scope`. The full documentation lives in the repository: https://github.com/rezzminator/agent-scope

Built and maintained with [Professor](https://github.com/rezzminator/professor).
