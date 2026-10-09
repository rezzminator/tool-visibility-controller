import { describe as suite, expect, it } from 'vitest';
import { register } from '../plugins/agent-scope/hooks/agent-scope.ts';

// A stand-in engine: a file system of agent definitions, the session's agents,
// and the hooks the module registers, driven the way the engine drives them.
type Hook = (...args: any[]) => any;

const HOME = '/u';
const ROOT = '/work/proj';

const def = (name: string, extra = '') => `---\nname: ${name}\ndescription: ${name} agent\n${extra}---\nBody.\n`;

const LISTING = [
  'Available agent types for the Agent tool:',
  '- general-purpose: General-purpose agent. (Tools: *)',
  '- scope-child: Child. (Tools: Read)',
  '- scope-parent: Parent. (Tools: Agent, Read)',
  '',
  'When you launch multiple agents for independent work, send them in a single message.',
].join('\n');
const WITHOUT_CHILD = LISTING.replace('- scope-child: Child. (Tools: Read)\n', '');

function engine(files: Record<string, string>, options: { env?: Record<string, string>; failRead?: string; failList?: boolean } = {}) {
  const hooks = new Map<string, Hook>();
  const logs: string[] = [];
  const agents: Array<{ id: string; type: string; status: string; description: string }> = [];
  let lists = 0;
  const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
  const $ = {
    env: { get: async (name: string) => (options.env ?? { HOME })[name] },
    session: { root: async () => ROOT },
    fs: {
      exists: async (path: string) => Object.keys(files).some((f) => dirOf(f) === path),
      list: async (path: string) => {
        lists += 1;
        if (options.failList) throw new Error(`EACCES: permission denied, scandir '${path}'`);
        return Object.keys(files)
          .filter((f) => dirOf(f) === path)
          .map((f) => ({ name: f.slice(path.length + 1), kind: 'file', size: 1, isLink: false }));
      },
      read: async (path: string) => {
        if (path === options.failRead) throw new Error(`EACCES: permission denied, open '${path}'`);
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
    },
    agent: { list: async () => agents },
    ui: { log: (line: string) => logs.push(line) },
  };
  const catches = new Map<string, Hook>();
  (register as Hook)((name: string, fn: Hook) => (hooks.set(name, fn), { catch: (handler: Hook) => catches.set(name, handler) }), {});
  const call = (name: string, e: unknown, next: Hook) => hooks.get(name)!($, e, next);
  return {
    logs,
    agents,
    lists: () => lists,
    attach: (text: string, agentId?: string, type = 'agent_listing_delta') =>
      call('prompt.attachment', { type, text, origin: { kind: 'engine' }, agentId }, async (e: { text: string }) => ({ text: e.text })),
    spawn: (subagentType: string, parentAgentId?: string) =>
      call('agent.spawn', { subagentType, parentAgentId, prompt: 'p', description: 'd' }, async () => ({ model: 'm', agentId: 'new' })),
    startSession: () => call('session.start', {}, async () => ({})),
    spawnCatch: () => catches.get('agent.spawn')!($, { subagentType: 'scope-child' }, async () => ({ model: 'm', agentId: 'new' })),
  };
}

const SCOPED = {
  [`${ROOT}/.claude/agents/scope-child.md`]: def('scope-child', 'available-to: [scope-parent]\n'),
  [`${ROOT}/.claude/agents/scope-parent.md`]: def('scope-parent'),
};

suite('the listing filter', () => {
  it("hides a scoped agent from the main chat's listing", async () => {
    const run = engine(SCOPED);
    expect(await run.attach(LISTING)).toEqual({ text: WITHOUT_CHILD });
  });

  it("hides it from a sub-agent that is not a parent, resolved by its id's type", async () => {
    const run = engine(SCOPED);
    run.agents.push({ id: 'gp1', type: 'general-purpose', status: 'running', description: '' });
    expect(await run.attach(LISTING, 'gp1')).toEqual({ text: WITHOUT_CHILD });
  });

  it("keeps it in a parent's listing", async () => {
    const run = engine(SCOPED);
    run.agents.push({ id: 'par1', type: 'scope-parent', status: 'running', description: '' });
    expect(await run.attach(LISTING, 'par1')).toEqual({ text: LISTING });
  });

  it('leaves another attachment kind untouched', async () => {
    const run = engine(SCOPED);
    expect(await run.attach(LISTING, undefined, 'skill_listing')).toEqual({ text: LISTING });
    expect(run.lists()).toBe(0);
  });

  it('changes nothing when no definition carries the key', async () => {
    const run = engine({ [`${ROOT}/.claude/agents/scope-child.md`]: def('scope-child') });
    expect(await run.attach(LISTING)).toEqual({ text: LISTING });
    expect(run.logs).toEqual([]);
  });

  it('fails open, logged, when a sub-agent id resolves to no agent', async () => {
    const run = engine(SCOPED);
    expect(await run.attach(LISTING, 'ghost')).toEqual({ text: LISTING });
    expect(run.logs.join('\n')).toMatch(/ghost.*no agent type/);
  });
});

suite('the dispatch refusal', () => {
  it("refuses the main chat's by-name spawn, saying who may", async () => {
    const run = engine(SCOPED);
    const result = await run.spawn('scope-child');
    expect(result.deny).toContain('scope-child is available only to scope-parent');
    expect(result.deny).toContain('the main chat cannot dispatch it');
  });

  it("refuses a non-parent sub-agent's spawn", async () => {
    const run = engine(SCOPED);
    run.agents.push({ id: 'gp1', type: 'general-purpose', status: 'running', description: '' });
    expect((await run.spawn('scope-child', 'gp1')).deny).toContain('a general-purpose agent cannot dispatch it');
  });

  it("lets a parent's spawn through", async () => {
    const run = engine(SCOPED);
    run.agents.push({ id: 'par1', type: 'scope-parent', status: 'running', description: '' });
    expect(await run.spawn('scope-child', 'par1')).toEqual({ model: 'm', agentId: 'new' });
  });

  it('lets an unscoped type through', async () => {
    const run = engine(SCOPED);
    expect(await run.spawn('scope-parent')).toEqual({ model: 'm', agentId: 'new' });
  });

  it('lets the spawn through when the hook throws or overruns its budget', async () => {
    expect(await engine(SCOPED).spawnCatch()).toEqual({ model: 'm', agentId: 'new' });
  });

  it('fails open, logged, when the caller cannot be resolved', async () => {
    const run = engine(SCOPED);
    expect(await run.spawn('scope-child', 'ghost')).toEqual({ model: 'm', agentId: 'new' });
    expect(run.logs.join('\n')).toMatch(/ghost/);
  });
});

suite('definitions discovery', () => {
  it('reads the user tier from CLAUDE_CONFIG_DIR, else ~/.claude', async () => {
    const userKid = def('kid', 'available-to: [boss]\n');
    const viaConfig = engine({ '/cfg/agents/kid.md': userKid }, { env: { HOME, CLAUDE_CONFIG_DIR: '/cfg' } });
    expect((await viaConfig.spawn('kid')).deny).toContain('kid is available only to boss');
    const viaHome = engine({ [`${HOME}/.claude/agents/kid.md`]: userKid });
    expect((await viaHome.spawn('kid')).deny).toContain('kid is available only to boss');
  });

  it('reads project agents in the session root and its ancestors, nearest first in precedence', async () => {
    const run = engine({
      '/work/.claude/agents/kid.md': def('kid', 'available-to: [far]\n'),
      [`${ROOT}/.claude/agents/kid.md`]: def('kid', 'available-to: [near]\n'),
    });
    expect((await run.spawn('kid')).deny).toContain('available only to near');
  });

  it('a project definition overrides the user one, its absent key included', async () => {
    const run = engine({
      [`${HOME}/.claude/agents/kid.md`]: def('kid', 'available-to: [boss]\n'),
      [`${ROOT}/.claude/agents/kid.md`]: def('kid'),
    });
    expect(await run.spawn('kid')).toEqual({ model: 'm', agentId: 'new' });
  });

  it('logs a malformed available-to and treats the agent as unscoped', async () => {
    const run = engine({ [`${ROOT}/.claude/agents/kid.md`]: def('kid', 'available-to: boss\n') });
    expect(await run.spawn('kid')).toEqual({ model: 'm', agentId: 'new' });
    expect(run.logs.join('\n')).toMatch(/kid\.md.*available-to.*not a list.*unscoped/);
  });

  it('logs an unreadable definition and treats it as unscoped, overriding a lower tier', async () => {
    const path = `${ROOT}/.claude/agents/kid.md`;
    const run = engine({ [`${HOME}/.claude/agents/kid.md`]: def('kid', 'available-to: [boss]\n'), [path]: def('kid') }, { failRead: path });
    expect(await run.spawn('kid')).toEqual({ model: 'm', agentId: 'new' });
    expect(run.logs.join('\n')).toMatch(/kid\.md.*EACCES/);
  });

  it('logs an unlistable directory and goes on with the others', async () => {
    const run = engine(SCOPED, { failList: true });
    expect(await run.attach(LISTING)).toEqual({ text: LISTING });
    expect(run.logs.join('\n')).toMatch(/EACCES/);
  });

  it('reads the definitions once per session and again after a new session starts', async () => {
    const run = engine(SCOPED);
    await run.attach(LISTING);
    await run.spawn('scope-child');
    const once = run.lists();
    await run.attach(LISTING);
    expect(run.lists()).toBe(once);
    await run.startSession();
    await run.attach(LISTING);
    expect(run.lists()).toBe(once * 2);
  });
});
