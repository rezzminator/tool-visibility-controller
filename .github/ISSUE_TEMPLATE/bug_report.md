---
name: Bug report
about: An agent, skill or tool still shows or runs where it should not, is hidden or refused where it should not be, or a gate fails
title: ''
labels: bug
assignees: ''
---

**What happened**

<!-- e.g. "the main chat still lists sub-tracer" or "rr's call of mcp__professor__harvester_read was refused" -->

**What you expected**

**The rule**

```markdown
---
name:
visibility:
---
```

<!-- The frontmatter or the tool-visibility-controller.json content, and where the file lives: ~/.claude/, $CLAUDE_CONFIG_DIR or a project's .claude/. -->

**Which loop**

<!-- The main chat, or a sub-agent of which type, and the item it saw or called. -->

**Environment**

- Claude Code version (`claude --version`):
- tool-visibility-controller version (see `/plugin`, or the plugin's `plugin.json`):
- OS:
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` set before Claude Code started: yes / no
- Started a new session after editing the rule: yes / no

**Log lines**

<!-- Any line starting with `tool-visibility-controller:`. Leave out paths or names you would rather keep private. -->
