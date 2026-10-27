# Changelog

Every release of tool-visibility-controller. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `tool-visibility-controller--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

- Installs as `tool-visibility-controller@professor` from the professor marketplace; the repo's own marketplace file is gone.

## [0.3.6] — 2026-10-27

### Fixed

- `/reload-plugins` now clears the cached visibility policy and missing-definition path suppression after the command finishes, even if it throws. The next policy use rereads definitions and scope files, including edits made while the controller module itself is unchanged: reload sends `session.start` only to changed modules, so the unchanged controller previously kept its old rules. The command runs once, unchanged, and its result or error is preserved; other commands retain lazy read-once caching, and `session.start` still resets the cache.
- An unresolved loop identity now says what it left unchecked. A loop whose type no list or announcement names keeps its listings, calls and spawns unchanged (the plugin fails open, it is not a security boundary), and one diagnostic per loop names the action that could not be checked and how to recover: make the type known through the agent list or a `SubagentStart` announcement.
- A hook that throws still leaves behavior unchanged, and its failure is now visible: the hook name, the failure kind and reason, the item or loop it concerned and the unchecked fallback that ran.
- A missing definition file (`ENOENT`) is skipped instead of read as an empty definition, so it no longer overrides a farther valid definition. The skip is logged once per path in the session and every other definition still loads. A definition that exists but cannot be read keeps its nearest-tier behavior.
- A burst of identical diagnostics no longer floods the screen. When the hooks worker stalls, every tool call used to print `tool.call failed; proceeding unchecked`; now the first line shows, the repeats are counted, and one `(and N more)` line follows once the burst ends (and every 30 seconds while it lasts, and at session end). Every row is still written to `errors.jsonl`.
- No log row is dropped to a transient failure. A row now waits for the next write when the engine clock, the environment or `process.run` is briefly unreachable (a stalled hooks worker): the clock falls back to local time, a failed batch is kept in order (at most 1000 rows) and written with the next row or at session end. Only the final write at session end or start gives a row up, with the usual screen fallback. A write that timed out after it succeeded can leave a duplicate row, never a missing one.
- Error diagnostics now always reach the screen and the plugin log, including all four fail-open hook catches. Ignored definitions, malformed or misplaced visibility blocks, unreadable scope files, skipped user tiers and unresolved loop types are errors because enforcement is incomplete.
- Warning and info diagnostics stay off screen while the plugin log is working. Missing session metadata is a logged warning; if no log directory is resolvable or a write fails, warning and info messages fall back to the screen alongside the log failure notice. Denial reasons returned to the model are unchanged.

## [0.3.2] — 2026-10-16

### Fixed

- A resumed agent is no longer refused. Claude Code raises `agent.spawn` for a resume under the resuming loop (the main chat for a wake when an agent's children finish), so an agent hidden from that loop, such as a sub-agent only its parent type may spawn, was refused its own wake, and Claude Code dropped the notices it was woken for, stalling every parent above it. Only an Agent tool call's own spawn is now checked.

## [0.3.1] — 2026-10-15

### Changed

- Plugin logs use plain create-and-append with private modes for new files; cap notices use the row truncation rule and retain the session key.

## [0.3.0] — 2026-10-14

### Added

- Standalone errors, warnings and info JSONL files under `$PLUGIN_LOG_DIR/tool-visibility-controller/`, or `$HOME/.local/state/tool-visibility-controller/logs/` when unset. Rows include stable component names, optional session ids; file caps rename to `.1` and emit `log-capped` warnings.
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
