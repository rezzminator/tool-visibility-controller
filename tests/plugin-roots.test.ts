import { describe as suite, expect, it } from 'vitest';
import { directoryLocation, enabledPlugins, installedRoot, listedRoot } from '../plugins/tool-visibility-controller/src/plugin-roots.ts';

const FLIGHTS = { plugin: 'flights', marketplace: 'professor', id: 'flights@professor' };

suite('enabledPlugins', () => {
  it('lists the plugin@marketplace keys whose value is true, sorted by id', () => {
    const settings = { enabledPlugins: { 'zeta@professor': true, 'flights@professor': true, 'off@professor': false, 'flights@other': true, bare: true, '@x': true, 'y@': true, 'str@professor': 'true' } };
    expect(enabledPlugins(settings)).toEqual([
      { plugin: 'flights', marketplace: 'other', id: 'flights@other' },
      FLIGHTS,
      { plugin: 'zeta', marketplace: 'professor', id: 'zeta@professor' },
    ]);
  });

  it('reads no plugins from settings without the key, and throws for a shape that is not an object', () => {
    expect(enabledPlugins({})).toEqual([]);
    expect(() => enabledPlugins([])).toThrow('the settings file is not an object');
    expect(() => enabledPlugins({ enabledPlugins: ['flights@professor'] })).toThrow('enabledPlugins is not an object');
  });
});

suite('plugin roots', () => {
  const known = { professor: { source: { source: 'directory', path: '/m' }, installLocation: '/m/' }, hub: { source: { source: 'github', repo: 'a/b' }, installLocation: '/hub' } };

  it('takes the install location of a directory marketplace only', () => {
    expect(directoryLocation(known, 'professor')).toBe('/m/');
    expect(directoryLocation(known, 'hub')).toBeUndefined();
    expect(directoryLocation(known, 'absent')).toBeUndefined();
    expect(() => directoryLocation('x', 'professor')).toThrow('the known marketplaces file is not an object');
  });

  it.each([
    { location: '/m/', source: './plugins/flights', root: '/m/plugins/flights' },
    { location: '/m', source: 'plugins/flights/', root: '/m/plugins/flights' },
    { location: '/m', source: './', root: '/m' },
    { location: '/', source: './plugins/flights', root: '/plugins/flights' },
    { location: '/m', source: '/abs/flights', root: '/abs/flights' },
  ])('joins $location and the listed source $source', ({ location, source, root }) => {
    expect(listedRoot(location, { plugins: [{ name: 'other', source: './x' }, { name: 'flights', source }] }, 'flights')).toBe(root);
  });

  it('finds no root for a plugin the listing lacks or sources from a repository, and throws for a listing with no plugins list', () => {
    expect(listedRoot('/m', { plugins: [{ name: 'other', source: './x' }] }, 'flights')).toBeUndefined();
    expect(listedRoot('/m', { plugins: [{ name: 'flights', source: { source: 'git-subdir', url: 'u' } }] }, 'flights')).toBeUndefined();
    expect(() => listedRoot('/m', {}, 'flights')).toThrow('the marketplace listing has no plugins list');
  });

  it('reads the first install path of the plugin id from installed_plugins.json', () => {
    const installed = { version: 2, plugins: { 'flights@professor': [{ scope: 'user', installPath: '/cache/flights/0.1.0' }, { installPath: '/cache/old' }], 'blank@professor': [{ installPath: '' }] } };
    expect(installedRoot(installed, FLIGHTS)).toBe('/cache/flights/0.1.0');
    expect(installedRoot(installed, { plugin: 'blank', marketplace: 'professor', id: 'blank@professor' })).toBeUndefined();
    expect(installedRoot(installed, { plugin: 'none', marketplace: 'professor', id: 'none@professor' })).toBeUndefined();
    expect(installedRoot({ version: 2 }, FLIGHTS)).toBeUndefined();
    expect(() => installedRoot({ plugins: [] }, FLIGHTS)).toThrow('plugins is not an object');
  });
});
