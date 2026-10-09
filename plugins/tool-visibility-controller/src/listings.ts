// The listing rewrites, pure: each removes what a loop may not see and keeps
// every other byte, so the same input always gives the same output and the
// prompt cache holds. Each answers null when nothing it listed is left.

const TOOLS_SUFFIX = /\(Tools: [^()]*\)\s*$/;

/** The name an entry line lists: `- name: description`, `- plugin:name: description`, or a bare `- name`. */
function entryName(line: string): string | undefined {
  return /^- (\S+?)(?::\s|:$|$)/.exec(line)?.[1];
}

/**
 * The agent or skill listing without the entries `hidden` names. An entry is
 * its `- name` line and the description lines that follow it, a bullet that
 * names no entry included: an agent's up to its `(Tools: ...)` suffix, a
 * skill's up to a blank line or the next entry.
 */
export function filterEntries(text: string, hidden: (name: string) => boolean, kind: 'agents' | 'skills'): string | null {
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
    if (!hidden(name)) {
      remaining += 1;
      kept.push(line);
      continue;
    }
    removed += 1;
    const spans = kind === 'skills' || (line.startsWith(`- ${name}:`) && !TOOLS_SUFFIX.test(line));
    if (!spans) continue;
    if (kind === 'agents') {
      // An agent's description ends at its Tools suffix, blank lines and all, when one comes before the next entry.
      let end = i + 1;
      while (end < lines.length && entryName(lines[end] ?? '') === undefined && !TOOLS_SUFFIX.test(lines[end] ?? '')) end += 1;
      if (end < lines.length && entryName(lines[end] ?? '') === undefined) {
        i = end;
        continue;
      }
    }
    while (i + 1 < lines.length) {
      const next = lines[i + 1] ?? '';
      if (next.trim() === '' || entryName(next) !== undefined) break;
      i += 1;
      if (kind === 'agents' && TOOLS_SUFFIX.test(next)) break;
    }
  }
  if (removed === 0) return text;
  return remaining === 0 ? null : kept.join('\n');
}

/**
 * The MCP server instructions without the `## <server>` blocks `hidden` names
 * (the heading as written, the server's configured name).
 */
export function filterMcpInstructions(text: string, hidden: (server: string) => boolean): string | null {
  const lines = text.split('\n');
  const kept: string[] = [];
  let removed = 0;
  let remaining = 0;
  let dropping = false;
  let lastDropped = false;
  for (const line of lines) {
    const heading = /^## (.+)$/.exec(line)?.[1];
    if (heading !== undefined) {
      dropping = hidden(heading);
      if (dropping) removed += 1;
      else remaining += 1;
    }
    if (!dropping) kept.push(line);
    lastDropped = dropping;
  }
  if (removed === 0) return text;
  if (remaining === 0) return null;
  if (lastDropped) {
    while (kept.length > 0 && kept.at(-1) === '') kept.pop();
    if (text.endsWith('\n')) kept.push('');
  }
  return kept.join('\n');
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/;

/**
 * The deferred-tools notice without the tool names `hidden` names. A list is a
 * paragraph whose first line ends with `:`; one about MCP servers lists server
 * names and is kept as it is. A list left with no name is dropped whole.
 */
export function filterDeferredTools(text: string, hidden: (tool: string) => boolean): string | null {
  const paragraphs = text.split('\n\n');
  const kept: string[] = [];
  let removed = 0;
  for (const paragraph of paragraphs) {
    const [header, ...items] = paragraph.split('\n');
    const toolList = header !== undefined && header.endsWith(':') && !/MCP servers?\b/.test(header);
    if (!toolList || items.length === 0) {
      kept.push(paragraph);
      continue;
    }
    const left = items.filter((item) => !(TOOL_NAME.test(item) && hidden(item)));
    removed += items.length - left.length;
    if (left.length === items.length) kept.push(paragraph);
    else if (left.length > 0) kept.push([header, ...left].join('\n'));
  }
  if (removed === 0) return text;
  return kept.some((paragraph) => paragraph.trim() !== '') ? kept.join('\n\n') : null;
}
