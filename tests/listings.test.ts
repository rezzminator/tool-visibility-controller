import { describe as suite, expect, it } from 'vitest';
import { filterDeferredTools, filterEntries, filterMcpInstructions } from '../plugins/tool-visibility-controller/src/listings.ts';

const hide = (...names: string[]) => (name: string) => names.includes(name);

// The shape Claude Code 2.1.295 renders, captured from a live probe.
const AGENTS = [
  'Available agent types for the Agent tool:',
  '- general-purpose: General-purpose agent for researching complex questions. (Tools: *)',
  '- scope-child: Test child agent for the scope probe. Answers with the word CHILD-PONG and nothing else. (Tools: Read)',
  '- kit:helper: A plugin agent. (Tools: Read)',
  '- sub-tracer: TRACER-ONLY follows one thread of code — spawned by tracer. (Tools: Read, Grep, Glob, Bash, Agent)',
  '',
  'When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.',
].join('\n');

suite('filterEntries: the agent listing', () => {
  it('removes a hidden agent line and keeps every other byte', () => {
    expect(filterEntries(AGENTS, hide('scope-child'), 'agents')).toBe(AGENTS.replace(/- scope-child: [^\n]*\n/, ''));
  });

  it('removes a plugin agent by its plugin:name', () => {
    expect(filterEntries(AGENTS, hide('kit:helper'), 'agents')).toBe(AGENTS.replace('- kit:helper: A plugin agent. (Tools: Read)\n', ''));
    expect(filterEntries(AGENTS, hide('kit'), 'agents')).toBe(AGENTS);
  });

  it('returns the same text when nothing matches, and never matches a prefix', () => {
    expect(filterEntries(AGENTS, hide(), 'agents')).toBe(AGENTS);
    expect(filterEntries(AGENTS, hide('scope', 'sub'), 'agents')).toBe(AGENTS);
  });

  it('removes a description that spans lines, up to its Tools suffix', () => {
    const text = ['Available agent types for the Agent tool:', '- kid: first line', 'second line (Tools: Read)', '- other: x (Tools: *)', ''].join('\n');
    expect(filterEntries(text, hide('kid'), 'agents')).toBe(['Available agent types for the Agent tool:', '- other: x (Tools: *)', ''].join('\n'));
    const bulleted = ['- kid: first line', '- Use it for audits', '- Never for deploys (Tools: Read)', '- other: x (Tools: *)'].join('\n');
    expect(filterEntries(bulleted, hide('kid'), 'agents')).toBe('- other: x (Tools: *)');
    const paragraphs = ['- kid: first paragraph', '', 'second paragraph (Tools: Read)', '- other: x (Tools: *)'].join('\n');
    expect(filterEntries(paragraphs, hide('kid'), 'agents')).toBe('- other: x (Tools: *)');
  });

  it('stops a spanning description at a blank line or the next entry', () => {
    const text = ['- kid: no suffix', '- other: x (Tools: *)', '', 'Footer.'].join('\n');
    expect(filterEntries(text, hide('kid'), 'agents')).toBe(['- other: x (Tools: *)', '', 'Footer.'].join('\n'));
  });

  it('removes a bare name line, as a removal section lists it', () => {
    const text = ['- other: x (Tools: *)', '', 'No longer available:', '- kid', '- gone'].join('\n');
    expect(filterEntries(text, hide('kid'), 'agents')).toBe(['- other: x (Tools: *)', '', 'No longer available:', '- gone'].join('\n'));
  });

  it('drops the attachment when every entry it carried was hidden', () => {
    const text = ['New agent types are available for the Agent tool:', '- kid: x (Tools: Read)', ''].join('\n');
    expect(filterEntries(text, hide('kid'), 'agents')).toBeNull();
  });
});

const SKILLS = [
  'The following skills are available for use with the Skill tool:',
  '',
  '- greet: Probe skill that prints a greeting word.',
  '- api-ref: Reference for an API — model ids, params.',
  'TRIGGER — read BEFORE opening the target file, whenever the prompt names it.',
  'SKIP only when another provider is being worked on.',
  '- docs-kit:pdf: Read and write PDF files.',
  '- docs-kit:xlsx',
  '- cmd: Probe command.',
].join('\n');

suite('filterEntries: the skill listing', () => {
  it('removes a skill line and keeps every other byte', () => {
    expect(filterEntries(SKILLS, hide('greet'), 'skills')).toBe(SKILLS.replace('- greet: Probe skill that prints a greeting word.\n', ''));
  });

  it('removes a description that continues on lines of its own', () => {
    const out = filterEntries(SKILLS, hide('api-ref'), 'skills');
    expect(out).not.toContain('TRIGGER');
    expect(out).not.toContain('SKIP only');
    expect(out).toContain('- docs-kit:pdf: Read and write PDF files.');
    const bulleted = ['- secret: Deploys.', '- Use when shipping', '- Never on a Friday', '- after: After.'].join('\n');
    expect(filterEntries(bulleted, hide('secret'), 'skills')).toBe('- after: After.');
  });

  it('removes plugin skills, bare or described, and the last entry', () => {
    expect(filterEntries(SKILLS, hide('docs-kit:pdf', 'docs-kit:xlsx', 'cmd'), 'skills')).toBe(SKILLS.split('\n').slice(0, 6).join('\n'));
  });

  it('drops the attachment when every skill was hidden', () => {
    expect(filterEntries(SKILLS, () => true, 'skills')).toBeNull();
  });
});

const MCP = [
  '# MCP Server Instructions',
  '',
  'The following MCP servers have provided instructions for how to use their tools and resources:',
  '',
  '## claude.ai Docs',
  'Docs: living docs you create and edit here.',
  '',
  '## professor',
  'Read a web page → harvester_read.',
  '',
  'Message a chat → chat_inject.',
  '',
  '## compactor',
  'Tools registered by the compactor plugin.',
].join('\n');

suite('filterMcpInstructions', () => {
  it('drops a middle server block whole', () => {
    expect(filterMcpInstructions(MCP, hide('professor'))).toBe(MCP.replace('## professor\nRead a web page → harvester_read.\n\nMessage a chat → chat_inject.\n\n', ''));
  });

  it('drops the last block without leaving a trailing blank line', () => {
    expect(filterMcpInstructions(MCP, hide('compactor'))).toBe(MCP.replace('\n\n## compactor\nTools registered by the compactor plugin.', ''));
  });

  it('keeps the text as it was when no block is hidden', () => {
    expect(filterMcpInstructions(MCP, hide())).toBe(MCP);
  });

  it('drops the attachment when every block is hidden', () => {
    expect(filterMcpInstructions(MCP, () => true)).toBeNull();
  });

  it('passes the heading as written', () => {
    const seen: string[] = [];
    filterMcpInstructions(MCP, (name) => (seen.push(name), false));
    expect(seen).toEqual(['claude.ai Docs', 'professor', 'compactor']);
  });
});

const DEFERRED = [
  'The following tools just became available and are ready to use:',
  'mcp__docs__batch',
  '',
  'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:',
  'WebFetch',
  'WebSearch',
  'mcp__professor__harvester_read',
  'mcp__professor__harvester_search_web',
  '',
  'The following MCP servers are still connecting — their tools (typically named mcp__<server>__*) are not yet available but will appear shortly:',
  'WebFetch',
  'claude.ai Harvester',
  '',
  'If the user\'s request might be served by one of these servers, call ToolSearch with a relevant keyword.',
].join('\n');

suite('filterDeferredTools', () => {
  it('drops hidden tool names and keeps every other byte', () => {
    expect(filterDeferredTools(DEFERRED, hide('WebFetch', 'mcp__professor__harvester_search_web'))).toBe(
      DEFERRED.replace('\nWebFetch\nWebSearch', '\nWebSearch').replace('mcp__professor__harvester_search_web\n', ''),
    );
  });

  it('never reads a server list as tool names', () => {
    expect(filterDeferredTools(DEFERRED, hide('WebFetch'))).toContain('still connecting — their tools (typically named mcp__<server>__*) are not yet available but will appear shortly:\nWebFetch\nclaude.ai Harvester');
  });

  it('drops a section whose every tool was hidden, with its separator', () => {
    expect(filterDeferredTools(DEFERRED, hide('mcp__docs__batch'))).toBe(DEFERRED.replace('The following tools just became available and are ready to use:\nmcp__docs__batch\n\n', ''));
  });

  it('returns the same text when nothing is hidden', () => {
    expect(filterDeferredTools(DEFERRED, hide())).toBe(DEFERRED);
  });

  it('drops the attachment when nothing is left', () => {
    const text = 'The following deferred tools are now available via ToolSearch:\nWebFetch\nmcp__x__y';
    expect(filterDeferredTools(text, () => true)).toBeNull();
  });
});
