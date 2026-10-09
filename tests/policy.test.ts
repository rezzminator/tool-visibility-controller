import { describe as suite, expect, it } from 'vitest';
import {
  ancestorDirs,
  buildPolicy,
  decide,
  denyText,
  globMatch,
  hasRules,
  isEmpty,
  itemMatches,
  MAIN,
  mcpServer,
  mergeScopes,
  readScopeFile,
  type Policy,
} from '../plugins/tool-visibility-controller/src/policy.ts';

suite('globMatch', () => {
  it.each([
    ['WebFetch', 'WebFetch', true],
    ['WebFetch', 'WebFetchX', false],
    ['harvester_*', 'harvester_search_web', true],
    ['*', 'anything', true],
    ['rr*', 'rr-pro-max', true],
    ['a.b', 'axb', false],
  ])('%s against %s is %s', (pattern, value, expected) => {
    expect(globMatch(pattern, value)).toBe(expected);
  });
});

suite('itemMatches', () => {
  it.each([
    ['mcp', 'professor', 'mcp__professor__harvester_read', true],
    ['mcp', 'professor/harvester_*', 'mcp__professor__harvester_read', true],
    ['mcp', 'professor/harvester_*', 'mcp__professor__chat_ls', false],
    ['mcp', 'claude.ai Docs/*', 'mcp__claude_ai_Docs__read', true],
    ['mcp', 'mcp__professor__chat_*', 'mcp__professor__chat_ls', true],
    ['mcp', 'prof', 'mcp__professor__chat_ls', false],
    ['mcp', 'my  srv/*', 'mcp__my__srv__read', true],
    ['mcp', 'my  srv/read', 'mcp__my__srv__read', true],
    ['skills', 'docs-kit:pdf', 'docs-kit:pdf', true],
    ['skills', 'pdf', 'docs-kit:pdf', true],
    ['skills', 'docs-kit:*', 'docs-kit:pdf', true],
    ['skills', 'pdf', 'pdfx', false],
    ['tools', 'Web*', 'WebSearch', true],
    ['agents', 'Explore', 'Explore', true],
  ] as const)('%s pattern %s against %s is %s', (set, pattern, name, expected) => {
    expect(itemMatches(set, pattern, name)).toBe(expected);
  });

  it('reads the server of an MCP tool name', () => {
    expect(mcpServer('mcp__claude_ai_Docs__read')).toBe('claude_ai_Docs');
    expect(mcpServer('WebFetch')).toBeUndefined();
  });
});

function policy(): Policy {
  return buildPolicy(
    [
      { set: 'agents', name: 'sub-tracer', path: '/u/.claude/agents/sub-tracer.md', visibility: { visibleTo: { include: ['tracer', 'sub-tracer'] }, sets: {} } },
      { set: 'agents', name: 'rr', path: '/p/.claude/agents/rr.md', visibility: { sets: { mcp: { include: ['professor/harvester_*'] }, tools: { exclude: ['Bash'] } } } },
      { set: 'agents', name: 'both', path: '/p/.claude/agents/both.md', visibility: { visibleTo: { include: ['a*'], exclude: ['ab'] }, sets: {} } },
      { set: 'skills', name: 'greet', path: '/p/.claude/skills/greet/SKILL.md', visibility: { visibleTo: { exclude: [MAIN] }, sets: { tools: { exclude: ['x'] } } } },
    ],
    mergeScopes([
      {
        path: '/p/.claude/tool-visibility-controller.json',
        scope: {
          loops: { main: { agents: { exclude: ['Explore'] }, mcp: { exclude: ['professor/harvester_*'] } } },
          items: { agents: { Explore: { include: ['rr'] } }, skills: {}, mcp: {}, tools: { WebFetch: { exclude: ['Explore'] } } },
        },
      },
    ]),
  );
}

suite('decide', () => {
  it.each([
    ['item include admits a listed loop', 'agents', 'tracer', 'sub-tracer', true],
    ['item include refuses another loop', 'agents', MAIN, 'sub-tracer', false],
    ['item include+exclude: in include, not excluded', 'agents', 'ax', 'both', true],
    ['item include+exclude: excluded', 'agents', 'ab', 'both', false],
    ['item include+exclude: outside include', 'agents', 'b', 'both', false],
    ['item exclude refuses the excluded loop', 'skills', MAIN, 'greet', false],
    ['item exclude admits any other loop', 'skills', 'rr', 'greet', true],
    ['viewer include admits a match', 'mcp', 'rr', 'mcp__professor__harvester_read', true],
    ['viewer include refuses the rest', 'mcp', 'rr', 'mcp__professor__chat_ls', false],
    ['viewer exclude refuses a match', 'tools', 'rr', 'Bash', false],
    ['viewer exclude admits the rest', 'tools', 'rr', 'Read', true],
    ['a skill file has no viewer blocks', 'tools', 'greet', 'x', true],
    ['scope loop rule for main', 'agents', MAIN, 'Explore', false],
    ['scope loop rule for main, mcp', 'mcp', MAIN, 'mcp__professor__harvester_search_web', false],
    ['scope item rule for a built-in agent', 'agents', 'tracer', 'Explore', false],
    ['scope item rule admits its loop', 'agents', 'rr', 'Explore', true],
    ['scope item rule for a built-in tool', 'tools', 'Explore', 'WebFetch', false],
    ['an unruled item is allowed', 'agents', MAIN, 'general-purpose', true],
  ] as const)('%s', (_label, set, loop, item, allowed) => {
    expect(decide(policy(), set, loop, item).allowed).toBe(allowed);
  });

  it('frontmatter and the scope file combine by AND', () => {
    const p = buildPolicy(
      [{ set: 'agents', name: 'kid', path: '/a.md', visibility: { visibleTo: { include: ['x', 'y'] }, sets: {} } }],
      mergeScopes([{ path: '/s.json', scope: { loops: {}, items: { agents: { kid: { exclude: ['y'] } }, skills: {}, mcp: {}, tools: {} } } }]),
    );
    expect(decide(p, 'agents', 'x', 'kid').allowed).toBe(true);
    expect(decide(p, 'agents', 'y', 'kid').allowed).toBe(false);
  });

  it('names the refusing rule: its block and its file', () => {
    const verdict = decide(policy(), 'agents', MAIN, 'sub-tracer');
    expect(verdict).toMatchObject({ allowed: false, side: 'item', rule: { block: 'visibility.visible-to', path: '/u/.claude/agents/sub-tracer.md' } });
    expect(decide(policy(), 'mcp', MAIN, 'mcp__professor__harvester_read')).toMatchObject({
      allowed: false,
      side: 'viewer',
      rule: { block: 'loops.main.mcp', path: '/p/.claude/tool-visibility-controller.json' },
    });
  });

  it('isEmpty and hasRules', () => {
    expect(isEmpty(buildPolicy([], mergeScopes([])))).toBe(true);
    expect(isEmpty(policy())).toBe(false);
    expect(hasRules(policy(), 'mcp')).toBe(true);
    expect(hasRules(buildPolicy([], mergeScopes([])), 'mcp')).toBe(false);
  });
});

suite('denyText', () => {
  it('names the item, the caller, the rule with its file, and whom to delegate to', () => {
    const text = denyText('agents', 'sub-tracer', MAIN, decide(policy(), 'agents', MAIN, 'sub-tracer'));
    expect(text).toContain('Agent type sub-tracer is not available to the main chat');
    expect(text).toContain('visibility.visible-to in /u/.claude/agents/sub-tracer.md');
    expect(text).toContain('admits only tracer and sub-tracer');
    expect(text).toContain('Delegate the task to tracer or sub-tracer, or choose another agent type.');
  });

  it('names an exclusion and the matching pattern, and what to do instead', () => {
    const text = denyText('mcp', 'mcp__professor__harvester_read', MAIN, decide(policy(), 'mcp', MAIN, 'mcp__professor__harvester_read'));
    expect(text).toContain('MCP tool mcp__professor__harvester_read is not available to the main chat');
    expect(text).toContain('excludes professor/harvester_*');
    expect(text).toContain('loops.main.mcp in /p/.claude/tool-visibility-controller.json');
    expect(text).toMatch(/use another tool/i);
  });

  it('names a sub-agent caller by its type', () => {
    expect(denyText('tools', 'Bash', 'rr', decide(policy(), 'tools', 'rr', 'Bash'))).toContain('Tool Bash is not available to a rr agent');
  });
});

suite('readScopeFile', () => {
  it('reads loops and items', () => {
    const read = readScopeFile(
      JSON.stringify({
        loops: { main: { mcp: { exclude: ['professor/harvester_*'] } }, Explore: { tools: { exclude: ['WebFetch'] } } },
        items: { agents: { Explore: { 'visible-to': { exclude: ['main'] } } }, skills: { 'plugin:x': { 'visible-to': { include: ['tracer'] } } }, tools: {} },
      }),
    );
    expect(read.problems).toEqual([]);
    expect(read.scope).toEqual({
      loops: { main: { mcp: { exclude: ['professor/harvester_*'] } }, Explore: { tools: { exclude: ['WebFetch'] } } },
      items: { agents: { Explore: { exclude: ['main'] } }, skills: { 'plugin:x': { include: ['tracer'] } }, mcp: {}, tools: {} },
    });
  });

  it('reports invalid JSON and reads nothing', () => {
    const read = readScopeFile('{ "loops": ');
    expect(read.scope).toBeNull();
    expect(read.problems.join('\n')).toMatch(/not valid JSON/);
  });

  it.each([
    ['a top level that is not an object', '[]', /top level.*not an object/],
    ['an unknown top-level key', '{"rules": {}}', /unknown key "rules"/],
    ['a set block that is not a filter', '{"loops": {"main": {"mcp": ["x"]}}}', /loops\.main\.mcp.*not an object/],
    ['an unknown set', '{"loops": {"main": {"commands": {}}}}', /loops\.main.*unknown key "commands"/],
    ['a list that is not of strings', '{"loops": {"main": {"tools": {"exclude": [1]}}}}', /loops\.main\.tools\.exclude.*not a list of names/],
    ['an item without visible-to', '{"items": {"agents": {"Explore": {"include": ["x"]}}}}', /items\.agents\.Explore.*unknown key "include"/],
  ])('reports %s and keeps the rest', (_label, json, problem) => {
    const read = readScopeFile(json);
    expect(read.problems.join('\n')).toMatch(problem);
  });

  it('keeps the valid blocks beside a bad one', () => {
    const read = readScopeFile('{"loops": {"main": {"mcp": {"exclude": "x"}, "tools": {"exclude": ["Bash"]}}}}');
    expect(read.scope?.loops).toEqual({ main: { tools: { exclude: ['Bash'] } } });
  });
});

suite('mergeScopes', () => {
  it('a nearer file replaces a farther one key by key', () => {
    const merged = mergeScopes([
      { path: '/u.json', scope: { loops: { main: { tools: { exclude: ['Bash'] }, mcp: { exclude: ['x'] } } }, items: { agents: { Explore: { exclude: ['main'] } }, skills: {}, mcp: {}, tools: {} } } },
      { path: '/p.json', scope: { loops: { main: { tools: { exclude: ['Read'] } } }, items: { agents: {}, skills: {}, mcp: {}, tools: {} } } },
    ]);
    const p = buildPolicy([], merged);
    expect(decide(p, 'tools', MAIN, 'Bash').allowed).toBe(true);
    expect(decide(p, 'tools', MAIN, 'Read')).toMatchObject({ allowed: false, rule: { path: '/p.json' } });
    expect(decide(p, 'mcp', MAIN, 'mcp__x__y')).toMatchObject({ allowed: false, rule: { path: '/u.json' } });
    expect(decide(p, 'agents', MAIN, 'Explore')).toMatchObject({ allowed: false, rule: { path: '/u.json' } });
  });
});

suite('ancestorDirs', () => {
  it('lists every directory from the filesystem root down to the root given', () => {
    expect(ancestorDirs('/a/b/c')).toEqual(['/', '/a', '/a/b', '/a/b/c']);
    expect(ancestorDirs('/a/b/')).toEqual(['/', '/a', '/a/b']);
    expect(ancestorDirs('/')).toEqual(['/']);
  });

  it('stops below the home directory, which is the user tier and not a project', () => {
    expect(ancestorDirs('/h/u/p/q', '/h/u')).toEqual(['/h/u/p', '/h/u/p/q']);
    expect(ancestorDirs('/h/u', '/h/u/')).toEqual([]);
    expect(ancestorDirs('/tmp/x', '/h/u')).toEqual(['/', '/tmp', '/tmp/x']);
  });
});
