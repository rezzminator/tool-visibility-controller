// Every decision of agent-scope, pure: reading a definition's `available-to`, the
// rule table, who may use what, the listing filter and the deny text.

/** The caller name for the main chat, in `available-to` and as a loop. */
export const MAIN = 'main';

/** A definition's `available-to`: absent, a list of agent types, or malformed (why). */
export type AvailableTo = { kind: 'none' } | { kind: 'ok'; parents: string[] } | { kind: 'bad'; reason: string };

export type Definition = { name: string; availableTo: AvailableTo };

/** One agent type's rule: the types allowed to see and spawn it, or null when unscoped. */
export type Rule = { name: string; parents: readonly string[] | null };

/** Agent type → its allowed parents; null (or no entry) is unscoped. */
export type Rules = ReadonlyMap<string, readonly string[] | null>;

const ITEM = /^[A-Za-z0-9_.:@+-]+$/;

function unquote(raw: string): string {
  const item = raw.trim();
  if (item.length >= 2 && (item[0] === '"' || item[0] === "'") && item.at(-1) === item[0]) return item.slice(1, -1);
  return item;
}

function stripComment(value: string): string {
  const at = value.search(/\s#/);
  return (at < 0 ? value : value.slice(0, at)).trim();
}

function parseItems(items: string[]): AvailableTo {
  const parents = items.map(unquote);
  const bad = parents.find((item) => !ITEM.test(item));
  if (bad !== undefined) return { kind: 'bad', reason: `item ${JSON.stringify(bad)} is not an agent type name` };
  return { kind: 'ok', parents };
}

function parseAvailableTo(lines: string[], at: number, value: string): AvailableTo {
  const flow = stripComment(value);
  if (flow.startsWith('[')) {
    if (!flow.endsWith(']')) return { kind: 'bad', reason: 'the list is not closed with ]' };
    const inner = flow.slice(1, -1).trim();
    return inner === '' ? { kind: 'ok', parents: [] } : parseItems(inner.split(','));
  }
  if (flow !== '') return { kind: 'bad', reason: `${JSON.stringify(flow)} is not a list` };
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item === null) break;
    items.push(stripComment(item[1] ?? ''));
  }
  if (items.length === 0) return { kind: 'bad', reason: 'it has no value; write [parent, ...]' };
  return parseItems(items);
}

/**
 * Reads one agent definition's name (frontmatter `name`, else the file name)
 * and its `available-to` key from the YAML frontmatter.
 */
export function readDefinition(text: string, fileName: string): Definition {
  const fallback = fileName.replace(/\.md$/, '');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { name: fallback, availableTo: { kind: 'none' } };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  const front = lines.slice(1, end < 0 ? lines.length : end);
  const nameLine = front.find((line) => /^name:/.test(line));
  const name = nameLine === undefined ? '' : unquote(stripComment(nameLine.slice('name:'.length)));
  const at = front.findIndex((line) => /^available-to:/.test(line));
  const availableTo: AvailableTo = at < 0 ? { kind: 'none' } : parseAvailableTo(front, at, (front[at] ?? '').slice('available-to:'.length));
  return { name: name === '' ? fallback : name, availableTo };
}

/** The rule table from tiers given lowest precedence first: a later tier's definition replaces an earlier one's by name. */
export function buildRules(tiers: ReadonlyArray<ReadonlyArray<Rule>>): Map<string, readonly string[] | null> {
  const rules = new Map<string, readonly string[] | null>();
  for (const tier of tiers) for (const rule of tier) rules.set(rule.name, rule.parents);
  return rules;
}

/** Whether `caller` (an agent type, or MAIN) may see and spawn `agentType`. */
export function mayUse(rules: Rules, agentType: string, caller: string): boolean {
  const parents = rules.get(agentType);
  return parents == null || parents.includes(caller);
}

/** Every scoped agent type `caller` may not see. */
export function hiddenFrom(rules: Rules, caller: string): Set<string> {
  const hidden = new Set<string>();
  for (const [name, parents] of rules) if (parents !== null && !parents.includes(caller)) hidden.add(name);
  return hidden;
}

const TOOLS_SUFFIX = /\(Tools: [^()]*\)\s*$/;

function entryName(line: string): string | undefined {
  return /^- ([^\s:]+)(?::|$)/.exec(line)?.[1];
}

/**
 * The listing text without the entries of the hidden agent types; every other
 * byte as given, so the same input always gives the same output. An entry is a
 * `- name: description (Tools: ...)` line, a description that spans lines up to
 * its Tools suffix (stopping at a blank line or the next entry), or a bare
 * `- name` line. Null when every entry the text carried was hidden.
 */
export function filterListing(text: string, hidden: ReadonlySet<string>): string | null {
  if (hidden.size === 0) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let removed = 0;
  let remaining = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const name = entryName(line);
    if (name === undefined) {
      kept.push(line);
      continue;
    }
    if (!hidden.has(name)) {
      remaining += 1;
      kept.push(line);
      continue;
    }
    removed += 1;
    const spans = line.startsWith(`- ${name}:`) && !TOOLS_SUFFIX.test(line);
    if (!spans) continue;
    while (i + 1 < lines.length) {
      const next = lines[i + 1] ?? '';
      if (next.trim() === '' || next.startsWith('- ')) break;
      i += 1;
      if (TOOLS_SUFFIX.test(next)) break;
    }
  }
  if (removed === 0) return text;
  return remaining === 0 ? null : kept.join('\n');
}

function who(name: string): string {
  return name === MAIN ? 'the main chat' : name;
}

/** The refusal the model reads when `caller` dispatches a scoped `agentType` it is not a parent of. */
export function denyText(agentType: string, parents: readonly string[], caller: string): string {
  const from = caller === MAIN ? 'the main chat' : `a ${caller} agent`;
  if (parents.length === 0) {
    return `${agentType} has an empty available-to list, so no agent may spawn it, and ${from} cannot dispatch it. Choose another agent type.`;
  }
  const names = parents.map(who);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
  return `${agentType} is available only to ${list} (its available-to list); ${from} cannot dispatch it. Delegate the task to ${list}, or choose another agent type.`;
}

/** Every directory from the filesystem root down to `root`, root first. */
export function ancestorDirs(root: string): string[] {
  const parts = root.split('/').filter((part) => part !== '');
  return ['/', ...parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];
}

/** A directory entry that may hold an agent definition: a `.md` file, or a link (to one). */
export function isAgentFile(entry: { name: string; kind: string }): boolean {
  return entry.name.endsWith('.md') && entry.kind !== 'dir';
}
