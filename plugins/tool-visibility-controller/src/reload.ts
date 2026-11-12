// The reload signal: one chat asks, and every open chat that runs this plugin
// reloads its own plugins. The signal is one small file all of a user's chats
// watch; a chat is due when the signal is newer than its last plugin load.

/** How often a chat looks at the signal file. */
export const RELOAD_POLL_MS = 5000;

export const RELOAD_SCOPES = ['all', 'self'] as const;
export type ReloadScope = (typeof RELOAD_SCOPES)[number];

/** What `$.tool.register` takes: the model calls it as `mcp__tool-visibility-controller__reload_plugins`. */
export const RELOAD_TOOL = {
  name: 'reload_plugins',
  description:
    'Reloads plugins in open chats — after a plugin\'s files changed: `all` (the default) signals every open chat on this machine that runs this plugin, this one included; `self` reloads this chat only. An idle chat reloads within seconds, a working chat when its turn ends, never mid-turn. Example: {"scope": "all"}. Returns one line saying who reloads; a failure starts `Nothing reloaded:` and names why. A chat that has not loaded this plugin is not reached.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: [...RELOAD_SCOPES], description: 'Who reloads: `all` when left out.' },
    },
  },
};

/** What the tool answers once the reload is on its way. */
export const RELOAD_ANSWERS: Record<ReloadScope, string> = {
  all: `Reload signal sent: every open chat running this plugin reloads its plugins, an idle chat within about ${RELOAD_POLL_MS / 1000} seconds, a working chat when its turn ends, this chat when this turn ends.`,
  self: 'This chat reloads its plugins when this turn ends.',
};

/** The signal file, beside the plugin's logs; undefined with no home directory. */
export function reloadSignalPath(home: string | undefined, plugin: string): string | undefined {
  return home ? `${home.replace(/\/+$/, '')}/.local/state/${plugin}/reload.json` : undefined;
}

/** The file's whole content: when the reload was asked for, and by which session when known. */
export function signalText(at: number, session?: string): string {
  return `${JSON.stringify(session === undefined ? { at } : { at, by: session })}\n`;
}

export function readSignal(text: string): { at: number; by?: string } | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { problem: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const at = typeof value === 'object' && value !== null ? (value as { at?: unknown }).at : undefined;
  if (typeof at !== 'number' || !Number.isFinite(at)) return { problem: 'not an object with a numeric "at"' };
  const by = (value as { by?: unknown }).by;
  return typeof by === 'string' ? { at, by } : { at };
}

export function reloadScope(input: unknown): ReloadScope | { problem: string } {
  if (input === undefined) return 'all';
  const scope = RELOAD_SCOPES.find((known) => known === input);
  return scope ?? { problem: `scope must be "all" or "self", got ${JSON.stringify(input)}` };
}

/** Why a chat reloads: the signal file, or its own ask. */
export type ReloadCause = 'signal' | 'self';

/** One chat's side of the signal: a signal, or the chat's own ask, is due once. */
export class ReloadWatch {
  private since: number;
  private self = false;

  /** `loadedAt`: when this chat loaded the plugin, so a signal sent before it opened is never due. */
  constructor(loadedAt: number) {
    this.since = loadedAt;
  }

  /** The chat reloaded its plugins at `at`, whoever asked: every signal up to then is answered. */
  loaded(at: number): void {
    if (at > this.since) this.since = at;
  }

  /** The chat asks for its own reload. */
  askSelf(): void {
    this.self = true;
  }

  /** Why to reload now, given the signal file's moment (undefined: no signal); undefined when nothing is due. An answer takes the ask. */
  take(signalAt: number | undefined): ReloadCause | undefined {
    const signalled = signalAt !== undefined && signalAt > this.since;
    if (signalled) this.since = signalAt;
    const cause = signalled ? 'signal' : this.self ? 'self' : undefined;
    this.self = false;
    return cause;
  }
}
