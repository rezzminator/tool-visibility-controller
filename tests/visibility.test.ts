import { describe as suite, expect, it } from 'vitest';
import { readDefinition } from '../plugins/tool-visibility-controller/src/visibility.ts';

const def = (front: string, body = 'Body.\n') => `---\n${front}\n---\n${body}`;

suite('readDefinition: the name', () => {
  it('reads the frontmatter name, else the fallback', () => {
    expect(readDefinition(def('name: kid\ndescription: x'), 'file').name).toBe('kid');
    expect(readDefinition(def('description: x'), 'file').name).toBe('file');
    expect(readDefinition('no frontmatter\n', 'loose')).toEqual({ name: 'loose', visibility: null, problems: [] });
  });

  it('a definition without the key has no visibility and no problems', () => {
    expect(readDefinition(def('name: c\ndescription: visibility: [x] in prose'), 'c')).toEqual({ name: 'c', visibility: null, problems: [] });
  });
});

suite('readDefinition: the visibility field', () => {
  it.each([
    [
      'block maps with flow lists',
      'visibility:\n  visible-to:\n    include: [rr, rr-pro, main]\n    exclude: []\n  tools:\n    exclude: [WebFetch]',
      { visibleTo: { include: ['rr', 'rr-pro', 'main'], exclude: [] }, sets: { tools: { exclude: ['WebFetch'] } } },
    ],
    [
      'flow maps per set',
      'visibility:\n  skills:  { include: [a, "b"], exclude: [c] }   # trailing comment\n  mcp: {exclude: [professor/harvester_*]}',
      { sets: { skills: { include: ['a', 'b'], exclude: ['c'] }, mcp: { exclude: ['professor/harvester_*'] } } },
    ],
    [
      'block lists, indented and at the key\'s own indent',
      "visibility:\n  agents:\n    include:\n      - tracer\n      - 'sub-tracer'\n    exclude:\n    - Explore",
      { sets: { agents: { include: ['tracer', 'sub-tracer'], exclude: ['Explore'] } } },
    ],
    [
      'a whole flow map on the key line',
      'visibility: { visible-to: { include: [main] }, agents: { exclude: [Explore] } }',
      { visibleTo: { include: ['main'] }, sets: { agents: { exclude: ['Explore'] } } },
    ],
    [
      'an MCP server name with spaces and a glob',
      'visibility:\n  mcp:\n    include: [claude.ai Docs/*, professor]',
      { sets: { mcp: { include: ['claude.ai Docs/*', 'professor'] } } },
    ],
    [
      'flow collections with a trailing comma',
      'visibility:\n  tools: { exclude: [WebFetch, Bash, ], }',
      { sets: { tools: { exclude: ['WebFetch', 'Bash'] } } },
    ],
    [
      'a flow list wrapped over lines, as a formatter writes it',
      'visibility:\n  visible-to:\n    include:\n      [\n        rr,\n        rr-pro,\n      ]\n  agents:\n    exclude: [Explore,\n      Plan]',
      { visibleTo: { include: ['rr', 'rr-pro'] }, sets: { agents: { exclude: ['Explore', 'Plan'] } } },
    ],
    [
      'the whole field as a flow map wrapped over lines',
      'visibility:\n  { visible-to: { include: [main] },\n    tools: { exclude: [Bash] } }',
      { visibleTo: { include: ['main'] }, sets: { tools: { exclude: ['Bash'] } } },
    ],
  ])('reads %s', (_label, front, expected) => {
    const read = readDefinition(def(`name: kid\n${front}\ntools: Read`), 'kid');
    expect(read.visibility).toEqual(expected);
    expect(read.problems).toEqual([]);
  });

  it('reads CRLF frontmatter and a byte-order mark', () => {
    const read = readDefinition('﻿---\r\nname: c\r\nvisibility:\r\n  visible-to:\r\n    include: [p]\r\n---\r\nBody', 'c');
    expect(read.visibility).toEqual({ visibleTo: { include: ['p'] }, sets: {} });
  });

  it('stops the block at the next top-level key', () => {
    const read = readDefinition(def('visibility:\n  tools:\n    exclude: [Bash]\nmodel: sonnet\nother:\n  include: [x]'), 'c');
    expect(read.visibility).toEqual({ sets: { tools: { exclude: ['Bash'] } } });
  });
});

suite('readDefinition: a malformed block is reported and ignored, the others kept', () => {
  it.each([
    ['a scalar list', 'visibility:\n  tools:\n    exclude: WebFetch', /visibility\.tools\.exclude.*not a list/],
    ['an unclosed list', 'visibility:\n  tools:\n    exclude: [a, b', /visibility\.tools.*not closed/],
    ['an empty item', 'visibility:\n  tools:\n    exclude: [a, , b]', /visibility\.tools\.exclude.*empty item/],
    ['an unknown key in a block', 'visibility:\n  tools:\n    deny: [a]', /visibility\.tools.*unknown key "deny"/],
    ['an unknown block', 'visibility:\n  commands:\n    exclude: [a]', /visibility.*unknown key "commands"/],
    ['a block that is a list', 'visibility:\n  tools: [a]', /visibility\.tools.*not a mapping/],
    ['a nested list item', 'visibility:\n  tools:\n    exclude: [[a]]', /visibility\.tools\.exclude/],
    ['an empty block', 'visibility:\n  tools:\n  agents:\n    exclude: [x]', /visibility\.tools.*no value/],
    ['a block given twice', 'visibility:\n  tools:\n    exclude: [a]\n  tools:\n    exclude: [b]', /visibility\.tools.*given twice/],
    ['a key given twice in a flow map', 'visibility:\n  tools: { exclude: [a], exclude: [b] }', /visibility\.tools.*given twice/],
  ])('%s', (_label, front, problem) => {
    const read = readDefinition(def(`name: c\n${front}\n  skills:\n    exclude: [kept]`), 'c');
    expect(read.problems.join('\n')).toMatch(problem);
    expect(read.visibility?.sets.skills).toEqual({ exclude: ['kept'] });
  });

  it('a visibility value that is not a mapping is reported, nothing kept', () => {
    const read = readDefinition(def('name: c\nvisibility: [a]'), 'c');
    expect(read.visibility).toBeNull();
    expect(read.problems.join('\n')).toMatch(/visibility.*not a mapping/);
  });

  it('an empty visibility key is reported', () => {
    const read = readDefinition(def('name: c\nvisibility:\nmodel: x'), 'c');
    expect(read.visibility).toBeNull();
    expect(read.problems.join('\n')).toMatch(/visibility.*no value/);
  });
});
