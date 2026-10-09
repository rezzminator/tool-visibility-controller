# tool-visibility-controller

Claude Code plugin for per-agent tool visibility — hide and refuse subagents, skills, MCP and built-in tools per loop.

Add a `visibility` field to an agent, skill or command's frontmatter: `visible-to: { include: [...], exclude: [...] }` names the loops (agent types, `main` for the main chat) that may see and invoke the item, and an agent's `agents`, `skills`, `mcp` and `tools` blocks limit what its own loop sees. Rules for what you do not own (the main chat, built-in agents, plugin agents and skills, MCP servers, built-in tools) go in `tool-visibility-controller.json` in `~/.claude/` or a project's `.claude/`. Each loop's agent listing, skill listing, deferred-tools notice and MCP instructions lose what it may not use, and a spawn, skill or tool call it may not make is refused with a message naming the rule. Everything is read once per session; any error is logged and leaves the listing and the call as they were.

Install with `/plugin install tool-visibility-controller --marketplace rezzminator/tool-visibility-controller` (where `--marketplace` is available). Requires function hooks (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`). Limits: a tool whose schema sits in the prompt's tool list cannot be hidden per loop (its call is refused), and a sub-agent receives the agent listing after its first tool call. Remove it with `claude plugin uninstall tool-visibility-controller@tool-visibility-controller`. Full documentation: https://github.com/rezzminator/tool-visibility-controller

Built and maintained with [Professor](https://github.com/rezzminator/professor).
