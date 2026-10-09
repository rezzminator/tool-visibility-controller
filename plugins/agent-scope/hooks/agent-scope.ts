import type { EngineInterface, On, Register } from 'claude-code';
import {
  ancestorDirs,
  buildRules,
  denyText,
  filterListing,
  hiddenFrom,
  isAgentFile,
  MAIN,
  readDefinition,
  type Rule,
  type Rules,
} from '../src/scope.ts';

// Thin adapter: every decision lives in src/scope.ts. A failure is logged with
// its context, and the listing or the spawn goes on as it was.

/** The attachment that carries the agent listing to every loop. */
const LISTING = 'agent_listing_delta';

type Cache = { rules?: Promise<Rules> };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentsDir(dir: string): string {
  return `${dir === '/' ? '' : dir}/.claude/agents`;
}

// One tier's rules: every definition in `dir`. An unreadable or malformed file is
// logged and stays in the tier unscoped, so it still overrides a lower tier.
async function readTier($: EngineInterface, dir: string): Promise<Rule[]> {
  if (!(await $.fs.exists(dir))) return [];
  let entries: Array<{ name: string; kind: string }>;
  try {
    entries = await $.fs.list(dir);
  } catch (error) {
    $.ui.log(`agent-scope: listing ${dir} failed: ${message(error)}; its agents stay unscoped`);
    return [];
  }
  const rules: Rule[] = [];
  for (const entry of entries) {
    if (!isAgentFile(entry)) continue;
    const path = `${dir}/${entry.name}`;
    let text: string;
    try {
      text = await $.fs.read(path);
    } catch (error) {
      $.ui.log(`agent-scope: reading ${path} failed: ${message(error)}; ${entry.name.replace(/\.md$/, '')} is unscoped`);
      rules.push({ name: entry.name.replace(/\.md$/, ''), parents: null });
      continue;
    }
    const definition = readDefinition(text, entry.name);
    const availableTo = definition.availableTo;
    if (availableTo.kind === 'bad') {
      $.ui.log(`agent-scope: ${path}: available-to is malformed (${availableTo.reason}); ${definition.name} is unscoped`);
    }
    rules.push({ name: definition.name, parents: availableTo.kind === 'ok' ? availableTo.parents : null });
  }
  return rules;
}

// The user tier ($CLAUDE_CONFIG_DIR/agents, else ~/.claude/agents), then each
// project tier from the filesystem root down to the session root: the nearest
// definition of a name wins, as in Claude Code.
async function loadRules($: EngineInterface): Promise<Rules> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR');
  const home = await $.env.get('HOME');
  const tiers: Rule[][] = [];
  if (config !== undefined && config !== '') tiers.push(await readTier($, `${config}/agents`));
  else if (home !== undefined && home !== '') tiers.push(await readTier($, `${home}/.claude/agents`));
  else $.ui.log('agent-scope: neither CLAUDE_CONFIG_DIR nor HOME is set; user agents are not read');
  for (const dir of ancestorDirs(await $.session.root())) tiers.push(await readTier($, agentsDir(dir)));
  return buildRules(tiers);
}

// Read once per session; a load that failed is retried at the next use.
async function rulesOf($: EngineInterface, cache: Cache): Promise<Rules> {
  cache.rules ??= loadRules($);
  try {
    return await cache.rules;
  } catch (error) {
    cache.rules = undefined;
    throw error;
  }
}

// The agent type a loop runs as: MAIN for the main chat, else its row in the
// session's agent list; undefined when no row names the id.
async function loopType($: EngineInterface, agentId: string | undefined): Promise<string | undefined> {
  if (agentId === undefined) return MAIN;
  return (await $.agent.list()).find((agent) => agent.id === agentId)?.type;
}

async function filtered($: EngineInterface, cache: Cache, text: string, agentId: string | undefined): Promise<string | null> {
  try {
    const rules = await rulesOf($, cache);
    if (![...rules.values()].some((parents) => parents !== null)) return text;
    const caller = await loopType($, agentId);
    if (caller === undefined) {
      $.ui.log(`agent-scope: loop ${String(agentId)} resolves to no agent type; its agent listing is left whole`);
      return text;
    }
    return filterListing(text, hiddenFrom(rules, caller));
  } catch (error) {
    $.ui.log(`agent-scope: filtering the agent listing of loop ${agentId ?? MAIN} failed: ${message(error)}; it is left whole`);
    return text;
  }
}

async function refusal($: EngineInterface, cache: Cache, agentType: string, parentAgentId: string | undefined): Promise<string | undefined> {
  try {
    const parents = (await rulesOf($, cache)).get(agentType);
    if (parents == null) return undefined;
    const caller = await loopType($, parentAgentId);
    if (caller === undefined) {
      $.ui.log(`agent-scope: spawning ${agentType} from loop ${String(parentAgentId)}, which resolves to no agent type; the spawn goes through`);
      return undefined;
    }
    return parents.includes(caller) ? undefined : denyText(agentType, parents, caller);
  } catch (error) {
    $.ui.log(`agent-scope: checking the spawn of ${agentType} from loop ${parentAgentId ?? MAIN} failed: ${message(error)}; the spawn goes through`);
    return undefined;
  }
}

export const register: Register = (on: On) => {
  const cache: Cache = {};

  on('session.start', async ($, e, next) => {
    cache.rules = undefined;
    return next(e);
  });

  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e);
    if (e.type !== LISTING || result.text === null) return result;
    const text = await filtered($, cache, result.text, e.agentId);
    return text === result.text ? result : { ...result, text };
  });

  // A hook that throws or overruns its budget lets the spawn through.
  on('agent.spawn', async ($, e, next) => {
    const deny = await refusal($, cache, e.subagentType, e.parentAgentId);
    return deny === undefined ? next(e) : { deny };
  }).catch(($, e, next) => next(e));
};
