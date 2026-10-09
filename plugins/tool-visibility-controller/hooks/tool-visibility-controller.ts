import type { EngineInterface, On, Register } from 'claude-code';
import { filterDeferredTools, filterEntries, filterMcpInstructions } from '../src/listings.ts';
import {
  ancestorDirs,
  buildPolicy,
  decide,
  denyText,
  hasRules,
  isEmpty,
  MAIN,
  mcpServer,
  mergeScopes,
  normalizeServer,
  readScopeFile,
  SCOPE_FILE,
  type Owned,
  type Policy,
  type ScopeFile,
} from '../src/policy.ts';
import { readDefinition, SETS, type SetName } from '../src/visibility.ts';

// Thin adapter: every decision lives in src/. A failure is logged with its
// context, and the listing, the call or the spawn goes on as it was.

/** The attachments that list what a loop can use. */
const LISTINGS = new Set(['agent_listing_delta', 'skill_listing', 'mcp_instructions_delta', 'deferred_tools_delta']);

/** How deep command subdirectories are read (`a:b:c`). */
const COMMAND_DEPTH = 3;

type Cache = { policy?: Promise<Policy> };
type Entry = { name: string; kind: string; isLink?: boolean };
type Read = { name: string; owned: Owned | null };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function claudeDir(dir: string): string {
  return `${dir === '/' ? '' : dir}/.claude`;
}

async function entriesOf($: EngineInterface, dir: string): Promise<Entry[]> {
  if (!(await $.fs.exists(dir))) return [];
  try {
    return await $.fs.list(dir);
  } catch (error) {
    $.ui.log(`tool-visibility-controller: listing ${dir} failed: ${message(error)}; the definitions in it are not read`);
    return [];
  }
}

// One definition file. Unreadable, it is logged and still stands for its name
// with no rule, so it overrides a farther definition as Claude Code's does.
async function readOwned($: EngineInterface, path: string, set: 'agents' | 'skills', fallback: string, byPath: boolean): Promise<Read> {
  let text: string;
  try {
    text = await $.fs.read(path);
  } catch (error) {
    $.ui.log(`tool-visibility-controller: reading ${path} failed: ${message(error)}; ${fallback} has no visibility rule`);
    return { name: fallback, owned: null };
  }
  const definition = readDefinition(text, fallback);
  const name = byPath ? fallback : definition.name;
  for (const problem of definition.problems) $.ui.log(`tool-visibility-controller: ${path}: ${problem}; that block is ignored`);
  const visibility = definition.visibility;
  if (visibility === null) return { name, owned: null };
  if (set !== 'agents') {
    for (const viewed of SETS) {
      if (visibility.sets[viewed] !== undefined) {
        $.ui.log(`tool-visibility-controller: ${path}: visibility.${viewed} applies only in agent files; it is ignored here`);
      }
    }
  }
  return { name, owned: { set, name, path, visibility } };
}

async function readAgents($: EngineInterface, dir: string): Promise<Read[]> {
  const read: Read[] = [];
  for (const entry of await entriesOf($, dir)) {
    if (!entry.name.endsWith('.md') || entry.kind === 'dir') continue;
    read.push(await readOwned($, `${dir}/${entry.name}`, 'agents', entry.name.slice(0, -3), false));
  }
  return read;
}

async function readSkills($: EngineInterface, dir: string): Promise<Read[]> {
  const read: Read[] = [];
  for (const entry of await entriesOf($, dir)) {
    if (entry.kind === 'file') continue;
    const path = `${dir}/${entry.name}/SKILL.md`;
    if (await $.fs.exists(path)) read.push(await readOwned($, path, 'skills', entry.name, false));
  }
  return read;
}

// Commands by file, a subdirectory's named `dir:name` as Claude Code lists them.
async function readCommands($: EngineInterface, dir: string, prefix: string, depth: number): Promise<Read[]> {
  const read: Read[] = [];
  for (const entry of await entriesOf($, dir)) {
    if (entry.name.endsWith('.md') && entry.kind !== 'dir') {
      read.push(await readOwned($, `${dir}/${entry.name}`, 'skills', `${prefix}${entry.name.slice(0, -3)}`, true));
    } else if (depth < COMMAND_DEPTH && (entry.kind === 'dir' || entry.isLink === true)) {
      read.push(...(await readCommands($, `${dir}/${entry.name}`, `${prefix}${entry.name}:`, depth + 1)));
    }
  }
  return read;
}

async function readScope($: EngineInterface, path: string): Promise<ScopeFile | null> {
  if (!(await $.fs.exists(path))) return null;
  let text: string;
  try {
    text = await $.fs.read(path);
  } catch (error) {
    $.ui.log(`tool-visibility-controller: reading ${path} failed: ${message(error)}; the file is ignored`);
    return null;
  }
  const { scope, problems } = readScopeFile(text);
  for (const problem of problems) $.ui.log(`tool-visibility-controller: ${path}: ${problem}; ${scope === null ? 'the file is ignored' : 'that block is ignored'}`);
  return scope;
}

// The user tier ($CLAUDE_CONFIG_DIR, else ~/.claude), then each project tier
// from below the home directory (else the filesystem root) down to the session
// root: the nearest definition of a name wins, and a nearer scope file's key
// replaces a farther one's.
async function loadPolicy($: EngineInterface): Promise<Policy> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR');
  const home = await $.env.get('HOME');
  const tiers: string[] = [];
  if (config !== undefined && config !== '') tiers.push(config);
  else if (home !== undefined && home !== '') tiers.push(`${home}/.claude`);
  else $.ui.log('tool-visibility-controller: neither CLAUDE_CONFIG_DIR nor HOME is set; user definitions and scope file are not read');
  for (const dir of ancestorDirs(await $.session.root(), home)) tiers.push(claudeDir(dir));
  const agents = new Map<string, Owned | null>();
  const skills = new Map<string, Owned | null>();
  const scopes: Array<{ path: string; scope: ScopeFile }> = [];
  for (const tier of tiers) {
    for (const { name, owned } of await readAgents($, `${tier}/agents`)) agents.set(name, owned);
    for (const { name, owned } of await readCommands($, `${tier}/commands`, '', 0)) skills.set(name, owned);
    for (const { name, owned } of await readSkills($, `${tier}/skills`)) skills.set(name, owned);
    const path = `${tier}/${SCOPE_FILE}`;
    const scope = await readScope($, path);
    if (scope !== null) scopes.push({ path, scope });
  }
  const owned = [...agents.values(), ...skills.values()].filter((item): item is Owned => item !== null);
  return buildPolicy(owned, mergeScopes(scopes));
}

// Read once per session; a load that failed is retried at the next use.
async function policyOf($: EngineInterface, cache: Cache): Promise<Policy> {
  cache.policy ??= loadPolicy($);
  try {
    return await cache.policy;
  } catch (error) {
    cache.policy = undefined;
    throw error;
  }
}

// The loop's name: MAIN for the main chat, else its agent type in the
// session's agent list; undefined when no row names the id.
async function loopType($: EngineInterface, agentId: string | undefined): Promise<string | undefined> {
  if (agentId === undefined) return MAIN;
  return (await $.agent.list()).find((agent) => agent.id === agentId)?.type;
}

function hider(policy: Policy, set: SetName, loop: string): (name: string) => boolean {
  return (name) => !decide(policy, set, loop, name).allowed;
}

async function rewritten($: EngineInterface, cache: Cache, type: string, text: string, agentId: string | undefined): Promise<string | null> {
  try {
    const policy = await policyOf($, cache);
    if (isEmpty(policy)) return text;
    const loop = await loopType($, agentId);
    if (loop === undefined) {
      $.ui.log(`tool-visibility-controller: loop ${String(agentId)} resolves to no agent type; its ${type} is left whole`);
      return text;
    }
    if (type === 'agent_listing_delta') return hasRules(policy, 'agents') ? filterEntries(text, hider(policy, 'agents', loop), 'agents') : text;
    if (type === 'skill_listing') return hasRules(policy, 'skills') ? filterEntries(text, hider(policy, 'skills', loop), 'skills') : text;
    if (type === 'deferred_tools_delta') {
      if (!hasRules(policy, 'mcp') && !hasRules(policy, 'tools')) return text;
      const mcp = hider(policy, 'mcp', loop);
      const tools = hider(policy, 'tools', loop);
      return filterDeferredTools(text, (tool) => (mcpServer(tool) === undefined ? tools(tool) : mcp(tool)));
    }
    if (!hasRules(policy, 'mcp')) return text;
    const names = (await $.tool.list()).map((tool) => tool.name);
    const mcp = hider(policy, 'mcp', loop);
    return filterMcpInstructions(text, (heading) => {
      const server = normalizeServer(heading);
      const own = names.filter((name) => name.startsWith(`mcp__${server}__`));
      return own.length > 0 && own.every(mcp);
    });
  } catch (error) {
    $.ui.log(`tool-visibility-controller: rewriting the ${type} of loop ${agentId ?? MAIN} failed: ${message(error)}; it is left whole`);
    return text;
  }
}

async function refusal($: EngineInterface, cache: Cache, targets: ReadonlyArray<[SetName, string]>, agentId: string | undefined): Promise<string | undefined> {
  const what = targets.map(([, item]) => item).join(' / ');
  try {
    const policy = await policyOf($, cache);
    const relevant = targets.filter(([set]) => hasRules(policy, set));
    if (relevant.length === 0) return undefined;
    const loop = await loopType($, agentId);
    if (loop === undefined) {
      $.ui.log(`tool-visibility-controller: ${what} from loop ${String(agentId)}, which resolves to no agent type, goes through`);
      return undefined;
    }
    for (const [set, item] of relevant) {
      const verdict = decide(policy, set, loop, item);
      if (!verdict.allowed) return denyText(set, item, loop, verdict);
    }
    return undefined;
  } catch (error) {
    $.ui.log(`tool-visibility-controller: checking ${what} from loop ${agentId ?? MAIN} failed: ${message(error)}; it goes through`);
    return undefined;
  }
}

/** What a tool call invokes: the tool itself, and for the Skill tool the skill or command it names. */
function callTargets(tool: string, skill: unknown): Array<[SetName, string]> {
  const targets: Array<[SetName, string]> = [[mcpServer(tool) === undefined ? 'tools' : 'mcp', tool]];
  if (tool === 'Skill' && typeof skill === 'string' && skill.trim() !== '') targets.push(['skills', skill.trim().replace(/^\//, '')]);
  return targets;
}

export const register: Register = (on: On) => {
  const cache: Cache = {};

  on('session.start', async ($, e, next) => {
    cache.policy = undefined;
    return next(e);
  });

  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e);
    if (!LISTINGS.has(e.type) || result.text === null) return result;
    const text = await rewritten($, cache, e.type, result.text, e.agentId);
    return text === result.text ? result : { ...result, text };
  });

  // A hook that throws or overruns its budget lets the spawn through.
  on('agent.spawn', async ($, e, next) => {
    const deny = await refusal($, cache, [['agents', e.subagentType]], e.parentAgentId);
    return deny === undefined ? next(e) : { deny };
  }).catch(($, e, next) => next(e));

  // A hook that throws or overruns its budget lets the call through.
  on('tool.call', async ($, e, next) => {
    const deny = await refusal($, cache, callTargets(e.tool, (e as { skill?: unknown }).skill), e.agentId);
    return deny === undefined ? next(e) : { deny };
  }).catch(($, e, next) => next(e));
};
