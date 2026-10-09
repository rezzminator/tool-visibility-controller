# Changelog

Every release of tool-visibility-controller. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `tool-visibility-controller--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

## [0.1.0] — 2026-10-09

### Added
- A `visibility` field in agent, skill and command frontmatter: `visible-to` (who may see and invoke the item) and, in agent files, `agents`, `skills`, `mcp` and `tools` blocks (what that agent's loop sees), each with optional `include` and `exclude` lists of names or `*` globs; `main` is the main chat.
- A scope file, `tool-visibility-controller.json`, in the user config directory and in any project `.claude/`, with `loops` and `items` rules for the main chat, built-in agents, plugin agents and skills, MCP servers and built-in tools; a nearer file replaces a farther one key by key.
- Per loop, the agent listing, the skill listing and the deferred-tools notice lose the entries that loop may not see, and an MCP server's instructions are dropped for a loop that may use none of its tools; every other byte stays as it was.
- A spawn, a `Skill` call, an MCP tool call or a built-in tool call the calling loop may not make is refused with a message naming the item, the rule and its file, and what to do instead.
- Definitions are read once per session from the user directory and every project `.claude/` from the session's directory up to, not including, the home directory; the nearest definition of a name wins.
- Every error fails open, logged with its context; a malformed block is logged with its file and the reason, and only that block is ignored.

### Known limits
- A tool whose schema sits in the prompt's tool list (built-in tools, and MCP tools when tool search is off) cannot be hidden per loop; its call is refused.
- A sub-agent receives the agent listing after its first tool call; refusals apply from its first request.
- A slash command the person types is not checked; plugin-provided definitions are ruled through the scope file.
