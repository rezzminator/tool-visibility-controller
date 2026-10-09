import { describe as suite, expect, it } from 'vitest';
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
const MCP = ['# MCP Server Instructions', '', 'The following MCP servers have provided instructions:', '', '## professor', 'Harvester and chats.', '', '## docs', 'Docs.'].join('\n');
const DEFERRED = ['The following deferred tools are now available via ToolSearch:', 'WebFetch', 'mcp__professor__harvester_search_web', 'mcp__docs__read'].join('\n');
const TOOLS = ['Bash', 'Read', 'WebFetch', 'mcp__professor__harvester_search_web', 'mcp__professor__harvester_read', 'mcp__professor__chat_ls', 'mcp__docs__read', 'mcp__my__srv__read'];
const RAN = { result: 'ran', text: 'ran' };

type Options = { env?: Record<string, string>; failRead?: string; failList?: boolean; root?: string };

function engine(files: Record<string, string>, options: Options = {}) {
  const hooks = new Map<string, Hook>();
  const catches = new Map<string, Hook>();
  const logs: string[] = [];
  const agents: Array<{ id: string; type: string; status: string; description: string }> = [];
  let lists = 0;
  const under = (path: string) => Object.keys(files).filter((f) => f.startsWith(`${path}/`));
  const $ = {
    env: { get: async (name: string) => (options.env ?? { HOME })[name] },
    session: { root: async () => options.root ?? ROOT },
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
    ui: { log: (line: string) => logs.push(line) },
  };
  (register as Hook)((name: string, fn: Hook) => (hooks.set(name, fn), { catch: (handler: Hook) => catches.set(name, handler) }), {});
  const call = (name: string, e: unknown, next: Hook) => hooks.get(name)!($, e, next);
  return {
    logs,
    lists: () => lists,
    sub: (id: string, type: string) => agents.push({ id, type, status: 'running', description: '' }),
    attach: (type: string, text: string, agentId?: string) =>
      call('prompt.attachment', { type, text, origin: { kind: 'engine' }, agentId }, async (e: { text: string }) => ({ text: e.text })),
    spawn: (subagentType: string, parentAgentId?: string) =>
      call('agent.spawn', { subagentType, parentAgentId, prompt: 'p', description: 'd' }, async () => ({ model: 'm', agentId: 'new' })),
    tool: (tool: string, input: Record<string, unknown> = {}, agentId?: string) =>
      call('tool.call', { tool, tool_use_id: 't1', ...input, agentId }, async () => RAN),
    startSession: () => call('session.start', {}, async () => ({})),
    caught: (name: string, e: unknown, next: Hook) => catches.get(name)!($, e, next),
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

  it('refuses a spawn from a loop it is not visible to, naming the rule, and lets the parent through', async () => {
    const run = engine(SCOPED);
    run.sub('par1', 'scope-parent');
    const result = await run.spawn('scope-child');
    expect(result.deny).toContain('Agent type scope-child is not available to the main chat');
    expect(result.deny).toContain(`visibility.visible-to in ${ROOT}/.claude/agents/scope-child.md`);
    expect(await run.spawn('scope-child', 'par1')).toEqual({ model: 'm', agentId: 'new' });
    expect(await run.spawn('scope-parent')).toEqual({ model: 'm', agentId: 'new' });
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
    [SCOPE]: JSON.stringify({ loops: { main: { mcp: { exclude: ['professor/harvester_*'] } } } }),
    [`${ROOT}/.claude/agents/rr.md`]: md('rr', 'visibility:\n  mcp:\n    include: [professor/harvester_search_web]\n'),
  };

  it('refuses an MCP tool call by the loop rules and lets an allowed one through', async () => {
    const run = engine(FILES);
    run.sub('r1', 'rr');
    expect((await run.tool('mcp__professor__harvester_search_web', { query: 'x' })).deny).toContain(`loops.main.mcp in ${SCOPE} excludes professor/harvester_*`);
    expect(await run.tool('mcp__professor__harvester_search_web', { query: 'x' }, 'r1')).toEqual(RAN);
    expect((await run.tool('mcp__docs__read', {}, 'r1')).deny).toContain('admits only professor/harvester_search_web');
    expect(await run.tool('mcp__docs__read', {})).toEqual(RAN);
  });

  it("drops a server's instructions only for a loop that may use none of its tools", async () => {
    const run = engine(FILES);
    run.sub('r1', 'rr');
    expect(await run.attach('mcp_instructions_delta', MCP)).toEqual({ text: MCP });
    expect(await run.attach('mcp_instructions_delta', MCP, 'r1')).toEqual({ text: MCP.replace('\n\n## docs\nDocs.', '') });
    const spaced = engine({ [SCOPE]: JSON.stringify({ loops: { main: { mcp: { exclude: ['my  srv'] } } } }) });
    expect(await spaced.attach('mcp_instructions_delta', `${MCP}\n\n## my  srv\nMine.`)).toEqual({ text: MCP });
    expect((await spaced.tool('mcp__my__srv__read', {})).deny).toContain('excludes my  srv');
  });

  it('hides MCP and built-in tools from the deferred list per loop', async () => {
    const run = engine({ ...FILES, [`${ROOT}/.claude/agents/rr.md`]: md('rr', 'visibility:\n  tools:\n    exclude: [WebFetch]\n') });
    run.sub('r1', 'rr');
    expect(await run.attach('deferred_tools_delta', DEFERRED)).toEqual({ text: DEFERRED.replace('mcp__professor__harvester_search_web\n', '') });
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

  it('fails open, logged, when a loop id resolves to no agent', async () => {
    const run = engine({ ...SCOPED, [SCOPE]: '{"loops": {"main": {"tools": {"exclude": ["Bash"]}}}}' });
    expect(await run.attach('agent_listing_delta', AGENTS, 'ghost')).toEqual({ text: AGENTS });
    expect(await run.spawn('scope-child', 'ghost')).toEqual({ model: 'm', agentId: 'new' });
    expect(await run.tool('Bash', {}, 'ghost')).toEqual(RAN);
    expect(run.logs.join('\n')).toMatch(/ghost.*no agent type/);
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
