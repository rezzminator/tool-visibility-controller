// Who may see and invoke what, pure: name matching, the rules from definitions
// and scope files, the verdict with the rule that gave it, and the refusal text.

import { SETS, VISIBLE_TO, type Filter, type SetName, type Visibility } from './visibility.ts';

/** The loop name of the main chat, in rules and as a caller. */
export const MAIN = 'main';

/** The scope file's name, in the user config directory and in each project `.claude/`. */
export const SCOPE_FILE = 'tool-visibility-controller.json';

/** One rule: its filter, the block that states it, and the file it is in. */
export type Rule = { block: string; path: string; filter: Filter };

type ItemRule = { pattern: string; exact: boolean; rule: Rule };

/** Every rule in force: per set, the item rules (who may see an item) and, per loop, its viewer rules (what it sees). */
export type Policy = { items: Record<SetName, ItemRule[]>; loops: Map<string, Partial<Record<SetName, Rule[]>>> };

/** Allowed, or refused by one rule on the item's side (`visible-to`) or the loop's side (a set block). */
export type Verdict = { allowed: true } | { allowed: false; side: 'item' | 'viewer'; rule: Rule };

/** A scope file as read: viewer blocks per loop, and a `visible-to` per item pattern. */
export type ScopeFile = { loops: Record<string, Partial<Record<SetName, Filter>>>; items: Record<SetName, Record<string, Filter>> };

/** Scope files merged key by key, the nearest file's key winning. */
export type Merged = { loops: Map<string, Map<SetName, Rule>>; items: Map<SetName, Map<string, Rule>> };

/** A definition this plugin reads: an agent, or a skill or command, with its `visibility`. */
export type Owned = { set: 'agents' | 'skills'; name: string; path: string; visibility: Visibility };

const compiled = new Map<string, RegExp>();

/** Whether `value` matches `pattern`, exactly or with `*` standing for any run of characters. */
export function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  let re = compiled.get(pattern);
  if (re === undefined) {
    re = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    compiled.set(pattern, re);
  }
  return re.test(value);
}

/** The server of an MCP tool name `mcp__<server>__<tool>`; undefined for any other tool. */
export function mcpServer(name: string): string | undefined {
  return /^mcp__(.+?)__(.+)$/.exec(name)?.[1];
}

/** A configured server name as Claude Code writes it into tool names: every other character becomes `_`. */
export function normalizeServer(name: string): string {
  return name.replace(/[^A-Za-z0-9_*-]/g, '_');
}

/**
 * Whether an item pattern matches an item name of `set`. MCP: `server`,
 * `server/tool` or a full `mcp__server__tool`, `*` anywhere. Skills: the full
 * name (`plugin:name`) or the bare name after the plugin. Else the name.
 */
export function itemMatches(set: SetName, pattern: string, name: string): boolean {
  if (set === 'mcp') {
    if (pattern.startsWith('mcp__')) return globMatch(pattern, name);
    if (mcpServer(name) === undefined) return false;
    const slash = pattern.indexOf('/');
    const server = normalizeServer(slash < 0 ? pattern : pattern.slice(0, slash));
    // A server name may itself hold `__`: try every split of server and tool.
    for (let at = name.indexOf('__', 5); at > 5 && at + 2 < name.length; at = name.indexOf('__', at + 1)) {
      if (globMatch(server, name.slice(5, at)) && (slash < 0 || globMatch(pattern.slice(slash + 1), name.slice(at + 2)))) return true;
    }
    return false;
  }
  if (globMatch(pattern, name)) return true;
  return set === 'skills' && name.includes(':') && globMatch(pattern, name.slice(name.lastIndexOf(':') + 1));
}

function admits(filter: Filter, matches: (pattern: string) => boolean): boolean {
  return (filter.include === undefined || filter.include.some(matches)) && !(filter.exclude ?? []).some(matches);
}

/** Whether `loop` may see and invoke `item` of `set`; refused, the rule that refused it. */
export function decide(policy: Policy, set: SetName, loop: string, item: string): Verdict {
  for (const { pattern, exact, rule } of policy.items[set]) {
    const applies = exact ? pattern === item : itemMatches(set, pattern, item);
    if (applies && !admits(rule.filter, (p) => globMatch(p, loop))) return { allowed: false, side: 'item', rule };
  }
  for (const rule of policy.loops.get(loop)?.[set] ?? []) {
    if (!admits(rule.filter, (p) => itemMatches(set, p, item))) return { allowed: false, side: 'viewer', rule };
  }
  return { allowed: true };
}

/** No rule at all: nothing to filter or refuse. */
export function isEmpty(policy: Policy): boolean {
  return SETS.every((set) => policy.items[set].length === 0) && policy.loops.size === 0;
}

/** Whether any rule speaks about `set`. */
export function hasRules(policy: Policy, set: SetName): boolean {
  return policy.items[set].length > 0 || [...policy.loops.values()].some((blocks) => (blocks[set]?.length ?? 0) > 0);
}

const NOUN: Record<SetName, string> = { agents: 'Agent type', skills: 'Skill', mcp: 'MCP tool', tools: 'Tool' };
const INSTEAD: Record<SetName, string> = {
  agents: 'choose another agent type',
  skills: 'do the task without this skill',
  mcp: 'use another tool',
  tools: 'use another tool',
};

function who(loop: string): string {
  return loop === MAIN ? 'the main chat' : loop;
}

function joined(names: readonly string[], word: string): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} ${word} ${names.at(-1)}`;
}

/** The refusal the model reads: the item, the caller, the rule with its file, and what to do instead. */
export function denyText(set: SetName, item: string, loop: string, verdict: Verdict): string {
  if (verdict.allowed) return '';
  const { rule, side } = verdict;
  const caller = loop === MAIN ? 'the main chat' : `a ${loop} agent`;
  const matches = side === 'item' ? (p: string) => globMatch(p, loop) : (p: string) => itemMatches(set, p, item);
  const include = rule.filter.include;
  const why =
    include !== undefined && !include.some(matches)
      ? include.length === 0
        ? 'admits nothing'
        : `admits only ${joined(include, 'and')}`
      : `excludes ${(rule.filter.exclude ?? []).find(matches) ?? item}`;
  const delegates = side === 'item' && include !== undefined ? include.filter((p) => !p.includes('*')).map(who) : [];
  const instead = delegates.length > 0 ? `Delegate the task to ${joined(delegates, 'or')}, or ${INSTEAD[set]}.` : `${INSTEAD[set][0]?.toUpperCase()}${INSTEAD[set].slice(1)}.`;
  return `${NOUN[set]} ${item} is not available to ${caller}: ${rule.block} in ${rule.path} ${why}. ${instead}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFilter(value: unknown, path: string, problems: string[]): Filter | undefined {
  if (!isObject(value)) {
    problems.push(`${path} is not an object of include and exclude`);
    return undefined;
  }
  const filter: { include?: string[]; exclude?: string[] } = {};
  for (const [key, list] of Object.entries(value)) {
    if (key !== 'include' && key !== 'exclude') {
      problems.push(`${path} has an unknown key ${JSON.stringify(key)}; use include or exclude`);
      return undefined;
    }
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.trim() === '')) {
      problems.push(`${path}.${key} is not a list of names`);
      return undefined;
    }
    filter[key] = list.map((item: string) => item.trim());
  }
  return filter;
}

function isSet(key: string): key is SetName {
  return (SETS as readonly string[]).includes(key);
}

/**
 * Reads a scope file's text. Invalid JSON reads as null; a malformed block is
 * named in `problems` and left out, the other blocks kept.
 */
export function readScopeFile(text: string): { scope: ScopeFile | null; problems: string[] } {
  const problems: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { scope: null, problems: [`it is not valid JSON (${error instanceof Error ? error.message : String(error)})`] };
  }
  if (!isObject(json)) return { scope: null, problems: ['its top level is not an object of loops and items'] };
  const scope: ScopeFile = { loops: {}, items: { agents: {}, skills: {}, mcp: {}, tools: {} } };
  for (const [key, value] of Object.entries(json)) {
    if (key === 'loops') {
      if (!isObject(value)) {
        problems.push('loops is not an object of loop names');
        continue;
      }
      for (const [loop, blocks] of Object.entries(value)) {
        if (!isObject(blocks)) {
          problems.push(`loops.${loop} is not an object of agents, skills, mcp and tools`);
          continue;
        }
        const read: Partial<Record<SetName, Filter>> = {};
        for (const [set, block] of Object.entries(blocks)) {
          if (!isSet(set)) {
            problems.push(`loops.${loop} has an unknown key ${JSON.stringify(set)}; use agents, skills, mcp or tools`);
            continue;
          }
          const filter = readFilter(block, `loops.${loop}.${set}`, problems);
          if (filter !== undefined) read[set] = filter;
        }
        if (Object.keys(read).length > 0) scope.loops[loop] = read;
      }
    } else if (key === 'items') {
      if (!isObject(value)) {
        problems.push('items is not an object of agents, skills, mcp and tools');
        continue;
      }
      for (const [set, patterns] of Object.entries(value)) {
        if (!isSet(set)) {
          problems.push(`items has an unknown key ${JSON.stringify(set)}; use agents, skills, mcp or tools`);
          continue;
        }
        if (!isObject(patterns)) {
          problems.push(`items.${set} is not an object of item patterns`);
          continue;
        }
        for (const [pattern, entry] of Object.entries(patterns)) {
          const path = `items.${set}.${pattern}`;
          if (!isObject(entry)) {
            problems.push(`${path} is not an object holding visible-to`);
            continue;
          }
          const unknown = Object.keys(entry).find((k) => k !== VISIBLE_TO);
          if (unknown !== undefined) {
            problems.push(`${path} has an unknown key ${JSON.stringify(unknown)}; use visible-to`);
            continue;
          }
          if (!(VISIBLE_TO in entry)) continue;
          const filter = readFilter(entry[VISIBLE_TO], `${path}.${VISIBLE_TO}`, problems);
          if (filter !== undefined) scope.items[set][pattern] = filter;
        }
      }
    } else {
      problems.push(`it has an unknown key ${JSON.stringify(key)}; use loops or items`);
    }
  }
  return { scope, problems };
}

/** Scope files given lowest precedence first (user, then project from the root down): a nearer file's key replaces a farther one's. */
export function mergeScopes(files: ReadonlyArray<{ path: string; scope: ScopeFile }>): Merged {
  const merged: Merged = { loops: new Map(), items: new Map() };
  for (const { path, scope } of files) {
    for (const [loop, blocks] of Object.entries(scope.loops)) {
      const target = merged.loops.get(loop) ?? new Map<SetName, Rule>();
      merged.loops.set(loop, target);
      for (const set of SETS) {
        const filter = blocks[set];
        if (filter !== undefined) target.set(set, { block: `loops.${loop}.${set}`, path, filter });
      }
    }
    for (const set of SETS) {
      const target = merged.items.get(set) ?? new Map<string, Rule>();
      merged.items.set(set, target);
      for (const [pattern, filter] of Object.entries(scope.items[set] ?? {})) {
        target.set(pattern, { block: `items.${set}.${pattern}.${VISIBLE_TO}`, path, filter });
      }
    }
  }
  return merged;
}

/**
 * Every rule in force: each definition's `visible-to` (exact name) and each
 * agent's own set blocks, then the merged scope files. All apply together.
 */
export function buildPolicy(owned: ReadonlyArray<Owned>, merged: Merged): Policy {
  const policy: Policy = { items: { agents: [], skills: [], mcp: [], tools: [] }, loops: new Map() };
  const viewer = (loop: string, set: SetName, rule: Rule) => {
    const blocks = policy.loops.get(loop) ?? {};
    (blocks[set] ??= []).push(rule);
    policy.loops.set(loop, blocks);
  };
  for (const { set, name, path, visibility } of owned) {
    if (visibility.visibleTo !== undefined) {
      policy.items[set].push({ pattern: name, exact: true, rule: { block: `visibility.${VISIBLE_TO}`, path, filter: visibility.visibleTo } });
    }
    if (set !== 'agents') continue;
    for (const viewed of SETS) {
      const filter = visibility.sets[viewed];
      if (filter !== undefined) viewer(name, viewed, { block: `visibility.${viewed}`, path, filter });
    }
  }
  for (const [set, patterns] of merged.items) for (const [pattern, rule] of patterns) policy.items[set].push({ pattern, exact: false, rule });
  for (const [loop, blocks] of merged.loops) for (const [set, rule] of blocks) viewer(loop, set, rule);
  return policy;
}

/**
 * The project directories of a session at `root`, farthest first: `root` and
 * each directory above it, stopping below `home` (the user tier, never a
 * project) as Claude Code does, else at the filesystem root.
 */
export function ancestorDirs(root: string, home?: string): string[] {
  const parts = root.split('/').filter((part) => part !== '');
  const dirs = ['/', ...parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];
  const stop = home === undefined ? -1 : dirs.indexOf(`/${home.split('/').filter((part) => part !== '').join('/')}`);
  return stop < 0 ? dirs : dirs.slice(stop + 1);
}
