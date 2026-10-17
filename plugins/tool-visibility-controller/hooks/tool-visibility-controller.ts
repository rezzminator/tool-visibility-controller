import type { EngineInterface, On, Register } from 'claude-code';
import { levelRow, pluginLogDir, PluginLogQueue, type Level } from '../src/plugin-log.ts';
import { AgentTypes } from '../src/agent-types.ts';
import { SpawnCalls } from '../src/spawns.ts';
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

type Logger = { queue: PluginLogQueue; session?: string; warning?: string };
type LogState = { logger?: Promise<Logger>; work: Promise<void>; failing: boolean };
type Cache = { policy?: Promise<Policy>; types: AgentTypes; spawns: SpawnCalls; log: LogState; logDrain: Promise<void> };
type Entry = { name: string; kind: string; isLink?: boolean };
type Read = { name: string; owned: Owned | null };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PLUGIN = 'tool-visibility-controller';

// The logger's last-resort screen door never interferes with a policy result.
function logFallback($: EngineInterface, text: string): void {
  try { $.ui.log(text.startsWith(`${PLUGIN}: `) ? text : `${PLUGIN}: ${text}`); } catch {
    // No other screen door exists when ui.log itself is unavailable.
  }
}

async function loggerOf($: EngineInterface, state: LogState): Promise<Logger> {
  state.logger ??= (async () => {
    const override = await $.env.get('PLUGIN_LOG_DIR');
    const home = await $.env.get('HOME');
    const dir = pluginLogDir(override, home, PLUGIN);
    let session: string | undefined;
    let warning: string | undefined;
    try { session = await $.session.id(); } catch (error) {
      warning = `session id unavailable: ${message(error)}; session omitted`;
    }
    return { queue: new PluginLogQueue(dir, PLUGIN, (text) => logFallback($, text)), session, warning };
  })();
  return state.logger;
}

function plog($: EngineInterface, cache: Cache, level: Level, event: string, msg: string, hook: string, detail?: Record<string, unknown>): void {
  if (level === 'error') logFallback($, msg);
  const state = cache.log;
  state.work = state.work.then(async () => {
    const now = await $.clock.now();
    const logger = await loggerOf($, state);
    if (logger.warning !== undefined) {
      logger.queue.add(levelRow({ plugin: PLUGIN, level: 'warning', event: 'log-session-unavailable', msg: logger.warning, where: 'hooks/tool-visibility-controller.ts#loggerOf' }, now));
      logger.warning = undefined;
    }
    logger.queue.add(levelRow({ plugin: PLUGIN, level, event, msg, where: `hooks/tool-visibility-controller.ts#${hook}`, session: logger.session, detail }, now));
    await logger.queue.flush((argv) => $.process.run(argv, { timeoutMs: 5000 }));
    state.failing = false;
  }).catch((error) => {
    if (!state.failing) logFallback($, `plugin log metadata: ${message(error)}; row dropped`);
    if (level !== 'error') logFallback($, msg);
    state.failing = true;
    // A rejected initialization can recover on the next event.
    state.logger = undefined;
  });
}

function claudeDir(dir: string): string {
  return `${dir === '/' ? '' : dir}/.claude`;
}

async function entriesOf($: EngineInterface, cache: Cache, dir: string): Promise<Entry[]> {
  if (!(await $.fs.exists(dir))) return [];
  try {
    return await $.fs.list(dir);
  } catch (error) {
    plog($, cache, 'error', 'agent-dir-unlisted', `tool-visibility-controller: listing ${dir} failed: ${message(error)}; the definitions in it are not read`, 'entriesOf', { error: message(error), path: dir });
    return [];
  }
}

// One definition file. Unreadable, it is logged and still stands for its name
// with no rule, so it overrides a farther definition as Claude Code's does.
async function readOwned($: EngineInterface, cache: Cache, path: string, set: 'agents' | 'skills', fallback: string, byPath: boolean): Promise<Read> {
  let text: string;
  try {
    text = await $.fs.read(path);
  } catch (error) {
    plog($, cache, 'error', 'agent-def-unreadable', `tool-visibility-controller: reading ${path} failed: ${message(error)}; ${fallback} has no visibility rule`, 'readOwned', { error: message(error), path });
    return { name: fallback, owned: null };
  }
  const definition = readDefinition(text, fallback);
  const name = byPath ? fallback : definition.name;
  for (const problem of definition.problems) plog($, cache, 'error', 'frontmatter-problem', `tool-visibility-controller: ${path}: ${problem}; that block is ignored`, 'readOwned', { error: problem, path });
  const visibility = definition.visibility;
  if (visibility === null) return { name, owned: null };
  if (set !== 'agents') {
    for (const viewed of SETS) {
      if (visibility.sets[viewed] !== undefined) {
        plog($, cache, 'error', 'frontmatter-problem', `tool-visibility-controller: ${path}: visibility.${viewed} applies only in agent files; it is ignored here`, 'readOwned', { path });
      }
    }
  }
  return { name, owned: { set, name, path, visibility } };
}

async function readAgents($: EngineInterface, cache: Cache, dir: string): Promise<Read[]> {
  const read: Read[] = [];
  for (const entry of await entriesOf($, cache, dir)) {
    if (!entry.name.endsWith('.md') || entry.kind === 'dir') continue;
    read.push(await readOwned($, cache, `${dir}/${entry.name}`, 'agents', entry.name.slice(0, -3), false));
  }
  return read;
}

async function readSkills($: EngineInterface, cache: Cache, dir: string): Promise<Read[]> {
  const read: Read[] = [];
  for (const entry of await entriesOf($, cache, dir)) {
    if (entry.kind === 'file') continue;
    const path = `${dir}/${entry.name}/SKILL.md`;
    if (await $.fs.exists(path)) read.push(await readOwned($, cache, path, 'skills', entry.name, false));
  }
  return read;
}

// Commands by file, a subdirectory's named `dir:name` as Claude Code lists them.
async function readCommands($: EngineInterface, cache: Cache, dir: string, prefix: string, depth: number): Promise<Read[]> {
  const read: Read[] = [];
  for (const entry of await entriesOf($, cache, dir)) {
    if (entry.name.endsWith('.md') && entry.kind !== 'dir') {
      read.push(await readOwned($, cache, `${dir}/${entry.name}`, 'skills', `${prefix}${entry.name.slice(0, -3)}`, true));
    } else if (depth < COMMAND_DEPTH && (entry.kind === 'dir' || entry.isLink === true)) {
      read.push(...(await readCommands($, cache, `${dir}/${entry.name}`, `${prefix}${entry.name}:`, depth + 1)));
    }
  }
  return read;
}

async function readScope($: EngineInterface, cache: Cache, path: string): Promise<ScopeFile | null> {
  if (!(await $.fs.exists(path))) return null;
  let text: string;
  try {
    text = await $.fs.read(path);
  } catch (error) {
    plog($, cache, 'error', 'scope-unreadable', `tool-visibility-controller: reading ${path} failed: ${message(error)}; the file is ignored`, 'readScope', { error: message(error), path });
    return null;
  }
  const { scope, problems } = readScopeFile(text);
  for (const problem of problems) plog($, cache, 'error', 'scope-problem', `tool-visibility-controller: ${path}: ${problem}; ${scope === null ? 'the file is ignored' : 'that block is ignored'}`, 'readScope', { error: problem, path });
  return scope;
}

// The user tier ($CLAUDE_CONFIG_DIR, else ~/.claude), then each project tier
// from below the home directory (else the filesystem root) down to the session
// root: the nearest definition of a name wins, and a nearer scope file's key
// replaces a farther one's.
async function loadPolicy($: EngineInterface, cache: Cache): Promise<Policy> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR');
  const home = await $.env.get('HOME');
  const tiers: string[] = [];
  if (config !== undefined && config !== '') tiers.push(config);
  else if (home !== undefined && home !== '') tiers.push(`${home}/.claude`);
  else plog($, cache, 'error', 'user-tier-skipped', 'tool-visibility-controller: neither CLAUDE_CONFIG_DIR nor HOME is set; user definitions and scope file are not read', 'loadPolicy');
  for (const dir of ancestorDirs(await $.session.root(), home)) tiers.push(claudeDir(dir));
  const agents = new Map<string, Owned | null>();
  const skills = new Map<string, Owned | null>();
  const scopes: Array<{ path: string; scope: ScopeFile }> = [];
  for (const tier of tiers) {
    for (const { name, owned } of await readAgents($, cache, `${tier}/agents`)) agents.set(name, owned);
    for (const { name, owned } of await readCommands($, cache, `${tier}/commands`, '', 0)) skills.set(name, owned);
    for (const { name, owned } of await readSkills($, cache, `${tier}/skills`)) skills.set(name, owned);
    const path = `${tier}/${SCOPE_FILE}`;
    const scope = await readScope($, cache, path);
    if (scope !== null) scopes.push({ path, scope });
  }
  const owned = [...agents.values(), ...skills.values()].filter((item): item is Owned => item !== null);
  return buildPolicy(owned, mergeScopes(scopes));
}

// Read once per session; a load that failed is retried at the next use.
async function policyOf($: EngineInterface, cache: Cache): Promise<Policy> {
  cache.policy ??= loadPolicy($, cache);
  try {
    return await cache.policy;
  } catch (error) {
    cache.policy = undefined;
    throw error;
  }
}

// The loop's name: MAIN for the main chat, else its agent type, found in the
// session's agent list or, for an id no row names, announced by SubagentStart
// or SubagentStop; undefined when neither names the id.
async function loopType($: EngineInterface, cache: Cache, agentId: string | undefined): Promise<string | undefined> {
  if (agentId === undefined) return MAIN;
  return cache.types.of(agentId, () => $.agent.list());
}

// A loop with no type is reported once, not at every listing and every call:
// the engine's own forks (compaction, memory) send a listing of each kind.
// Enforcement is skipped, so this is an error even for an engine-owned fork.
function logUnresolved($: EngineInterface, cache: Cache, agentId: string | undefined): void {
  if (!cache.types.firstMiss(String(agentId))) return;
  const msg = `tool-visibility-controller: loop ${String(agentId)} resolves to no agent type (no agent list names it and no SubagentStart announced it); its listings, spawns and tool calls are left whole`;
  plog($, cache, 'error', 'name-unresolved', msg, 'logUnresolved', { agentId });
}

function hider(policy: Policy, set: SetName, loop: string): (name: string) => boolean {
  return (name) => !decide(policy, set, loop, name).allowed;
}

async function rewritten($: EngineInterface, cache: Cache, type: string, text: string, agentId: string | undefined): Promise<string | null> {
  try {
    const policy = await policyOf($, cache);
    if (isEmpty(policy)) return text;
    const loop = await loopType($, cache, agentId);
    if (loop === undefined) {
      logUnresolved($, cache, agentId);
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
    plog($, cache, 'error', 'rewrite-failed', `tool-visibility-controller: rewriting the ${type} of loop ${agentId ?? MAIN} failed: ${message(error)}; it is left whole`, 'rewritten', { error: message(error) });
    return text;
  }
}

async function checkCall($: EngineInterface, cache: Cache, targets: ReadonlyArray<[SetName, string]>, agentId: string | undefined): Promise<string | undefined> {
  const what = targets.map(([, item]) => item).join(' / ');
  try {
    const policy = await policyOf($, cache);
    const relevant = targets.filter(([set]) => hasRules(policy, set));
    if (relevant.length === 0) return undefined;
    const loop = await loopType($, cache, agentId);
    if (loop === undefined) {
      logUnresolved($, cache, agentId);
      return undefined;
    }
    for (const [set, item] of relevant) {
      const verdict = decide(policy, set, loop, item);
      if (!verdict.allowed) return denyText(set, item, loop, verdict);
    }
    return undefined;
  } catch (error) {
    plog($, cache, 'error', 'check-failed', `tool-visibility-controller: checking ${what} from loop ${agentId ?? MAIN} failed: ${message(error)}; it goes through`, 'checkCall', { error: message(error) });
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
  const cache: Cache = { types: new AgentTypes(), spawns: new SpawnCalls(), log: { work: Promise.resolve(), failing: false }, logDrain: Promise.resolve() };

  on('session.start', async ($, e, next) => {
    cache.policy = undefined;
    cache.logDrain = Promise.all([cache.logDrain, cache.log.work]).then(() => {});
    cache.log = { work: Promise.resolve(), failing: false };
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    await Promise.all([cache.logDrain, cache.log.work]);
    return next(e);
  });

  // A sub-agent's start and stop name its type (a teammate's, its name, so the list wins); a workflow's agents are never in $.agent.list(), so this is their only source.
  on('classic.SubagentStart', async ($, e, next) => {
    cache.types.learn(e.agent_id, e.agent_type);
    return next(e);
  }).catch(($, e, next) => {
    plog($, cache, 'error', 'hook-threw', `classic.SubagentStart failed; proceeding unchecked`, 'classic.SubagentStart', { kind: next.error.kind, error: next.error.message });
    return next(e);
  });

  on('classic.SubagentStop', async ($, e, next) => {
    cache.types.learn(e.agent_id, e.agent_type);
    return next(e);
  }).catch(($, e, next) => {
    plog($, cache, 'error', 'hook-threw', `classic.SubagentStop failed; proceeding unchecked`, 'classic.SubagentStop', { kind: next.error.kind, error: next.error.message });
    return next(e);
  });

  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e);
    if (!LISTINGS.has(e.type) || result.text === null) return result;
    const text = await rewritten($, cache, e.type, result.text, e.agentId);
    return text === result.text ? result : { ...result, text };
  });

  // A hook that throws or overruns its budget lets the spawn through.
  // Only a fresh spawn is gated: a resume runs under the loop resuming it, not its parent (see src/spawns.ts).
  on('agent.spawn', async ($, e, next) => {
    if (e.workflow === undefined && !cache.spawns.claim(e.tool_use_id)) return next(e);
    const deny = await checkCall($, cache, [['agents', e.subagentType]], e.parentAgentId);
    if (deny !== undefined) plog($, cache, 'info', 'denied', deny, 'agent.spawn');
    return deny === undefined ? next(e) : { deny };
  }).catch(($, e, next) => {
    plog($, cache, 'error', 'hook-threw', `agent.spawn failed; proceeding unchecked`, 'agent.spawn', { kind: next.error.kind, error: next.error.message });
    return next(e);
  });

  // A hook that throws or overruns its budget lets the call through.
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Agent') cache.spawns.note(e.tool_use_id);
    const deny = await checkCall($, cache, callTargets(e.tool, (e as { skill?: unknown }).skill), e.agentId);
    if (deny !== undefined) plog($, cache, 'info', 'denied', deny, 'tool.call');
    return deny === undefined ? next(e) : { deny };
  }).catch(($, e, next) => {
    plog($, cache, 'error', 'hook-threw', `tool.call failed; proceeding unchecked`, 'tool.call', { kind: next.error.kind, error: next.error.message });
    return next(e);
  });
};
