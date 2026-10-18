import { afterEach, describe as suite, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { register } from '../plugins/tool-visibility-controller/hooks/tool-visibility-controller.ts';

// A stand-in engine: a file system of definitions and scope files, the
// session's agents and tools, and the hooks the module registers, driven the
// way the engine drives them.
type Hook = (...args: any[]) => any;

const HOME = '/u';
const ROOT = '/work/proj';
const SCOPE = `${ROOT}/.claude/tool-visibility-controller.json`;

const md = (name: string, extra = '') => `---\nname: ${name}\ndescription: ${name} item\n${extra}---\nBody.\n`;

const AGENTS = [
  'Available agent types for the Agent tool:',
  '- Explore: Read-only search agent. (Tools: Read)',
  '- general-purpose: General-purpose agent. (Tools: *)',
  '- scope-child: Child. (Tools: Read)',
  '- scope-parent: Parent. (Tools: Agent, Read)',
  '',
  'When you launch multiple agents for independent work, send them in a single message.',
].join('\n');
const WITHOUT_CHILD = AGENTS.replace('- scope-child: Child. (Tools: Read)\n', '');

const SKILLS = ['The following skills are available for use with the Skill tool:', '', '- greet: Greets.', '- kit:cmd: A nested command.', '- other: Other.'].join('\n');
const MCP = ['# MCP Server Instructions', '', 'The following MCP servers have provided instructions:', '', '## harvester-professor', 'Read a web page → read.', '', '## chat-professor', 'Message a chat → call.', '', '## docs', 'Docs.'].join('\n');
const DEFERRED = ['The following deferred tools are now available via ToolSearch:', 'WebFetch', 'mcp__harvester-professor__search_web', 'mcp__docs__read'].join('\n');
const TOOLS = ['Bash', 'Read', 'WebFetch', 'mcp__harvester-professor__search_web', 'mcp__harvester-professor__read', 'mcp__chat-professor__ls', 'mcp__chat-professor__call', 'mcp__docs__read', 'mcp__my__srv__read'];
const RAN = { result: 'ran', text: 'ran' };

type Options = { env?: Record<string, string>; failRead?: string; failList?: boolean; root?: string; failRoot?: boolean; failSessionId?: boolean; failClock?: boolean; failEnv?: boolean; runProcess?: (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }> };

function engine(files: Record<string, string>, options: Options = {}) {
  const hooks = new Map<string, Hook>();
  const catches = new Map<string, Hook>();
  let spawns = 0;
  const logs: string[] = [];
  const debugs: string[] = [];
  const timers: Array<() => void> = [];
  const agents: Array<{ id: string; type: string; status: string; description: string }> = [];
  let lists = 0;
  const under = (path: string) => Object.keys(files).filter((f) => f.startsWith(`${path}/`));
  const $ = {
    env: { get: async (name: string) => { if (options.failEnv) throw new Error('env unreadable'); return (options.env ?? { HOME })[name]; } },
    session: { root: async () => { if (options.failRoot) throw new Error('policy root unreadable'); return options.root ?? ROOT; }, id: async () => { if (options.failSessionId) throw new Error('session id unreadable'); return '5f0c2a'; } },
    clock: { now: async () => { if (options.failClock) throw new Error('clock unreadable'); return 1791991231123; }, after: (_ms: number, fn: () => void) => { timers.push(fn); return { cancel: () => {} }; } },
    process: { run: async (argv: readonly string[], init?: { timeoutMs?: number }) => options.runProcess ? options.runProcess(argv, init) : { exitCode: 0, stdout: '', stderr: '' } },
    fs: {
      exists: async (path: string) => path in files || under(path).length > 0,
      list: async (path: string) => {
        lists += 1;
        if (options.failList) throw new Error(`EACCES: permission denied, scandir '${path}'`);
        const names = new Map<string, string>();
        for (const f of under(path)) {
          const rest = f.slice(path.length + 1);
          const [first] = rest.split('/');
          names.set(first!, rest.includes('/') ? 'dir' : 'file');
        }
        return [...names].map(([name, kind]) => ({ name, kind, size: 1, isLink: false }));
      },
      read: async (path: string) => {
        if (path === options.failRead) throw new Error(`EACCES: permission denied, open '${path}'`);
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
    },
    agent: { list: async () => agents },
    tool: { list: async () => TOOLS.map((name) => ({ name, description: '' })) },
    ui: { log: (line: string, opts?: { to?: string }) => (opts?.to === 'debug' ? debugs : logs).push(line) },
  };
  (register as Hook)((name: string, fn: Hook) => (hooks.set(name, fn), { catch: (handler: Hook) => catches.set(name, handler) }), {});
  const call = (name: string, e: unknown, next: Hook) => hooks.get(name)!($, e, next);
  return {
    logs,
    debugs,
    fireTimers: () => timers.splice(0).forEach((fn) => fn()),
    lists: () => lists,
    sub: (id: string, type: string) => agents.push({ id, type, status: 'running', description: '' }),
    attach: (type: string, text: string, agentId?: string) =>
      call('prompt.attachment', { type, text, origin: { kind: 'engine' }, agentId }, async (e: { text: string }) => ({ text: e.text })),
    // A fresh spawn is the Agent tool call's own spawn: its tool.call fires first, under the same tool_use_id.
    spawn: async (subagentType: string, parentAgentId?: string) => {
      const id = `spawn-${++spawns}`;
      await call('tool.call', { tool: 'Agent', tool_use_id: id, subagent_type: subagentType, agentId: parentAgentId }, async () => RAN);
      return call('agent.spawn', { subagentType, parentAgentId, tool_use_id: id, prompt: 'p', description: 'd' }, async () => ({ model: 'm', agentId: 'new' }));
    },
    // A wake resumes an agent outside any Agent tool call, under the waker's loop: absent from main.
    resume: (subagentType: string, tool_use_id = '') =>
      call('agent.spawn', { subagentType, tool_use_id, prompt: 'p', description: 'd' }, async () => ({ model: 'm', agentId: 'old' })),
    tool: (tool: string, input: Record<string, unknown> = {}, agentId?: string) =>
      call('tool.call', { tool, tool_use_id: 't1', ...input, agentId }, async () => RAN),
    startSession: () => call('session.start', {}, async () => ({})),
    endSession: () => hooks.has('session.end') ? call('session.end', {}, async () => ({})) : Promise.resolve({}),
    // The engine fires these whether or not the plugin hooks them.
    announce: async (event: 'classic.SubagentStart' | 'classic.SubagentStop', id: string, type: string) => {
      if (hooks.has(event)) await call(event, { agent_id: id, agent_type: type }, async () => ({}));
    },
    caught: (name: string, e: unknown, next: Hook) => catches.get(name)!($, e, Object.assign(next, { error: { kind: 'throw', message: 'forced hook failure', budget: 100 }, called: false })),
  };
}

const SCOPED = {
  [`${ROOT}/.claude/agents/scope-child.md`]: md('scope-child', 'visibility:\n  visible-to:\n    include: [scope-parent]\n'),
  [`${ROOT}/.claude/agents/scope-parent.md`]: md('scope-parent'),
};

suite('agents', () => {
  it("hides an agent from the main chat's listing and keeps it in its parent's", async () => {
    const run = engine(SCOPED);
    run.sub('par1', 'scope-parent');
    run.sub('gp1', 'general-purpose');
    expect(await run.attach('agent_listing_delta', AGENTS)).toEqual({ text: WITHOUT_CHILD });
    expect(await run.attach('agent_listing_delta', AGENTS, 'gp1')).toEqual({ text: WITHOUT_CHILD });
    expect(await run.attach('agent_listing_delta', AGENTS, 'par1')).toEqual({ text: AGENTS });
  });

  it('applies the policy to an agent only SubagentStart or SubagentStop names, as a workflow run or a resumed agent has', async () => {
    const run = engine(SCOPED);
    await run.announce('classic.SubagentStart', 'wf1', 'general-purpose');
    await run.announce('classic.SubagentStop', 'wf2', 'scope-parent');
    expect(await run.attach('agent_listing_delta', AGENTS, 'wf1')).toEqual({ text: WITHOUT_CHILD });
    expect((await run.spawn('scope-child', 'wf1')).deny).toContain('Agent type scope-child is not available to a general-purpose agent');
    expect(await run.spawn('scope-child', 'wf2')).toEqual({ model: 'm', agentId: 'new' });
    expect([...run.logs, ...run.debugs].filter((line) => /no agent type/.test(line))).toEqual([]);
  });

  it('refuses a spawn from a loop it is not visible to, naming the rule, and lets the parent through', async () => {
    const run = engine(SCOPED);
    run.sub('par1', 'scope-parent');
    const result = await run.spawn('scope-child');
    expect(result.deny).toContain('Agent type scope-child is not available to the main chat');
    expect(result.deny).toContain(`visibility.visible-to in ${ROOT}/.claude/agents/scope-child.md`);
    expect(await run.spawn('scope-child', 'par1')).toEqual({ model: 'm', agentId: 'new' });
    expect(await run.spawn('scope-parent')).toEqual({ model: 'm', agentId: 'new' });
  });

  it('lets a wake resume an agent the waking loop may not spawn, and still refuses its fresh spawn', async () => {
    const run = engine(SCOPED);
    run.sub('par1', 'scope-parent');
    expect(await run.spawn('scope-child', 'par1')).toEqual({ model: 'm', agentId: 'new' });
    // Its children finish and the engine wakes it under the main chat's loop, outside any Agent tool call.
    expect(await run.resume('scope-child')).toEqual({ model: 'm', agentId: 'old' });
    expect(await run.resume('scope-child', 'spawn-1')).toEqual({ model: 'm', agentId: 'old' });
    expect((await run.spawn('scope-child')).deny).toContain('Agent type scope-child is not available to the main chat');
  });

  it("applies an agent's own agents block to its listing and its spawns", async () => {
    const run = engine({ [`${ROOT}/.claude/agents/boss.md`]: md('boss', 'visibility:\n  agents:\n    include: [scope-*]\n    exclude: [scope-parent]\n') });
    run.sub('b1', 'boss');
    expect(await run.attach('agent_listing_delta', AGENTS, 'b1')).toEqual({
      text: ['Available agent types for the Agent tool:', '- scope-child: Child. (Tools: Read)', '', 'When you launch multiple agents for independent work, send them in a single message.'].join('\n'),
    });
    expect((await run.spawn('Explore', 'b1')).deny).toContain(`visibility.agents in ${ROOT}/.claude/agents/boss.md admits only scope-*`);
    expect((await run.spawn('scope-parent', 'b1')).deny).toContain('excludes scope-parent');
    expect(await run.spawn('scope-child', 'b1')).toEqual({ model: 'm', agentId: 'new' });
  });

  it('scope-file rules for main and a built-in agent', async () => {
    const run = engine({
      [SCOPE]: JSON.stringify({ loops: { main: { agents: { exclude: ['general-purpose'] } } }, items: { agents: { Explore: { 'visible-to': { exclude: ['main'] } } } } }),
    });
    run.sub('gp1', 'general-purpose');
    expect(await run.attach('agent_listing_delta', AGENTS)).toEqual({
      text: AGENTS.replace('- Explore: Read-only search agent. (Tools: Read)\n', '').replace('- general-purpose: General-purpose agent. (Tools: *)\n', ''),
    });
    expect(await run.attach('agent_listing_delta', AGENTS, 'gp1')).toEqual({ text: AGENTS });
    expect((await run.spawn('Explore')).deny).toContain(`items.agents.Explore.visible-to in ${SCOPE} excludes main`);
    expect(await run.spawn('Explore', 'gp1')).toEqual({ model: 'm', agentId: 'new' });
  });
});

suite('skills and commands', () => {
  const FILES = {
    [`${ROOT}/.claude/skills/greet/SKILL.md`]: md('greet', 'visibility:\n  visible-to:\n    include: [helper]\n'),
    [`${HOME}/.claude/commands/kit/cmd.md`]: '---\ndescription: nested\nvisibility:\n  visible-to:\n    exclude: [main]\n---\nBody.\n',
  };

  it('hides a skill and a nested command from loops their visible-to does not admit', async () => {
    const run = engine(FILES);
    run.sub('h1', 'helper');
    expect(await run.attach('skill_listing', SKILLS)).toEqual({ text: SKILLS.replace('- greet: Greets.\n', '').replace('- kit:cmd: A nested command.\n', '') });
    expect(await run.attach('skill_listing', SKILLS, 'h1')).toEqual({ text: SKILLS });
  });

  it('refuses the Skill tool for a skill the loop may not use, by name or with a leading slash', async () => {
    const run = engine(FILES);
    run.sub('h1', 'helper');
    expect((await run.tool('Skill', { skill: 'greet' })).deny).toContain('Skill greet is not available to the main chat');
    expect((await run.tool('Skill', { skill: '/kit:cmd' })).deny).toContain('Skill kit:cmd is not available');
    expect(await run.tool('Skill', { skill: 'greet' }, 'h1')).toEqual(RAN);
    expect(await run.tool('Skill', { skill: 'other' })).toEqual(RAN);
  });

  it("applies an agent's skills block, plugin skills by plugin:name", async () => {
    const run = engine({ [`${ROOT}/.claude/agents/helper.md`]: md('helper', 'visibility:\n  skills:\n    exclude: [kit:*]\n') });
    run.sub('h1', 'helper');
    expect(await run.attach('skill_listing', SKILLS, 'h1')).toEqual({ text: SKILLS.replace('- kit:cmd: A nested command.\n', '') });
    expect((await run.tool('Skill', { skill: 'kit:cmd' }, 'h1')).deny).toContain('excludes kit:*');
  });

  it('logs viewer blocks in a skill file as ignored', async () => {
    const run = engine({ [`${ROOT}/.claude/skills/greet/SKILL.md`]: md('greet', 'visibility:\n  tools:\n    exclude: [Bash]\n') });
    expect(await run.tool('Bash', {})).toEqual(RAN);
    expect(run.logs.join('\n')).toMatch(/SKILL\.md.*visibility\.tools.*only in agent files/);
  });
});

suite('MCP', () => {
  const FILES = {
    [SCOPE]: JSON.stringify({ loops: { main: { mcp: { exclude: ['harvester-professor/*'] } } } }),
    [`${ROOT}/.claude/agents/rr.md`]: md('rr', 'visibility:\n  mcp:\n    include: [harvester-professor/search_web]\n'),
  };

  it('refuses an MCP tool call by the loop rules and lets an allowed one through', async () => {
    const run = engine(FILES);
    run.sub('r1', 'rr');
    expect((await run.tool('mcp__harvester-professor__search_web', { query: 'x' })).deny).toContain(`loops.main.mcp in ${SCOPE} excludes harvester-professor/*`);
    expect(await run.tool('mcp__harvester-professor__search_web', { query: 'x' }, 'r1')).toEqual(RAN);
    expect((await run.tool('mcp__docs__read', {}, 'r1')).deny).toContain('admits only harvester-professor/search_web');
    expect(await run.tool('mcp__docs__read', {})).toEqual(RAN);
    expect(await run.tool('mcp__chat-professor__call', { target: 'scratch', message: 'hello' })).toEqual(RAN);
  });

  it("drops a server's instructions only for a loop that may use none of its tools", async () => {
    const run = engine(FILES);
    run.sub('r1', 'rr');
    expect(await run.attach('mcp_instructions_delta', MCP)).toEqual({ text: MCP.replace('## harvester-professor\nRead a web page → read.\n\n', '') });
    expect(await run.attach('mcp_instructions_delta', MCP, 'r1')).toEqual({ text: MCP.replace('\n\n## chat-professor\nMessage a chat → call.', '').replace('\n\n## docs\nDocs.', '') });
    const spaced = engine({ [SCOPE]: JSON.stringify({ loops: { main: { mcp: { exclude: ['my  srv'] } } } }) });
    expect(await spaced.attach('mcp_instructions_delta', `${MCP}\n\n## my  srv\nMine.`)).toEqual({ text: MCP });
    expect((await spaced.tool('mcp__my__srv__read', {})).deny).toContain('excludes my  srv');
  });

  it('hides MCP and built-in tools from the deferred list per loop', async () => {
    const run = engine({ ...FILES, [`${ROOT}/.claude/agents/rr.md`]: md('rr', 'visibility:\n  tools:\n    exclude: [WebFetch]\n') });
    run.sub('r1', 'rr');
    expect(await run.attach('deferred_tools_delta', DEFERRED)).toEqual({ text: DEFERRED.replace('mcp__harvester-professor__search_web\n', '') });
    expect(await run.attach('deferred_tools_delta', DEFERRED, 'r1')).toEqual({ text: DEFERRED.replace('WebFetch\n', '') });
  });
});

suite('built-in tools', () => {
  it("refuses a built-in tool by an agent's tools block and by a scope-file loop rule", async () => {
    const run = engine({
      [`${ROOT}/.claude/agents/rr.md`]: md('rr', 'visibility:\n  tools:\n    include: [Read, Web*]\n    exclude: [WebFetch]\n'),
      [SCOPE]: JSON.stringify({ loops: { Explore: { tools: { exclude: ['WebFetch'] } } } }),
    });
    run.sub('r1', 'rr');
    run.sub('e1', 'Explore');
    expect((await run.tool('Bash', { command: 'ls' }, 'r1')).deny).toContain('Tool Bash is not available to a rr agent');
    expect((await run.tool('WebFetch', {}, 'r1')).deny).toContain('excludes WebFetch');
    expect(await run.tool('WebSearch', {}, 'r1')).toEqual(RAN);
    expect((await run.tool('WebFetch', {}, 'e1')).deny).toContain(`loops.Explore.tools in ${SCOPE}`);
    expect(await run.tool('WebFetch', {})).toEqual(RAN);
  });
});

suite('discovery and failure', () => {
  it('changes nothing and logs nothing when no rule exists', async () => {
    const run = engine({ [`${ROOT}/.claude/agents/scope-child.md`]: md('scope-child') });
    expect(await run.attach('agent_listing_delta', AGENTS)).toEqual({ text: AGENTS });
    expect(await run.tool('Bash', {})).toEqual(RAN);
    expect(run.logs).toEqual([]);
  });

  it('leaves another attachment kind untouched without reading anything', async () => {
    const run = engine(SCOPED);
    expect(await run.attach('todo_reminder', AGENTS)).toEqual({ text: AGENTS });
    expect(run.lists()).toBe(0);
  });

  it('reads the user tier from CLAUDE_CONFIG_DIR, else ~/.claude, definitions and scope file alike', async () => {
    const kid = md('kid', 'visibility:\n  visible-to:\n    include: [boss]\n');
    const viaConfig = engine({ '/cfg/agents/kid.md': kid }, { env: { HOME, CLAUDE_CONFIG_DIR: '/cfg' } });
    expect((await viaConfig.spawn('kid')).deny).toContain('admits only boss');
    const viaHome = engine({ [`${HOME}/.claude/tool-visibility-controller.json`]: '{"loops": {"main": {"tools": {"exclude": ["Bash"]}}}}' });
    expect((await viaHome.tool('Bash', {})).deny).toContain(`loops.main.tools in ${HOME}/.claude/tool-visibility-controller.json`);
    const otherAccount = engine({ [`${HOME}/.claude/tool-visibility-controller.json`]: '{"loops": {"main": {"tools": {"exclude": ["Bash"]}}}}' }, { env: { HOME, CLAUDE_CONFIG_DIR: '/cfg' }, root: `${HOME}/proj` });
    expect(await otherAccount.tool('Bash', {})).toEqual(RAN);
  });

  it('the nearest definition of a name wins, its absent key included', async () => {
    const near = engine({
      '/work/.claude/agents/kid.md': md('kid', 'visibility:\n  visible-to:\n    include: [far]\n'),
      [`${ROOT}/.claude/agents/kid.md`]: md('kid', 'visibility:\n  visible-to:\n    include: [near]\n'),
    });
    expect((await near.spawn('kid')).deny).toContain('admits only near');
    const unscoped = engine({ [`${HOME}/.claude/agents/kid.md`]: md('kid', 'visibility:\n  visible-to:\n    include: [boss]\n'), [`${ROOT}/.claude/agents/kid.md`]: md('kid') });
    expect(await unscoped.spawn('kid')).toEqual({ model: 'm', agentId: 'new' });
  });

  it('a nearer scope file replaces a farther one key by key', async () => {
    const run = engine({
      [`${HOME}/.claude/tool-visibility-controller.json`]: '{"loops": {"main": {"tools": {"exclude": ["Bash"]}, "mcp": {"exclude": ["docs"]}}}}',
      [SCOPE]: '{"loops": {"main": {"tools": {"exclude": ["Read"]}}}}',
    });
    expect(await run.tool('Bash', {})).toEqual(RAN);
    expect((await run.tool('Read', {})).deny).toContain(SCOPE);
    expect((await run.tool('mcp__docs__read', {})).deny).toContain(`${HOME}/.claude/tool-visibility-controller.json`);
  });

  it('logs a malformed block with its file and ignores only that block', async () => {
    const run = engine({ [`${ROOT}/.claude/agents/kid.md`]: md('kid', 'visibility:\n  visible-to:\n    include: boss\n  tools:\n    exclude: [Bash]\n') });
    run.sub('k1', 'kid');
    expect(await run.spawn('kid')).toEqual({ model: 'm', agentId: 'new' });
    expect((await run.tool('Bash', {}, 'k1')).deny).toContain('Tool Bash');
    expect(run.logs.join('\n')).toMatch(/kid\.md.*visibility\.visible-to\.include.*not a list.*ignored/);
  });

  it('logs an invalid scope file and ignores it', async () => {
    const run = engine({ [SCOPE]: '{ "loops": ', ...SCOPED });
    expect((await run.spawn('scope-child')).deny).toBeDefined();
    expect(run.logs.join('\n')).toMatch(/tool-visibility-controller\.json.*not valid JSON.*ignored/);
  });

  it('logs an unreadable definition, which still overrides a lower tier', async () => {
    const path = `${ROOT}/.claude/agents/kid.md`;
    const run = engine({ [`${HOME}/.claude/agents/kid.md`]: md('kid', 'visibility:\n  visible-to:\n    include: [boss]\n'), [path]: md('kid') }, { failRead: path });
    expect(await run.spawn('kid')).toEqual({ model: 'm', agentId: 'new' });
    expect(run.logs.join('\n')).toMatch(/kid\.md.*EACCES/);
  });

  it('logs an unlistable directory and leaves the listing whole', async () => {
    const run = engine(SCOPED, { failList: true });
    expect(await run.attach('agent_listing_delta', AGENTS)).toEqual({ text: AGENTS });
    expect(run.logs.join('\n')).toMatch(/EACCES/);
  });

  it('fails open with a visible error when a loop id resolves to no agent', async () => {
    const run = engine({ ...SCOPED, [SCOPE]: '{"loops": {"main": {"tools": {"exclude": ["Bash"]}}}}' });
    expect(await run.attach('agent_listing_delta', AGENTS, 'ghost')).toEqual({ text: AGENTS });
    expect(await run.spawn('scope-child', 'ghost')).toEqual({ model: 'm', agentId: 'new' });
    expect(await run.tool('Bash', {}, 'ghost')).toEqual(RAN);
    expect(run.logs.join('\n')).toMatch(/ghost.*no agent type/);
  });

  it('shows an unresolved-loop error once, whatever its listings, spawns and calls', async () => {
    const run = engine({ ...SCOPED, [SCOPE]: '{"loops": {"main": {"tools": {"exclude": ["Bash"]}}}}' });
    for (const type of ['deferred_tools_delta', 'skill_listing', 'agent_listing_delta', 'mcp_instructions_delta']) await run.attach(type, AGENTS, 'fork1');
    await run.spawn('scope-child', 'fork1');
    await run.tool('Bash', {}, 'fork1');
    await run.tool('Bash', {}, 'fork1');
    await run.attach('agent_listing_delta', AGENTS, 'fork2');
    expect(run.logs.filter((line) => line.includes('fork1') && /no agent type/.test(line))).toHaveLength(1);
    expect(run.logs.filter((line) => line.includes('fork2') && /no agent type/.test(line))).toHaveLength(1);
  });

  it('lets the call and the spawn through when the hook throws or overruns its budget', async () => {
    const run = engine(SCOPED);
    expect(await run.caught('agent.spawn', { subagentType: 'scope-child' }, async () => ({ model: 'm', agentId: 'new' }))).toEqual({ model: 'm', agentId: 'new' });
    expect(await run.caught('tool.call', { tool: 'Bash' }, async () => RAN)).toEqual(RAN);
  });

  it('reads the definitions once per session and again after a new session starts', async () => {
    const run = engine(SCOPED);
    await run.attach('agent_listing_delta', AGENTS);
    await run.spawn('scope-child');
    const once = run.lists();
    await run.tool('Bash', {});
    expect(run.lists()).toBe(once);
    await run.startSession();
    await run.attach('agent_listing_delta', AGENTS);
    expect(run.lists()).toBe(once * 2);
  });
});

const logDirs: string[] = [];
afterEach(async () => { await Promise.all(logDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const logTemp = async () => { const dir = await mkdtemp(join(tmpdir(), 'visibility-logs-')); logDirs.push(dir); return dir; };
const processExec = promisify(execFile);
const realProcess: NonNullable<Options['runProcess']> = async (argv, init) => {
  expect(init?.timeoutMs).toBe(5000);
  try {
    return { exitCode: 0, ...await processExec(argv[0]!, argv.slice(1)) };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message };
  }
};
const logRows = async (dir: string, file: string) => {
  const text = await readFile(join(dir, `${file}.jsonl`), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return text.trim() === '' ? [] : text.trim().split('\n').map((row) => JSON.parse(row));
};

suite('plugin log adapter', () => {
  it.each(['PLUGIN_LOG_DIR', 'fallback'] as const)('writes enforcement errors and denial info under %s', async (source) => {
    const dir = await logTemp();
    const env: Record<string, string> = source === 'PLUGIN_LOG_DIR' ? { HOME: dir, PLUGIN_LOG_DIR: join(dir, 'logs') } : { HOME: dir };
    const logs = source === 'PLUGIN_LOG_DIR' ? join(dir, 'logs/tool-visibility-controller') : join(dir, '.local/state/tool-visibility-controller/logs');
    const opts: Options = { env, runProcess: realProcess, failRoot: true };
    const run = engine({ ...SCOPED, [SCOPE]: '{ "loops": ' }, opts);
    expect(await run.startSession()).toEqual({});
    expect(await run.tool('Bash', { command: 'SECRET TOOL BODY' })).toEqual(RAN);
    opts.failRoot = false;
    expect(await run.tool('Bash')).toEqual(RAN);
    expect(await run.attach('agent_listing_delta', AGENTS, 'ghost')).toEqual({ text: AGENTS });
    expect((await run.spawn('scope-child')).deny).toBeDefined();
    await run.endSession();
    expect(await logRows(logs, 'errors')).toEqual([expect.objectContaining({ ts: '2026-10-14T15:20:31.123Z', plugin: 'tool-visibility-controller', level: 'error', event: 'check-failed', where: 'hooks/tool-visibility-controller.ts#checkCall', session: '5f0c2a', detail: { error: 'policy root unreadable' } }), expect.objectContaining({ level: 'error', event: 'scope-problem' }), expect.objectContaining({ level: 'error', event: 'name-unresolved' })]);
    expect(await logRows(logs, 'warnings')).toEqual([]);
    expect(await logRows(logs, 'info')).toEqual([expect.objectContaining({ level: 'info', event: 'denied', session: '5f0c2a' })]);
    expect(JSON.stringify(await logRows(logs, 'errors'))).not.toContain('SECRET TOOL BODY');
    expect(run.logs.join('\n')).toContain('policy root unreadable; it goes through');
    expect(run.logs.join('\n')).toMatch(/not valid JSON \(.*\); the file is ignored/);
  });

  it.each<{ event: string; files: Record<string, string>; options: Options; where: string; level: string }>([
    { event: 'agent-dir-unlisted', files: SCOPED, options: { failList: true }, where: 'entriesOf', level: 'errors' },
    { event: 'agent-def-unreadable', files: SCOPED, options: { failRead: `${ROOT}/.claude/agents/scope-child.md` }, where: 'readOwned', level: 'errors' },
    { event: 'frontmatter-problem', files: { [`${ROOT}/.claude/agents/kid.md`]: md('kid', 'visibility:\n  tools:\n    include: Bash\n') }, options: {}, where: 'readOwned', level: 'errors' },
    { event: 'frontmatter-problem', files: { [`${ROOT}/.claude/skills/greet/SKILL.md`]: md('greet', 'visibility:\n  tools:\n    exclude: [Bash]\n') }, options: {}, where: 'readOwned', level: 'errors' },
    { event: 'scope-unreadable', files: { [SCOPE]: '{}' }, options: { failRead: SCOPE }, where: 'readScope', level: 'errors' },
    { event: 'scope-problem', files: { [SCOPE]: '{' }, options: {}, where: 'readScope', level: 'errors' },
    { event: 'user-tier-skipped', files: {}, options: { env: {} }, where: 'loadPolicy', level: 'errors' },
    { event: 'rewrite-failed', files: SCOPED, options: { failRoot: true }, where: 'rewritten', level: 'errors' },
  ])('records $event at $where without changing the listing', async ({ event, files, options, where, level }) => {
    const dir = await logTemp();
    const run = engine(files, { ...options, env: { ...('env' in options ? options.env : { HOME: dir }), PLUGIN_LOG_DIR: dir }, runProcess: realProcess });
    expect(await run.attach('agent_listing_delta', AGENTS)).toEqual({ text: AGENTS });
    await run.endSession();
    expect(await logRows(join(dir, 'tool-visibility-controller'), level)).toContainEqual(expect.objectContaining({ event, where: `hooks/tool-visibility-controller.ts#${where}` }));
  });

  it('records one unresolved name per loop and denial rows for both call and spawn', async () => {
    const dir = await logTemp();
    const run = engine({ ...SCOPED, [SCOPE]: '{"loops":{"main":{"tools":{"exclude":["Bash"]}}}}' }, { env: { HOME: dir, PLUGIN_LOG_DIR: dir }, runProcess: realProcess });
    await run.startSession();
    for (let i = 0; i < 2; i++) {
      expect(await run.attach('agent_listing_delta', AGENTS, 'ghost')).toEqual({ text: AGENTS });
      expect(await run.tool('Bash', {}, 'ghost')).toEqual(RAN);
    }
    expect((await run.tool('Bash')).deny).toContain('Tool Bash is not available');
    expect((await run.spawn('scope-child')).deny).toContain('Agent type scope-child is not available');
    await run.endSession();
    const info = await logRows(join(dir, 'tool-visibility-controller'), 'info');
    expect(info.map((row) => row.event)).toEqual(['denied', 'denied']);
    expect(await logRows(join(dir, 'tool-visibility-controller'), 'errors')).toEqual([expect.objectContaining({ level: 'error', event: 'name-unresolved' })]);
    expect(run.logs.filter((line) => /no agent type/.test(line))).toHaveLength(1);
    expect(run.logs.some((line) => /is not available/.test(line))).toBe(false);
    expect(info.filter((row) => row.event === 'denied').map((row) => row.where)).toEqual(['hooks/tool-visibility-controller.ts#tool.call', 'hooks/tool-visibility-controller.ts#agent.spawn']);
  });

  it.each(['classic.SubagentStart', 'classic.SubagentStop', 'agent.spawn', 'tool.call'])('logs hook-threw then continues %s', async (event) => {
    const dir = await logTemp();
    const run = engine({}, { env: { HOME: dir, PLUGIN_LOG_DIR: dir }, runProcess: realProcess });
    let called = 0;
    expect(await run.caught(event, {}, async () => { called++; return RAN; })).toEqual(RAN);
    expect(called).toBe(1);
    expect(run.logs.join('\n')).toContain(`${event} failed; proceeding unchecked`);
    await run.endSession();
    expect(await logRows(join(dir, 'tool-visibility-controller'), 'errors')).toEqual([expect.objectContaining({ event: 'hook-threw', where: `hooks/tool-visibility-controller.ts#${event}`, detail: { kind: 'throw', error: 'forced hook failure' } })]);
  });

  it('keeps work unchanged, names the directory once per failure streak and re-arms after success', async () => {
    const dir = await logTemp();
    let failed = true;
    const run = engine({ [SCOPE]: '{' }, { env: { HOME: dir, PLUGIN_LOG_DIR: dir }, runProcess: async (argv, init) => { if (failed) throw new Error('cannot start'); return realProcess(argv, init); } });
    await run.startSession();
    expect(await run.tool('Bash')).toEqual(RAN);
    await run.endSession();
    expect(run.logs.filter((line) => line.includes('plugin log '))).toHaveLength(1);
    expect(run.logs.find((line) => line.includes('plugin log '))).toContain(`${dir}/tool-visibility-controller`);
    expect(run.logs.find((line) => line.includes('plugin log '))).toContain('cannot start');
    failed = false;
    await run.caught('tool.call', {}, async () => RAN);
    await run.endSession();
    failed = true;
    await run.caught('agent.spawn', {}, async () => RAN);
    await run.endSession();
    expect(run.logs.filter((line) => line.includes('plugin log '))).toHaveLength(2);
  });

  it('names the no-home failure explicitly', async () => {
    const run = engine({}, { env: {} });
    await run.startSession();
    expect(await run.tool('Bash')).toEqual(RAN);
    await run.endSession();
    expect(run.logs.filter((line) => line.includes('plugin log off: no PLUGIN_LOG_DIR and no HOME'))).toHaveLength(1);
  });

  it('keeps a session-id warning off screen with the log active', async () => {
    const dir = await logTemp();
    const run = engine(SCOPED, { env: { HOME: dir, PLUGIN_LOG_DIR: dir }, runProcess: realProcess, failSessionId: true });
    await run.startSession();
    expect((await run.spawn('scope-child')).deny).toBeDefined();
    await run.endSession();
    const info = await logRows(join(dir, 'tool-visibility-controller'), 'info');
    expect(info).toEqual([expect.objectContaining({ event: 'denied' })]);
    expect(Object.keys(info[0])).not.toContain('session');
    expect(run.logs).toEqual([]);
    expect(await logRows(join(dir, 'tool-visibility-controller'), 'warnings')).toEqual([expect.objectContaining({ level: 'warning', event: 'log-session-unavailable', msg: expect.stringContaining('session id unreadable') })]);
  });

  it('stamps a row with the local time and keeps it when the engine clock is unavailable', async () => {
    const dir = await logTemp();
    const run = engine({}, { env: { HOME: dir, PLUGIN_LOG_DIR: dir }, failClock: true, runProcess: realProcess });
    await run.startSession();
    const before = Date.now();
    expect(await run.caught('tool.call', {}, async () => RAN)).toEqual(RAN);
    await run.endSession();
    expect(run.logs.join('\n')).toContain('clock unreadable');
    const rows = await logRows(join(dir, 'tool-visibility-controller'), 'errors');
    expect(rows).toEqual([expect.objectContaining({ event: 'hook-threw' })]);
    expect(Date.parse(rows[0].ts)).toBeGreaterThanOrEqual(before);
  });

  it('keeps a row whose logger setup fails and writes it once the setup recovers', async () => {
    const dir = await logTemp();
    const opts: Options = { env: { HOME: dir, PLUGIN_LOG_DIR: dir }, failEnv: true, runProcess: realProcess };
    const run = engine({}, opts);
    await run.startSession();
    await run.caught('tool.call', {}, async () => RAN);
    await new Promise((resolve) => setImmediate(resolve));
    opts.failEnv = false;
    await run.caught('agent.spawn', {}, async () => RAN);
    await run.endSession();
    expect((await logRows(join(dir, 'tool-visibility-controller'), 'errors')).map((row) => row.where)).toEqual(['hooks/tool-visibility-controller.ts#tool.call', 'hooks/tool-visibility-controller.ts#agent.spawn']);
  });

  it('shows a burst of identical hook failures once with a summary, and every row still lands in errors.jsonl', async () => {
    const dir = await logTemp();
    let stalled = 3;
    const run = engine({}, { env: { HOME: dir, PLUGIN_LOG_DIR: dir }, runProcess: async (argv, init) => { if (stalled-- > 0) throw new Error('hooks worker stalled'); return realProcess(argv, init); } });
    await run.startSession();
    for (let i = 0; i < 17; i++) {
      expect(await run.caught('tool.call', {}, async () => RAN)).toEqual(RAN);
      if (i % 3 === 2) await new Promise((resolve) => setImmediate(resolve));
    }
    expect(run.logs.filter((line) => line.includes('tool.call failed; proceeding unchecked'))).toHaveLength(1);
    run.fireTimers();
    expect(run.logs.filter((line) => line.includes('tool.call failed; proceeding unchecked'))).toEqual([expect.not.stringContaining('more'), expect.stringContaining('(and 16 more)')]);
    await run.endSession();
    const rows = await logRows(join(dir, 'tool-visibility-controller'), 'errors');
    expect(rows).toHaveLength(17);
    expect(new Set(rows.map((row) => row.event))).toEqual(new Set(['hook-threw']));
    expect(run.logs.filter((line) => line.includes('plugin log ')).length).toBeLessThanOrEqual(1);
  });

  it('flushes the pending burst summary when the session ends', async () => {
    const dir = await logTemp();
    const run = engine({}, { env: { HOME: dir, PLUGIN_LOG_DIR: dir }, runProcess: realProcess });
    await run.startSession();
    for (let i = 0; i < 3; i++) await run.caught('agent.spawn', {}, async () => RAN);
    await run.endSession();
    expect(run.logs.filter((line) => line.includes('agent.spawn failed'))).toEqual([expect.not.stringContaining('more'), expect.stringContaining('(and 2 more)')]);
  });
});

it('starts a new session without waiting for a prior log flush, then drains policy rows from both sessions', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const dir = await logTemp();
  const run = engine({}, { env: { HOME: dir, PLUGIN_LOG_DIR: dir }, runProcess: async (argv, init) => { await blocked; return realProcess(argv, init); } });
  await run.startSession();
  await run.caught('tool.call', {}, async () => RAN);
  const second = run.startSession();
  const outcome = await Promise.race([second.then(() => 'started'), new Promise<string>((resolve) => setImmediate(() => resolve('held by log I/O')))]);
  release();
  await second;
  await run.caught('tool.call', {}, async () => RAN);
  await run.endSession();
  expect(outcome).toBe('started');
  expect((await logRows(join(dir, 'tool-visibility-controller'), 'errors')).map((row) => row.event)).toEqual(['hook-threw', 'hook-threw']);
});
