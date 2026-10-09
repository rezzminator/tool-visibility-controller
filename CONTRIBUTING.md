# Contributing

Thanks for helping. tool-visibility-controller is small on purpose: one frontmatter field, one scope file,
four hooks and a fail-open rule. A change that keeps it that way is the easiest to merge.

## Layout

| Path | Role |
| --- | --- |
| `plugins/tool-visibility-controller/` | Everything that installs, and nothing else; dev files never go in it |
| `plugins/tool-visibility-controller/src/visibility.ts` | The `visibility` frontmatter reader, pure |
| `plugins/tool-visibility-controller/src/policy.ts` | Name matching, the rules from definitions and scope files, who may use what, the refusal text, pure |
| `plugins/tool-visibility-controller/src/listings.ts` | The listing rewrites (agents, skills, MCP instructions, deferred tools), pure |
| `plugins/tool-visibility-controller/hooks/tool-visibility-controller.ts` | The adapter: reads the definitions and scope files, resolves a loop's agent type, wires the hooks; the only file that touches `$` |
| `tests/` | One vitest file per concern: `visibility.test.ts`, `policy.test.ts` and `listings.test.ts` for the pure functions, `adapter.test.ts` for the hooks against a stand-in engine |
| `types/claude-code.d.ts` | The plugin API, the truth for every hook's shape |

## Set up

```sh
npm install
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
npm test               # vitest: the frontmatter reader, the rules, the listing filters, the hooks
npm run typecheck      # src and the hooks module against the plugin API types
npm run validate:plugin
npm run release:check   # the version agrees everywhere it is written
```

Try the checkout in a real session with
`claude --plugin-dir plugins/tool-visibility-controller`, with any installed copy of
tool-visibility-controller disabled for that run, and an agent, skill or scope file of
your own carrying a `visibility` rule.

## Rules for a change

- A new behaviour lands in `plugins/tool-visibility-controller/src/` as a pure function, with
  a test in `tests/` that you watched fail first; the adapter only wires it.
- An error never holds a call or a spawn, nor alters a listing: log it with
  its context, leave the listing whole and let the call through.
- A refusal always names the item, the rule with its file, and what to do
  instead.
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
2. Make the change with its test; run the four gates above.
3. Open a pull request against `develop`; `main` holds only releases.

Issues labelled
[good first issue](https://github.com/rezzminator/tool-visibility-controller/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
are a good start. By contributing you agree to license your work under the
repository's [MIT license](./LICENSE) and to follow the
[Code of Conduct](./CODE_OF_CONDUCT.md).
