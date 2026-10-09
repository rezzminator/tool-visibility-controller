// Reading the `visibility` field of an agent, skill or command definition's
// YAML frontmatter, pure. A YAML subset suffices: block and flow mappings,
// block and flow lists, plain and quoted scalars, comments.

/** A filter over names: `include` keeps only matches, `exclude` drops matches; both, include minus exclude. */
export type Filter = { include?: readonly string[]; exclude?: readonly string[] };

/** The four sets a loop sees and invokes. */
export const SETS = ['agents', 'skills', 'mcp', 'tools'] as const;
export type SetName = (typeof SETS)[number];

/** The `visibility` field: who may see the item (`visible-to`), and what the agent's own loop sees, per set. */
export type Visibility = { visibleTo?: Filter; sets: Partial<Record<SetName, Filter>> };

/** One definition: its name, its field (null when absent or unreadable), and every problem found in it. */
export type Definition = { name: string; visibility: Visibility | null; problems: string[] };

/** The frontmatter key and its block names. */
export const FIELD = 'visibility';
export const VISIBLE_TO = 'visible-to';

type Value = string | Value[] | ValueMap | null | Broken;
type ValueMap = Map<string, Value>;

/** A value that could not be read, kept in place of a block so its siblings stand. */
class Broken {
  constructor(
    readonly path: string[],
    readonly message: string,
  ) {}
}

class Malformed extends Error {
  readonly path: string[] = [];
}

function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function unquote(raw: string): string {
  const item = raw.trim();
  if (item.length >= 2 && (item[0] === '"' || item[0] === "'") && item.at(-1) === item[0]) return item.slice(1, -1);
  return item;
}

// A flow value (`[a, b]`, `{ k: v }`, or a scalar) read from `text` at `at`.
function readFlow(text: string, at: { i: number }): Value {
  const skip = () => {
    while (at.i < text.length && /\s/.test(text[at.i] ?? '')) at.i += 1;
  };
  skip();
  const c = text[at.i];
  if (c === '[') {
    at.i += 1;
    const items: Value[] = [];
    skip();
    if (text[at.i] === ']') {
      at.i += 1;
      return items;
    }
    for (;;) {
      skip();
      if (text[at.i] === ',' || text[at.i] === ']') throw new Malformed('a list has an empty item');
      items.push(readFlow(text, at));
      skip();
      if (text[at.i] === ',') {
        at.i += 1;
        skip();
        if (text[at.i] !== ']') continue;
      }
      if (text[at.i] === ']') {
        at.i += 1;
        return items;
      }
      throw new Malformed('a list is not closed with ]');
    }
  }
  if (c === '{') {
    at.i += 1;
    const map: ValueMap = new Map();
    skip();
    if (text[at.i] === '}') {
      at.i += 1;
      return map;
    }
    for (;;) {
      skip();
      const colon = text.indexOf(':', at.i);
      if (colon < 0) throw new Malformed('a mapping entry has no ":"');
      const key = unquote(text.slice(at.i, colon));
      if (key === '' || /[[\]{},]/.test(key)) throw new Malformed(`${JSON.stringify(key)} is not a key`);
      if (map.has(key)) throw new Malformed(`${JSON.stringify(key)} is given twice`);
      at.i = colon + 1;
      map.set(key, readFlow(text, at));
      skip();
      if (text[at.i] === ',') {
        at.i += 1;
        skip();
        if (text[at.i] !== '}') continue;
      }
      if (text[at.i] === '}') {
        at.i += 1;
        return map;
      }
      throw new Malformed('a mapping is not closed with }');
    }
  }
  if (c === '"' || c === "'") {
    const end = text.indexOf(c, at.i + 1);
    if (end < 0) throw new Malformed('a quoted name is not closed');
    const value = text.slice(at.i + 1, end);
    at.i = end + 1;
    return value;
  }
  const start = at.i;
  while (at.i < text.length && !/[,\]}]/.test(text[at.i] ?? '')) at.i += 1;
  return text.slice(start, at.i).trim();
}

function parseInline(value: string): Value {
  const at = { i: 0 };
  const parsed = readFlow(value, at);
  if (value.slice(at.i).trim() !== '') {
    throw new Malformed(value.trimStart().startsWith('[') ? 'a list is not closed with ]' : `${JSON.stringify(value.trim())} has text after its value`);
  }
  return parsed;
}

// A block (mapping or list) from `lines`, every one indented at least as the first.
// With `isolate`, a key whose value cannot be read holds a Broken in its place.
function parseBlock(lines: readonly string[], isolate = false): Value {
  const rows = lines.filter((line) => line.trim() !== '');
  const first = rows[0];
  if (first === undefined) return null;
  const base = indentOf(first);
  if (first.trimStart().startsWith('- ') || first.trim() === '-') {
    const items: Value[] = [];
    for (const row of rows) {
      if (indentOf(row) !== base) throw new Malformed('a list item is nested');
      const item = /^\s*-\s*(.*)$/.exec(row)?.[1];
      if (item === undefined) throw new Malformed('a list mixes items and keys');
      if (item === '') throw new Malformed('a list has an empty item');
      items.push(parseInline(item));
    }
    return items;
  }
  const map: ValueMap = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? '';
    if (indentOf(row) !== base) throw new Malformed('a line is indented deeper than its key');
    const entry = /^\s*("[^"]*"|'[^']*'|[^:\s][^:]*?)\s*:(?:\s+(.*))?$/.exec(row);
    if (entry === null) throw new Malformed(`${JSON.stringify(row.trim())} is not a key: value line`);
    const key = unquote(entry[1] ?? '');
    const inline = entry[2]?.trim() ?? '';
    const twice = map.has(key);
    // A flow collection may wrap onto deeper lines: on the key's line, or below it.
    const wraps = /^[[{]/.test(inline);
    const child: string[] = [];
    while ((inline === '' || wraps) && i + 1 < rows.length) {
      const next = rows[i + 1] ?? '';
      const deeper = indentOf(next) > base;
      const sameIndentList = inline === '' && indentOf(next) === base && /^\s*-(\s|$)/.test(next);
      if (!deeper && !sameIndentList) break;
      child.push(next);
      i += 1;
    }
    const flow = wraps || /^[[{]/.test(child[0]?.trim() ?? '');
    try {
      if (twice) throw new Malformed('it is given twice');
      map.set(
        key,
        flow
          ? parseInline([inline, ...child.map((line) => line.trim())].join(' '))
          : inline !== ''
            ? parseInline(inline)
            : child.length === 0
              ? null
              : parseBlock(child),
      );
    } catch (error) {
      if (!(error instanceof Malformed)) throw error;
      error.path.unshift(key);
      if (!isolate) throw error;
      map.set(key, new Broken(error.path, error.message));
    }
  }
  return map;
}

function isMap(value: Value): value is ValueMap {
  return value instanceof Map;
}

/** A name in a list: non-empty, on one line, without flow punctuation. */
function isName(value: Value): value is string {
  return typeof value === 'string' && value.trim() !== '' && !/[[\]{},\n]/.test(value);
}

// A filter block at `path`, or the reason it is unusable.
function readFilter(value: Value, path: string, problems: string[]): Filter | undefined {
  if (value instanceof Broken) {
    problems.push(`${FIELD}.${value.path.join('.')}: ${value.message}`);
    return undefined;
  }
  if (value === null) {
    problems.push(`${path} has no value`);
    return undefined;
  }
  if (!isMap(value)) {
    problems.push(`${path} is not a mapping of include and exclude`);
    return undefined;
  }
  const filter: { include?: string[]; exclude?: string[] } = {};
  for (const [key, list] of value) {
    if (key !== 'include' && key !== 'exclude') {
      problems.push(`${path} has an unknown key ${JSON.stringify(key)}; use include or exclude`);
      return undefined;
    }
    if (!Array.isArray(list)) {
      problems.push(`${path}.${key} is not a list; write [name, ...]`);
      return undefined;
    }
    const bad = list.find((item) => !isName(item));
    if (bad !== undefined) {
      problems.push(`${path}.${key} holds ${JSON.stringify(bad)}, which is not a name`);
      return undefined;
    }
    filter[key] = list.map((item) => (item as string).trim());
  }
  return filter;
}

/** Reads the `visibility` field's value, its problems reported by block path, each bad block left out. */
export function readVisibility(value: Value | undefined, problems: string[]): Visibility | null {
  if (value === undefined) return null;
  if (value === null) {
    problems.push(`${FIELD} has no value`);
    return null;
  }
  if (value instanceof Broken) {
    problems.push(`${FIELD}.${value.path.join('.')}: ${value.message}`);
    return null;
  }
  if (!isMap(value)) {
    problems.push(`${FIELD} is not a mapping of visible-to, agents, skills, mcp and tools`);
    return null;
  }
  const visibility: Visibility = { sets: {} };
  for (const [key, block] of value) {
    const path = `${FIELD}.${key}`;
    if (key === VISIBLE_TO) {
      const filter = readFilter(block, path, problems);
      if (filter !== undefined) visibility.visibleTo = filter;
    } else if ((SETS as readonly string[]).includes(key)) {
      const filter = readFilter(block, path, problems);
      if (filter !== undefined) visibility.sets[key as SetName] = filter;
    } else {
      problems.push(`${FIELD} has an unknown key ${JSON.stringify(key)}; use visible-to, agents, skills, mcp or tools`);
    }
  }
  return visibility;
}

/**
 * Reads one definition's name (frontmatter `name`, else `fallback`) and its
 * `visibility` field from the YAML frontmatter. A malformed block is named in
 * `problems` and left out; the other blocks stand.
 */
export function readDefinition(text: string, fallback: string): Definition {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { name: fallback, visibility: null, problems: [] };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  const front = lines.slice(1, end < 0 ? lines.length : end).map(stripComment);
  const nameLine = front.find((line) => /^name:/.test(line));
  const name = nameLine === undefined ? '' : unquote(nameLine.slice('name:'.length));
  const at = front.findIndex((line) => line.startsWith(`${FIELD}:`));
  const problems: string[] = [];
  if (at < 0) return { name: name === '' ? fallback : name, visibility: null, problems };
  const inline = (front[at] ?? '').slice(FIELD.length + 1).trim();
  const block: string[] = [];
  for (const line of front.slice(at + 1)) {
    if (line.trim() !== '' && indentOf(line) === 0) break;
    block.push(line);
  }
  const rows = block.filter((line) => line.trim() !== '');
  let value: Value;
  try {
    value = /^[[{]/.test(inline || (rows[0]?.trim() ?? ''))
      ? parseInline([inline, ...rows.map((line) => line.trim())].join(' '))
      : inline !== ''
        ? parseInline(inline)
        : rows.length > 0
          ? parseBlock(block, true)
          : null;
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    problems.push([FIELD, ...error.path].join('.') + `: ${error.message}`);
    return { name: name === '' ? fallback : name, visibility: null, problems };
  }
  return { name: name === '' ? fallback : name, visibility: readVisibility(value, problems), problems };
}
