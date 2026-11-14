// Where an enabled plugin lives, pure: the readings of the four records Claude
// Code keeps (settings.json, known_marketplaces.json, a directory marketplace's
// marketplace.json, installed_plugins.json). A record's absence is `undefined`;
// a record present in a shape that cannot be read throws, so the adapter, which
// reads the files, logs it with its path rather than taking it for "nothing".

/** One enabled plugin: its name, its marketplace and the `plugin@marketplace` id Claude Code keys it by. */
export type PluginRef = { plugin: string; marketplace: string; id: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${what} is not an object`);
  return value;
}

/** The plugins `settings.enabledPlugins` turns on (`plugin@marketplace: true`), sorted by id. */
export function enabledPlugins(settings: unknown): PluginRef[] {
  const enabled = object(settings, 'the settings file').enabledPlugins;
  if (enabled === undefined) return [];
  const refs: PluginRef[] = [];
  for (const [id, on] of Object.entries(object(enabled, 'enabledPlugins'))) {
    const at = id.indexOf('@');
    if (on !== true || at <= 0 || at === id.length - 1) continue;
    refs.push({ plugin: id.slice(0, at), marketplace: id.slice(at + 1), id });
  }
  return refs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A directory marketplace's install location in `known_marketplaces.json`; undefined for any other kind or an absent entry. */
export function directoryLocation(known: unknown, marketplace: string): string | undefined {
  const entry = object(known, 'the known marketplaces file')[marketplace];
  if (!isObject(entry) || !isObject(entry.source) || entry.source.source !== 'directory') return undefined;
  return typeof entry.installLocation === 'string' && entry.installLocation !== '' ? entry.installLocation : undefined;
}

/** The root of `plugin` in a directory marketplace: its install location joined with the listed relative source; undefined when the listing has no such local source. */
export function listedRoot(location: string, listing: unknown, plugin: string): string | undefined {
  const plugins = object(listing, 'the marketplace listing').plugins;
  if (!Array.isArray(plugins)) throw new Error('the marketplace listing has no plugins list');
  const entry = plugins.find((item) => isObject(item) && item.name === plugin);
  if (!isObject(entry) || typeof entry.source !== 'string' || entry.source === '') return undefined;
  const base = location.replace(/\/+$/, '');
  const relative = entry.source.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (entry.source.startsWith('/')) return entry.source;
  return relative === '' || relative === '.' ? base || '/' : `${base}/${relative}`;
}

/** The install path of `ref` in `installed_plugins.json` (its first install); undefined when none is recorded. */
export function installedRoot(installed: unknown, ref: PluginRef): string | undefined {
  const plugins = object(installed, 'the installed plugins file').plugins;
  if (plugins === undefined) return undefined;
  const installs = object(plugins, 'plugins')[ref.id];
  if (!Array.isArray(installs) || !isObject(installs[0])) return undefined;
  const path = installs[0].installPath;
  return typeof path === 'string' && path !== '' ? path : undefined;
}
