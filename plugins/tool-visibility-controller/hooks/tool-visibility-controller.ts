import type { EngineInterface, On, Register } from 'claude-code';
import { levelRow, PLUGIN_LOG_HOLD_ROWS, pluginLogDir, PluginLogQueue, type PluginLogLevel } from '../src/plugin-log.ts';
import { BURST_WINDOW_MS, ScreenBurst } from '../src/screen-burst.ts';
import { AgentTypes } from '../src/agent-types.ts';
import { agentListFailedText, engineLoopText, hookFailureText, message, missingDefinition, skillUnnamedText, unresolvedLoopText } from '../src/failures.ts';
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
import { directoryLocation, enabledPlugins, installedRoot, listedRoot, type PluginRef } from '../src/plugin-roots.ts';
import { readDefinition, SETS, type SetName } from '../src/visibility.ts';

// Thin adapter: every decision lives in src/. A failure is logged with its
// context, and the listing, the call or the spawn goes on as it was.

/** The attachments that list what a loop can use. */
const LISTINGS = new Set(['agent_listing_delta', 'skill_listing', 'mcp_instructions_delta', 'deferred_tools_delta']);

/** How deep command subdirectories are read (`a:b:c`). */
const COMMAND_DEPTH = 3;
/** How many directory levels the check of a skipped command directory descends; past it the directory counts as unread. */
const PROBE_DEPTH = 8;

type Logger = { session?: string; warning?: string };
/** `carried`: a row a final step could not write, kept for the next one; its session is unknown. */
type Pending = { level: PluginLogLevel; event: string; msg: string; hook: string; detail?: Record<string, unknown>; at: number; carried?: boolean };
/** `lost` counts rows dropped past the hold before the logger took them; `clockFailing` keeps the clock warning to one row per streak. */
type LogState = { logger?: Promise<Logger>; work: Promise<void>; failing: boolean; clockFailing: boolean; pending: Pending[]; lost: number };
/** One queue for the module's life: rows a failed final flush kept go out with the next session's first write. */
type Cache = { policy?: Promise<Policy>; missing: Set<string>; types: AgentTypes; spawns: SpawnCalls; log: LogState; logDrain: Promise<void>; queue?: PluginLogQueue; burst: ScreenBurst; burstArmed: boolean };
type Entry = { name: string; kind: string; isLink?: boolean };
type Read = { name: string; owned: Owned | null };

const PLUGIN = 'tool-visibility-controller';

// The screen door for error lines and the log's own failing-streak line, never a warning, info or debug row;
// it never interferes with a policy result. Identical lines collapse: a burst shows its first line, then one count.
function showLines($: EngineInterface, lines: readonly string[]): void {
  for (const line of lines) {
    try { $.ui.log(line); } catch {
      // No other screen door exists when ui.log itself is unavailable.
    }
  }
}

function showOnScreen($: EngineInterface, cache: Cache, text: string): void {
  showLines($, cache.burst.offer(text.startsWith(`${PLUGIN}: `) ? text : `${PLUGIN}: ${text}`, Date.now()));
  if (cache.burstArmed || cache.burst.pending() === 0) return;
  cache.burstArmed = true;
  try {
    $.clock.after(BURST_WINDOW_MS, () => {
      cache.burstArmed = false;
      showLines($, cache.burst.drain());
    });
  } catch {
    // Without a timer the count still shows at the next repeat past the window or at session end.
    cache.burstArmed = false;
  }
}

async function loggerOf($: EngineInterface, cache: Cache, state: LogState): Promise<Logger> {
  state.logger ??= (async () => {
    const override = await $.env.get('PLUGIN_LOG_DIR');
    const home = await $.env.get('HOME');
    cache.queue ??= new PluginLogQueue(pluginLogDir(override, home, PLUGIN), PLUGIN);
    let session: string | undefined;
    let warning: string | undefined;
    try { session = await $.session.id(); } catch (error) {
      warning = `session id unavailable: ${message(error)}; session omitted`;
    }
    return { session, warning };
  })();
  try {
    return await state.logger;
  } catch (error) {
    // A rejected initialization can recover on the next event.
    state.logger = undefined;
    throw error;
  }
}

// Rows wait in state.pending until the logger exists, then in the queue until a write lands: a stalled
// worker rejects the `$` calls here, and a rejected step keeps what it had not yet handed over.
// Only the final step (session end or start) gives up what the logger never took, said once on screen.
async function drainLog($: EngineInterface, cache: Cache, state: LogState, final: boolean): Promise<void> {
  if (state.pending.length === 0 && state.lost === 0 && (!final || state.logger === undefined)) return;
  const logger = await loggerOf($, cache, state);
  const queue = cache.queue!;
  let clock: number | undefined;
  let clockError: string | undefined;
  try { clock = await $.clock.now(); } catch (error) { clockError = message(error); }
  const now = clock ?? Date.now();
  if (logger.warning !== undefined) {
    queue.add(levelRow({ plugin: PLUGIN, level: 'warning', event: 'log-session-unavailable', msg: logger.warning, where: 'hooks/tool-visibility-controller.ts#loggerOf' }, now));
    logger.warning = undefined;
  }
  if (clockError !== undefined && !state.clockFailing) {
    queue.add(levelRow({ plugin: PLUGIN, level: 'warning', event: 'log-clock-unavailable', msg: `engine clock unavailable: ${clockError}; rows carry local time`, where: 'hooks/tool-visibility-controller.ts#drainLog', session: logger.session }, now));
  }
  state.clockFailing = clockError !== undefined;
  if (state.lost > 0) {
    queue.add(levelRow({ plugin: PLUGIN, level: 'error', event: 'plugin-log-rows-dropped', msg: `${state.lost} unwritten ${state.lost === 1 ? 'row was' : 'rows were'} dropped past the ${PLUGIN_LOG_HOLD_ROWS}-row hold`, where: 'hooks/tool-visibility-controller.ts#plog', session: logger.session, detail: { rows: state.lost } }, now));
    state.lost = 0;
  }
  for (const item of state.pending.splice(0)) {
    queue.add(levelRow({ plugin: PLUGIN, level: item.level, event: item.event, msg: item.msg, where: `hooks/tool-visibility-controller.ts#${item.hook}`, session: item.carried ? undefined : logger.session, detail: item.detail }, item.carried ? item.at : clock ?? item.at));
  }
  const result = await queue.flush((argv) => $.process.run(argv, { timeoutMs: 5000 }));
  if (result.screen !== undefined) showOnScreen($, cache, result.screen);
  state.failing = false;
}

// A final step keeps what it could not write for the next one: a replaced state hands it to the live state.
function logStepFailed($: EngineInterface, cache: Cache, state: LogState, error: unknown, final: boolean): void {
  if (final) {
    for (const item of state.pending) item.carried = true;
    const live = cache.log;
    if (live !== state) {
      live.pending.unshift(...state.pending.splice(0));
      const over = Math.max(0, live.pending.length - PLUGIN_LOG_HOLD_ROWS);
      live.pending.splice(0, over);
      live.lost += state.lost + over;
      state.lost = 0;
    }
  }
  if (!state.failing) showOnScreen($, cache, `plugin log metadata: ${message(error)}; rows kept for retry`);
  state.failing = true;
}

function plog($: EngineInterface, cache: Cache, level: PluginLogLevel, event: string, msg: string, hook: string, detail?: Record<string, unknown>): void {
  if (level === 'error') showOnScreen($, cache, msg);
  const state = cache.log;
  state.pending.push({ level, event, msg, hook, detail, at: Date.now() });
  if (state.pending.length > PLUGIN_LOG_HOLD_ROWS) {
    state.pending.shift();
    state.lost += 1;
  }
  state.work = state.work.then(() => drainLog($, cache, state, false)).catch((error) => logStepFailed($, cache, state, error, false));
}

// The last write of a log state, at session end or when a new session replaces it.
function finishLog($: EngineInterface, cache: Cache, state: LogState): Promise<void> {
  state.work = state.work.then(() => drainLog($, cache, state, true)).catch((error) => logStepFailed($, cache, state, error, true));
  return state.work;
}

function newLog(): LogState {
  return { work: Promise.resolve(), failing: false, clockFailing: false, pending: [], lost: 0 };
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

// A missing definition is skipped; it must not mask a farther valid one.
// Other unreadable files still stand for their name with no rule, as before.
// `namespace` (`plugin:`) prefixes the name of a plugin's definition, as Claude Code names it.
async function readOwned($: EngineInterface, cache: Cache, path: string, set: 'agents' | 'skills', fallback: string, byPath: boolean, namespace = ''): Promise<Read | null> {
  let text: string;
  try {
    text = await $.fs.read(path);
  } catch (error) {
    if (missingDefinition(error)) {
      if (!cache.missing.has(path)) {
        cache.missing.add(path);
        plog($, cache, 'error', 'agent-def-missing', `tool-visibility-controller: reading ${path} failed: ${message(error)}; definition is skipped; other definitions are still read`, 'readOwned', { error: message(error), path });
      }
      return null;
    }
    plog($, cache, 'error', 'agent-def-unreadable', `tool-visibility-controller: reading ${path} failed: ${message(error)}; ${fallback} has no visibility rule`, 'readOwned', { error: message(error), path });
    return { name: `${namespace}${fallback}`, owned: null };
  }
  const definition = readDefinition(text, fallback);
  const name = `${namespace}${byPath ? fallback : definition.name}`;
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

async function readAgents($: EngineInterface, cache: Cache, dir: string, namespace = ''): Promise<Read[]> {
  const read: Read[] = [];
  for (const entry of await entriesOf($, cache, dir)) {
    if (!entry.name.endsWith('.md') || entry.kind === 'dir') continue;
    const definition = await readOwned($, cache, `${dir}/${entry.name}`, 'agents', entry.name.slice(0, -3), false, namespace);
    if (definition !== null) read.push(definition);
  }
  return read;
}

// A plugin's skill is named by its directory (`plugin:dir`); a user or project skill by its frontmatter name.
async function readSkills($: EngineInterface, cache: Cache, dir: string, namespace = ''): Promise<Read[]> {
  const read: Read[] = [];
  for (const entry of await entriesOf($, cache, dir)) {
    if (entry.kind === 'file') continue;
    const path = `${dir}/${entry.name}/SKILL.md`;
    if (await $.fs.exists(path)) {
      const definition = await readOwned($, cache, path, 'skills', entry.name, namespace !== '', namespace);
      if (definition !== null) read.push(definition);
    }
  }
  return read;
}

// Commands by file, a subdirectory's named `dir:name` as Claude Code lists them.
async function readCommands($: EngineInterface, cache: Cache, dir: string, prefix: string, depth: number): Promise<Read[]> {
  const read: Read[] = [];
  for (const entry of await entriesOf($, cache, dir)) {
    if (entry.name.endsWith('.md') && entry.kind !== 'dir') {
      const definition = await readOwned($, cache, `${dir}/${entry.name}`, 'skills', `${prefix}${entry.name.slice(0, -3)}`, true);
      if (definition !== null) read.push(definition);
    } else if (entry.kind === 'dir' || entry.isLink === true) {
      if (depth < COMMAND_DEPTH) read.push(...(await readCommands($, cache, `${dir}/${entry.name}`, `${prefix}${entry.name}:`, depth + 1)));
      else await reportSkippedCommands($, cache, `${dir}/${entry.name}`);
    }
  }
  return read;
}

// Whether a directory past the read depth holds a command file (the `.md` test readCommands applies), looking
// at most PROBE_DEPTH levels down; `error` names why the answer is a guess: a directory that would not list, or
// directories left unlooked at, both count as a loss.
async function holdsCommand($: EngineInterface, dir: string, left: number): Promise<{ holds: boolean; error?: string }> {
  if (!(await $.fs.exists(dir))) return { holds: false };
  let entries: Entry[];
  try {
    entries = await $.fs.list(dir);
  } catch (error) {
    return { holds: true, error: `${dir}: ${message(error)}` };
  }
  if (entries.some((entry) => entry.name.endsWith('.md') && entry.kind !== 'dir')) return { holds: true };
  const subs = entries.filter((entry) => entry.kind === 'dir' || entry.isLink === true);
  if (subs.length > 0 && left === 0) return { holds: true, error: `${dir}: holds directories more than ${PROBE_DEPTH} levels down, not looked at` };
  for (const sub of subs) {
    const found = await holdsCommand($, `${dir}/${sub.name}`, left - 1);
    if (found.holds) return found;
  }
  return { holds: false };
}

/** A command directory past the read depth is an error only when it holds a command file or could not be checked. */
async function reportSkippedCommands($: EngineInterface, cache: Cache, path: string): Promise<void> {
  const { holds, error } = await holdsCommand($, path, PROBE_DEPTH);
  if (holds) plog($, cache, 'error', 'command-dir-skipped', `tool-visibility-controller: ${path} is deeper than ${COMMAND_DEPTH} command directories and is not read; a visibility rule in its commands is not enforced`, 'readCommands', { path, depth: COMMAND_DEPTH, ...(error === undefined ? {} : { error }) });
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

// A plugin record that exists but could not be read, parsed or understood: "could not look", never "found nothing".
const UNREADABLE = Symbol('unreadable');

// The one door to the records Claude Code keeps about plugins. Absent file: undefined, silently ("not
// enabled" and "not installed" are answers). A file that exists but cannot be read or parsed is an error
// row with its path and reason, and UNREADABLE, distinct from every absence.
async function pluginRecord($: EngineInterface, cache: Cache, records: Map<string, unknown>, path: string): Promise<unknown> {
  if (records.has(path)) return records.get(path);
  let record: unknown;
  if (await $.fs.exists(path)) {
    try {
      record = JSON.parse(await $.fs.read(path));
    } catch (error) {
      record = UNREADABLE;
      plog($, cache, 'error', 'plugin-record-unreadable', `tool-visibility-controller: reading ${path} failed: ${message(error)}; plugin definitions that depend on it are not read`, 'pluginRecord', { error: message(error), path });
    }
  }
  records.set(path, record);
  return record;
}

// Every enabled plugin's root (plugin-agents spec C2): the user config dir's settings.json names the
// enabled `plugin@marketplace` ids; a directory marketplace's root is its install location joined with the
// source its marketplace.json lists, any other root comes from installed_plugins.json, as does a directory
// marketplace's plugin when a record says nothing of it. A record that could not be read gives that key no
// root (its error row says why): for a directory marketplace the installed cache copy is not what Claude Code
// runs. A plugin whose root no record gives is a warning row, never a silent miss.
async function pluginRoots($: EngineInterface, cache: Cache, config: string): Promise<Array<{ plugin: string; root: string }>> {
  const records = new Map<string, unknown>();
  const shapeless = new Set<string>();
  const shaped = async <T>(path: string, read: (record: unknown) => T): Promise<T | undefined | typeof UNREADABLE> => {
    const record = await pluginRecord($, cache, records, path);
    if (record === undefined) return undefined;
    if (record === UNREADABLE || shapeless.has(path)) return UNREADABLE;
    try {
      return read(record);
    } catch (error) {
      shapeless.add(path);
      plog($, cache, 'error', 'plugin-record-unreadable', `tool-visibility-controller: ${path} is not a plugin record: ${message(error)}; plugin definitions that depend on it are not read`, 'pluginRoots', { error: message(error), path });
      return UNREADABLE;
    }
  };
  const rootOf = async (ref: PluginRef): Promise<string | undefined | typeof UNREADABLE> => {
    const location = await shaped(`${config}/plugins/known_marketplaces.json`, (known) => directoryLocation(known, ref.marketplace));
    if (location === UNREADABLE) return UNREADABLE;
    if (location !== undefined) {
      const root = await shaped(`${location.replace(/\/+$/, '')}/.claude-plugin/marketplace.json`, (listing) => listedRoot(location, listing, ref.plugin));
      if (root !== undefined) return root;
    }
    return shaped(`${config}/plugins/installed_plugins.json`, (installed) => installedRoot(installed, ref));
  };
  const roots: Array<{ plugin: string; root: string }> = [];
  const enabled = await shaped(`${config}/settings.json`, enabledPlugins);
  for (const ref of enabled === undefined || enabled === UNREADABLE ? [] : enabled) {
    const root = await rootOf(ref);
    if (root === UNREADABLE) continue;
    if (root === undefined) plog($, cache, 'warning', 'plugin-root-unresolved', `tool-visibility-controller: plugin ${ref.id} is enabled but no record under ${config}/plugins gives its root; its agents, commands and skills are not read`, 'pluginRoots', { plugin: ref.id, config });
    else roots.push({ plugin: ref.plugin, root });
  }
  return roots;
}

// The plugin tier (each enabled plugin's agents, commands and skills as `plugin:name`), the user tier ($CLAUDE_CONFIG_DIR, else ~/.claude), then each project tier
// from below the home directory (else the filesystem root) down to the session
// root: the nearest definition of a name wins, and a nearer scope file's key
// replaces a farther one's.
async function loadPolicy($: EngineInterface, cache: Cache): Promise<Policy> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR');
  const home = await $.env.get('HOME');
  const tiers: string[] = [];
  const user = config !== undefined && config !== '' ? config : home !== undefined && home !== '' ? `${home}/.claude` : undefined;
  if (user !== undefined) tiers.push(user);
  else plog($, cache, 'error', 'user-tier-skipped', 'tool-visibility-controller: neither CLAUDE_CONFIG_DIR nor HOME is set; user definitions and scope file are not read', 'loadPolicy');
  for (const dir of ancestorDirs(await $.session.root(), home)) tiers.push(claudeDir(dir));
  const agents = new Map<string, Owned | null>();
  const skills = new Map<string, Owned | null>();
  const scopes: Array<{ path: string; scope: ScopeFile }> = [];
  if (user !== undefined) {
    for (const { plugin, root } of await pluginRoots($, cache, user)) {
      for (const { name, owned } of await readAgents($, cache, `${root}/agents`, `${plugin}:`)) agents.set(name, owned);
      for (const { name, owned } of await readCommands($, cache, `${root}/commands`, `${plugin}:`, 0)) skills.set(name, owned);
      for (const { name, owned } of await readSkills($, cache, `${root}/skills`, `${plugin}:`)) skills.set(name, owned);
    }
  }
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

// Read once until session.start or /reload-plugins; a failed load is retried at the next use.
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
async function loopType($: EngineInterface, cache: Cache, agentId: string | undefined, action: string): Promise<string | undefined> {
  if (agentId === undefined) return MAIN;
  const failures: unknown[] = [];
  const type = await cache.types.of(agentId, () => $.agent.list(), (error) => failures.push(error));
  // One row per loop: a list that keeps failing is not repeated at every listing and call.
  if (failures.length > 0 && cache.types.firstMiss(`list-failed:${agentId}`)) plog($, cache, 'error', 'agent-list-failed', agentListFailedText(agentId, action, message(failures[0]), type), 'loopType', { error: message(failures[0]), agentId, ...(type ? { type } : {}) });
  return type;
}

// A loop with no type is reported once, not at every listing and every call. One no agent list row or
// announcement ever named is the engine's own fork (compaction, memory: the API gives those ids no list row),
// which no rule governs: a debug row. A sub-agent the engine named without a type goes unenforced: an error.
function logUnresolved($: EngineInterface, cache: Cache, agentId: string | undefined, action: string): void {
  const id = String(agentId);
  const named = cache.types.named(id);
  // Latched per outcome: a loop first missed unnamed and named later (a SubagentStop announcement) still raises its error.
  if (!cache.types.firstMiss(named ? `named:${id}` : id)) return;
  if (named) plog($, cache, 'error', 'name-unresolved', unresolvedLoopText(id, action), 'logUnresolved', { agentId, action });
  else plog($, cache, 'debug', 'engine-loop-unchecked', engineLoopText(id, action), 'logUnresolved', { agentId, action });
}

function hider(policy: Policy, set: SetName, loop: string): (name: string) => boolean {
  return (name) => !decide(policy, set, loop, name).allowed;
}

async function rewritten($: EngineInterface, cache: Cache, type: string, text: string, agentId: string | undefined): Promise<string | null> {
  try {
    const policy = await policyOf($, cache);
    if (isEmpty(policy)) return text;
    const loop = await loopType($, cache, agentId, `rewriting ${type}`);
    if (loop === undefined) {
      logUnresolved($, cache, agentId, `rewriting ${type}`);
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
    const loop = await loopType($, cache, agentId, `checking ${what}`);
    if (loop === undefined) {
      logUnresolved($, cache, agentId, `checking ${what}`);
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
  const cache: Cache = { missing: new Set(), types: new AgentTypes(), spawns: new SpawnCalls(), log: newLog(), logDrain: Promise.resolve(), burst: new ScreenBurst(), burstArmed: false };

  on('session.start', async ($, e, next) => {
    cache.policy = undefined;
    cache.missing.clear();
    cache.logDrain = Promise.all([cache.logDrain, finishLog($, cache, cache.log)]).then(() => {});
    cache.log = newLog();
    return next(e);
  });

  // Unchanged modules get no session.start on reload. Invalidate after core finishes,
  // even if it fails: a partial reload may already have changed the definitions.
  on('command.run', { command: 'reload-plugins' }, async ($, e, next) => {
    try {
      return await next(e);
    } finally {
      cache.policy = undefined;
      cache.missing.clear();
    }
  });

  on('session.end', async ($, e, next) => {
    await Promise.all([cache.logDrain, finishLog($, cache, cache.log)]);
    showLines($, cache.burst.drain());
    return next(e);
  });

  // A sub-agent's start and stop name its type (a teammate's, its name, so the list wins); a workflow's agents are never in $.agent.list(), so this is their only source.
  on('classic.SubagentStart', async ($, e, next) => {
    cache.types.learn(e.agent_id, e.agent_type);
    return next(e);
  }).catch(($, e, next) => {
    plog($, cache, 'error', 'hook-threw', hookFailureText('classic.SubagentStart', next.error, `agent ${e.agent_id}, type ${e.agent_type}`), 'classic.SubagentStart', { kind: next.error.kind, error: next.error.message });
    return next(e);
  });

  on('classic.SubagentStop', async ($, e, next) => {
    cache.types.learn(e.agent_id, e.agent_type);
    return next(e);
  }).catch(($, e, next) => {
    plog($, cache, 'error', 'hook-threw', hookFailureText('classic.SubagentStop', next.error, `agent ${e.agent_id}, type ${e.agent_type}`), 'classic.SubagentStop', { kind: next.error.kind, error: next.error.message });
    return next(e);
  });

  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e);
    if (!LISTINGS.has(e.type) || result.text === null) return result;
    const text = await rewritten($, cache, e.type, result.text, e.agentId);
    return text === result.text ? result : { ...result, text };
  }).catch(($, e, next) => {
    plog($, cache, 'error', 'hook-threw', hookFailureText('prompt.attachment', next.error, `listing ${e.type}, loop ${e.agentId ?? MAIN}`), 'prompt.attachment', { kind: next.error.kind, error: next.error.message });
    return next(e);
  });

  // A hook that throws or overruns its budget lets the spawn through.
  // Only a fresh spawn is gated: a resume runs under the loop resuming it, not its parent (see src/spawns.ts).
  on('agent.spawn', async ($, e, next) => {
    if (e.workflow === undefined && !cache.spawns.claim(e.tool_use_id)) return next(e);
    const deny = await checkCall($, cache, [['agents', e.subagentType]], e.parentAgentId);
    if (deny !== undefined) plog($, cache, 'info', 'denied', deny, 'agent.spawn');
    return deny === undefined ? next(e) : { deny };
  }).catch(($, e, next) => {
    plog($, cache, 'error', 'hook-threw', hookFailureText('agent.spawn', next.error, `agent ${e.subagentType}, loop ${e.parentAgentId ?? MAIN}`), 'agent.spawn', { kind: next.error.kind, error: next.error.message });
    return next(e);
  });

  // A hook that throws or overruns its budget lets the call through.
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Agent') cache.spawns.note(e.tool_use_id);
    const skill = (e as { skill?: unknown }).skill;
    const targets = callTargets(e.tool, skill);
    if (e.tool === 'Skill' && targets.length === 1) plog($, cache, 'warning', 'skill-unnamed', skillUnnamedText(skill, e.agentId ?? MAIN), 'tool.call', { agentId: e.agentId });
    const deny = await checkCall($, cache, targets, e.agentId);
    if (deny !== undefined) plog($, cache, 'info', 'denied', deny, 'tool.call');
    return deny === undefined ? next(e) : { deny };
  }).catch(($, e, next) => {
    plog($, cache, 'error', 'hook-threw', hookFailureText('tool.call', next.error, `tool ${e.tool}, loop ${e.agentId ?? MAIN}`), 'tool.call', { kind: next.error.kind, error: next.error.message });
    return next(e);
  });
};
