import { describe as suite, expect, it } from 'vitest';
import {
  ancestorDirs,
  buildRules,
  denyText,
  filterListing,
  hiddenFrom,
  isAgentFile,
  MAIN,
  mayUse,
  readDefinition,
} from '../plugins/agent-scope/src/scope.ts';

const def = (front: string, body = 'Body.\n') => `---\n${front}\n---\n${body}`;

suite('readDefinition', () => {
  it('reads the name and a flow list', () => {
    expect(readDefinition(def('name: scope-child\ndescription: x\navailable-to: [scope-parent, main]'), 'f.md')).toEqual({
      name: 'scope-child',
      availableTo: { kind: 'ok', parents: ['scope-parent', 'main'] },
    });
  });

  it('reads quoted flow items and a trailing comment', () => {
    expect(readDefinition(def(`name: c\navailable-to: ["a", 'b'] # who may`), 'c.md').availableTo).toEqual({ kind: 'ok', parents: ['a', 'b'] });
  });

  it('reads a block list', () => {
    expect(readDefinition(def('name: c\navailable-to:\n  - tracer\n  - "sub-tracer"\ntools: Read'), 'c.md').availableTo).toEqual({
      kind: 'ok',
      parents: ['tracer', 'sub-tracer'],
    });
  });

  it('reads an empty flow list as scoped to nobody', () => {
    expect(readDefinition(def('name: c\navailable-to: []'), 'c.md').availableTo).toEqual({ kind: 'ok', parents: [] });
  });

  it('an agent without the key is unscoped', () => {
    expect(readDefinition(def('name: c\ndescription: available-to: [x] in prose'), 'c.md').availableTo).toEqual({ kind: 'none' });
  });

  it('a file without frontmatter is unscoped and named by its file', () => {
    expect(readDefinition('available-to: [x]\n', 'loose.md')).toEqual({ name: 'loose', availableTo: { kind: 'none' } });
  });

  it('falls back to the file name when name is missing', () => {
    expect(readDefinition(def('available-to: [p]'), 'kid.md').name).toBe('kid');
  });

  it('reads CRLF frontmatter', () => {
    expect(readDefinition('---\r\nname: c\r\navailable-to: [p]\r\n---\r\nBody', 'c.md')).toEqual({
      name: 'c',
      availableTo: { kind: 'ok', parents: ['p'] },
    });
  });

  it.each([
    ['a scalar', 'available-to: scope-parent'],
    ['an unclosed list', 'available-to: [a, b'],
    ['an empty item', 'available-to: [a, , b]'],
    ['an item with spaces', 'available-to: [a b]'],
    ['a nested list', 'available-to: [[a]]'],
    ['no value', 'available-to:\ntools: Read'],
    ['a mapping', 'available-to:\n  parent: a'],
  ])('reports %s as bad', (_label, line) => {
    expect(readDefinition(def(`name: c\n${line}`), 'c.md').availableTo.kind).toBe('bad');
  });
});

suite('buildRules and mayUse', () => {
  it('a later tier overrides an earlier one by name, unscoped included', () => {
    const rules = buildRules([
      [
        { name: 'a', parents: ['p'] },
        { name: 'b', parents: ['p'] },
      ],
      [{ name: 'a', parents: null }],
      [{ name: 'b', parents: ['q'] }],
    ]);
    expect(rules.get('a')).toBeNull();
    expect(rules.get('b')).toEqual(['q']);
  });

  it('allows an unscoped or unknown type, and a scoped one only to its parents', () => {
    const rules = buildRules([[{ name: 'kid', parents: ['parent', MAIN] }, { name: 'free', parents: null }]]);
    expect(mayUse(rules, 'free', 'anyone')).toBe(true);
    expect(mayUse(rules, 'general-purpose', 'anyone')).toBe(true);
    expect(mayUse(rules, 'kid', 'parent')).toBe(true);
    expect(mayUse(rules, 'kid', MAIN)).toBe(true);
    expect(mayUse(rules, 'kid', 'general-purpose')).toBe(false);
  });

  it('hiddenFrom names every scoped type the caller may not use', () => {
    const rules = buildRules([[{ name: 'kid', parents: ['parent'] }, { name: 'nobody', parents: [] }, { name: 'free', parents: null }]]);
    expect([...hiddenFrom(rules, MAIN)].sort()).toEqual(['kid', 'nobody']);
    expect([...hiddenFrom(rules, 'parent')]).toEqual(['nobody']);
  });
});

// The shape Claude Code 2.1.295 renders, captured from a live probe.
const LISTING = [
  'Available agent types for the Agent tool:',
  '- general-purpose: General-purpose agent for researching complex questions. (Tools: *)',
  '- scope-child: Test child agent for the scope probe. Answers with the word CHILD-PONG and nothing else. (Tools: Read)',
  '- scope-parent: Test parent agent for the scope probe. Spawns scope-child when asked. (Tools: Agent, Read)',
  '- sub-tracer: TRACER-ONLY follows one thread of code — spawned by tracer. (Tools: Read, Grep, Glob, Bash, Agent)',
  '',
  'When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.',
].join('\n');

suite('filterListing', () => {
  it('removes a hidden agent line and keeps every other byte', () => {
    const out = filterListing(LISTING, new Set(['scope-child']));
    expect(out).toBe(LISTING.replace('- scope-child: Test child agent for the scope probe. Answers with the word CHILD-PONG and nothing else. (Tools: Read)\n', ''));
  });

  it('returns the same text when nothing is hidden or nothing matches', () => {
    expect(filterListing(LISTING, new Set())).toBe(LISTING);
    expect(filterListing(LISTING, new Set(['absent']))).toBe(LISTING);
  });

  it('matches the whole name, never a prefix', () => {
    expect(filterListing(LISTING, new Set(['scope']))).toBe(LISTING);
    expect(filterListing(LISTING, new Set(['sub']))).toBe(LISTING);
  });

  it('is deterministic: the same input gives the same output', () => {
    const hidden = new Set(['scope-child', 'sub-tracer']);
    expect(filterListing(LISTING, hidden)).toBe(filterListing(LISTING, new Set(['sub-tracer', 'scope-child'])));
  });

  it('removes a description that spans lines, up to its Tools suffix', () => {
    const text = ['Available agent types for the Agent tool:', '- kid: first line', 'second line (Tools: Read)', '- other: x (Tools: *)', ''].join('\n');
    expect(filterListing(text, new Set(['kid']))).toBe(['Available agent types for the Agent tool:', '- other: x (Tools: *)', ''].join('\n'));
  });

  it('stops a spanning description at a blank line or the next entry', () => {
    const text = ['- kid: no suffix', '- other: x (Tools: *)', '', 'Footer.'].join('\n');
    expect(filterListing(text, new Set(['kid']))).toBe(['- other: x (Tools: *)', '', 'Footer.'].join('\n'));
  });

  it('removes a bare name line, as a removal section lists it', () => {
    const text = ['- other: x (Tools: *)', '', 'No longer available:', '- kid', '- gone'].join('\n');
    expect(filterListing(text, new Set(['kid']))).toBe(['- other: x (Tools: *)', '', 'No longer available:', '- gone'].join('\n'));
  });

  it('drops the attachment when every entry it carried was hidden', () => {
    const text = ['New agent types are available for the Agent tool:', '- kid: x (Tools: Read)', ''].join('\n');
    expect(filterListing(text, new Set(['kid']))).toBeNull();
  });
});

suite('denyText', () => {
  it('names the allowed parents and the caller, and says what to do', () => {
    const text = denyText('scope-child', ['scope-parent', MAIN], 'general-purpose');
    expect(text).toContain('scope-child is available only to scope-parent or the main chat');
    expect(text).toContain('a general-purpose agent');
    expect(text).toMatch(/choose another agent type/i);
  });

  it('names the main chat as the caller', () => {
    expect(denyText('scope-child', ['scope-parent'], MAIN)).toContain('the main chat cannot dispatch it');
  });

  it('says an empty list lets nobody spawn it', () => {
    expect(denyText('x', [], MAIN)).toContain('no agent may spawn it');
  });
});

suite('ancestorDirs', () => {
  it('lists every directory from the filesystem root down to the root given', () => {
    expect(ancestorDirs('/a/b/c')).toEqual(['/', '/a', '/a/b', '/a/b/c']);
    expect(ancestorDirs('/a/b/')).toEqual(['/', '/a', '/a/b']);
    expect(ancestorDirs('/')).toEqual(['/']);
  });
});

suite('isAgentFile', () => {
  it('takes a markdown file or a link to one, never a directory', () => {
    expect(isAgentFile({ name: 'a.md', kind: 'file' })).toBe(true);
    expect(isAgentFile({ name: 'a.md', kind: 'other' })).toBe(true);
    expect(isAgentFile({ name: 'a.md', kind: 'dir' })).toBe(false);
    expect(isAgentFile({ name: 'a.txt', kind: 'file' })).toBe(false);
  });
});
