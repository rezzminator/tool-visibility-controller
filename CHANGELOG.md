# Changelog

Every release of agent-scope. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `agent-scope--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

## [0.1.0] — 2026-10-09

### Added
- `available-to: [parent, ...]` in an agent definition's frontmatter (`main` is the main chat) scopes the agent to those callers.
- The agent listing (`agent_listing_delta`) of every other loop loses the scoped agent's line; every other byte stays as it was.
- A dispatch of a scoped agent from any other loop is refused with a message naming who may spawn it.
- Definitions are read once per session from the user agents directory and every project `.claude/agents/` from the session's directory up; the nearest definition of a name wins.
- Every error fails open, logged with its context; a malformed `available-to` is logged and the agent treated as unscoped.

### Known limits
- A sub-agent receives the agent listing after its first tool call; the spawn check applies from its first request.
- Plugin agents (`plugin:name`) and built-in agents cannot be scoped.
