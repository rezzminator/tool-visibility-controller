<!-- Pull requests go to `develop`; `main` holds only releases. -->

## What this changes

## Why

## How it was checked

- [ ] A behaviour change in `plugins/tool-visibility-controller/src/` has a test in `tests/` I watched fail first
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run validate:plugin` passes
- [ ] `npm run release:check` passes
- [ ] Tried in a real session with `claude --plugin-dir plugins/tool-visibility-controller` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, where the change touches a hook
- [ ] README and CHANGELOG (`## [Unreleased]`) updated where behaviour changed
