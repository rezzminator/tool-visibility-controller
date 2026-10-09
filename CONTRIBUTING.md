# Contributing

Thanks for helping. agent-scope is small on purpose: one key, two hooks, and a
fail-open rule. A change that keeps it that way is the easiest to merge.

## Layout

| Path | Role |
| --- | --- |
| `plugins/agent-scope/` | Everything that installs, and nothing else; dev files never go in it |
| `plugins/agent-scope/src/scope.ts` | Every decision, pure: the `available-to` reader, the rule table and its precedence, who may use what, the listing filter, the deny text |
| `plugins/agent-scope/hooks/agent-scope.ts` | The adapter: reads the definitions, resolves a loop's agent type, wires the hooks; the only file that touches `$` |
| `tests/` | One vitest file per concern: `scope.test.ts` for the pure functions, `adapter.test.ts` for the hooks against a stand-in engine |
| `types/claude-code.d.ts` | The plugin API, the truth for every hook's shape |

## Set up

```sh
npm install
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
npm test               # vitest: the frontmatter reader, the listing filter, the hooks
npm run typecheck      # src and the hooks module against the plugin API types
npm run validate:plugin
```

Try the checkout in a real session with
`claude --plugin-dir plugins/agent-scope`, with any installed copy of
agent-scope disabled for that run, and an agent of your own carrying
`available-to`.

## Rules for a change

- A new behaviour lands in `plugins/agent-scope/src/` as a pure function, with
  a test in `tests/` that you watched fail first; the adapter only wires it.
- An error never holds a spawn or alters a listing: log it with its context,
  leave the listing whole and let the spawn through.
- A refused spawn always names who may spawn the agent.
- The listing filter keeps every byte it does not remove, so the same input
  gives the same output and the prompt cache holds.
- `$` is passed only to functions declared at the top level of the hooks file
  and always spelled `$.noun.event(...)`; otherwise Claude Code loads the
  module with zero hooks. `npm run validate:plugin` reports it.
- A change in behaviour moves `README.md` and `CHANGELOG.md` (under
  `## [Unreleased]`) in the same pull request.
- No machine-absolute paths or personal data in a tracked file.

## Send it in

1. Fork the repository and branch off `develop`.
2. Make the change with its test; run the three gates above.
3. Open a pull request against `develop`; `main` holds only releases.

Issues labelled
[good first issue](https://github.com/rezzminator/agent-scope/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
are a good start. By contributing you agree to license your work under the
repository's [MIT license](./LICENSE) and to follow the
[Code of Conduct](./CODE_OF_CONDUCT.md).
