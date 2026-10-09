# tool-visibility-controller

A Claude Code function-hooks plugin: a `visibility` field in agent, skill and
command frontmatter, and a `tool-visibility-controller.json` scope file, decide
per loop which agents, skills, MCP tools and built-in tools that loop sees in
its listings and may invoke. `README.md` is the behavioural spec.

## Layout

- `plugins/tool-visibility-controller/`: everything that installs, and nothing else — the directory scans only this folder, so dev files never go in it.
- `plugins/tool-visibility-controller/hooks/tool-visibility-controller.ts`: the adapter, the only file that touches `$`: it reads the definitions and scope files, resolves a loop's agent type, and wires `prompt.attachment`, `agent.spawn` and `tool.call` to `src/`.
- `plugins/tool-visibility-controller/src/`: every decision, pure and unit-tested — `visibility.ts` reads the frontmatter field, `policy.ts` matches names and decides who may use what, `listings.ts` rewrites the listings; `tests/` holds one vitest file per concern.
- `types/claude-code.d.ts`: the plugin API (from `/plugin-types`), the truth for every hook's shape; grep it before using an event.
- `plugins/tool-visibility-controller/.claude-plugin/`: `plugin.json` (the manifest) and `icon.svg`; the root `.claude-plugin/marketplace.json` makes the repo its own marketplace, with a `git-subdir` source pinned to `main`.

## Commands

`npm test`, `npm run typecheck`, `npm run validate:plugin` and `npm run release:check` all pass before a commit. A live check loads the checkout with `--plugin-dir plugins/tool-visibility-controller` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, with any installed copy disabled for that run.

## Rules

- A new behaviour lands in `plugins/tool-visibility-controller/src/` as a pure function with a test watched failing first; the adapter only wires it.
- An error never holds a call or a spawn, nor alters a listing: log it with context and leave the listing whole and the call going through.
- A refusal always returns a `deny` naming the item, the rule with its file, and what to do instead; a malformed block is logged with its file and reason and only that block ignored, never silently dropped.
- The listing filter keeps every byte it does not remove: the same input gives the same output, so the prompt cache holds.
- A version bump moves `plugins/tool-visibility-controller/.claude-plugin/plugin.json`, `marketplace.json`, `package.json`, `package-lock.json` and the README badge together; installed copies update only on a new version.
- Public repo: no machine-absolute paths, personal data or private project names in a tracked file.
- `$` is passed only to functions declared at the top level of the hooks file and always spelled `$.noun.event(...)`: Claude Code checks this statically and otherwise loads the module with zero hooks. `npm run validate:plugin` catches it.

## Branches and releases

- `develop` is the default branch: every change lands there, by a commit or a pull request, and CI (`.github/workflows/ci.yml`) runs the three gates on it.
- `main` is release-only. It moves only by merging the `develop → main` pull request, with a merge commit and never a squash, so both branches share one history. The marketplace installs the plugin from `main` (`git-subdir`, `ref: main`), so users only ever get a released version.
- A release, in order:
  1. On `develop`: bump the version in all four places, and move `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — date`. `npm run release:check` passes.
  2. Open the `develop → main` pull request. Its `release` check requires the version to have moved past `main`'s.
  3. Merge once CI is green.
  4. On `main`: `claude plugin tag --push plugins/tool-visibility-controller` creates and pushes `tool-visibility-controller--vX.Y.Z`. `release.yml` then publishes the GitHub release from the CHANGELOG section.
- Semantic versioning: a fix is a patch; a new option or behaviour is a minor; a renamed or removed option is a major, and its CHANGELOG entry says how to migrate.
- Publishing: README and marketing changes on `develop` are pushed as soon as they are committed. Code is pushed, and a release is cut, only when the owner asks.
- Git writes go through this repo's gitter, `.claude/agents/gitter.md`.
