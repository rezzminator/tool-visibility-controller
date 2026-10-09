---
name: Bug report
about: A scoped agent still shows or spawns where it should not, is hidden or refused where it should not be, or a gate fails
title: ''
labels: bug
assignees: ''
---

**What happened**

<!-- e.g. "the main chat still lists sub-tracer" or "tracer's spawn of sub-tracer was refused" -->

**What you expected**

**The agent definition**

```markdown
---
name:
available-to:
---
```

<!-- Its frontmatter, and where the file lives: ~/.claude/agents/, $CLAUDE_CONFIG_DIR/agents or a project's .claude/agents/. -->

**Who dispatched it**

<!-- The main chat, or a sub-agent of which type. -->

**Environment**

- Claude Code version (`claude --version`):
- agent-scope version (see `/plugin`, or the plugin's `plugin.json`):
- OS:
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` set before Claude Code started: yes / no
- Started a new session after editing `available-to`: yes / no

**Log lines**

<!-- Any line starting with `agent-scope:`. Leave out paths or names you would rather keep private. -->
