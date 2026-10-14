# Changelog

Every release of tool-visibility-controller. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `tool-visibility-controller--v<version>`, with a GitHub release carrying the section below.

## [0.3.0] — 2026-10-14

### Added
- Standalone errors, warnings and info JSONL files under `$PLUGIN_LOG_DIR/tool-visibility-controller/`, or `$HOME/.local/state/tool-visibility-controller/logs/` when unset. Rows include stable component names, optional session ids and a session-start `logger-ready` heartbeat; file caps rename to `.1` and emit `log-capped` warnings.
- Policy read/rewrite failures, ignored definitions and scope blocks, denials and the four fail-open hook catches now leave durable rows beside the existing notices. Log failures never alter policy outcomes and show one fallback notice per failing streak, re-armed after recovery.

### Fixed
- A loop that resolves to no agent type, which in practice is the engine's own fork for a compaction or for memory, printed a notice into the user's transcript each time one ran. That line now goes to the debug log alone; the loop is still left whole.

## [0.2.1] — 2026-10-12

### Fixed
- A sub-agent that `$.agent.list()` does not carry, as a workflow run's agents never are, was treated as a loop with no type: its listings stayed whole and its spawns and calls went through every rule. The plugin now learns each sub-agent's type from `SubagentStart` and `SubagentStop` for an id the list does not name, so the policy applies to it; an id the list names keeps the list's type, since a teammate's announcement carries its name.
- A loop that resolves to no agent type, such as the fork the engine runs for a compaction or for memory, was logged once per listing kind and once per spawn and tool call (four lines or more for one compaction). It is now logged once per loop id.

### Changed
- CI can be run by hand from the Actions tab (`workflow_dispatch`), with an option that also runs the release check against `main`'s version.

## [0.2.0] — 2026-10-09

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
