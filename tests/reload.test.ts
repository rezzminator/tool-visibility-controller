import { describe as suite, expect, it } from 'vitest';
import { readSignal, reloadScope, reloadSignalPath, ReloadWatch, signalText } from '../plugins/tool-visibility-controller/src/reload.ts';

suite('reload signal file', () => {
  it.each([
    ['/u', '/u/.local/state/tool-visibility-controller/reload.json'],
    ['/u///', '/u/.local/state/tool-visibility-controller/reload.json'],
    ['', undefined],
    [undefined, undefined],
  ])('home %j gives the path %j', (home, path) => {
    expect(reloadSignalPath(home, 'tool-visibility-controller')).toBe(path);
  });

  it.each([
    [1791991231123, '5f0c2a', '{"at":1791991231123,"by":"5f0c2a"}\n'],
    [1791991231123, undefined, '{"at":1791991231123}\n'],
  ])('writes the moment %j and the session %j as %j', (at, session, text) => {
    expect(signalText(at, session)).toBe(text);
  });

  it.each([
    ['{"at":1791991231123,"by":"5f0c2a"}\n', { at: 1791991231123, by: '5f0c2a' }],
    ['{"at":1791991231123}', { at: 1791991231123 }],
    ['{"at":1791991231123,"by":7}', { at: 1791991231123 }],
    ['', { problem: 'not JSON: Unexpected end of JSON input' }],
    ['[1791991231123]', { problem: 'not an object with a numeric "at"' }],
    ['null', { problem: 'not an object with a numeric "at"' }],
    ['{"at":"1791991231123"}', { problem: 'not an object with a numeric "at"' }],
    ['{"at":null}', { problem: 'not an object with a numeric "at"' }],
  ])('reads %j as %j', (text, signal) => {
    expect(readSignal(text)).toEqual(signal);
  });
});

suite('reload scope', () => {
  it.each([
    [undefined, 'all'],
    ['all', 'all'],
    ['self', 'self'],
    ['others', { problem: 'scope must be "all" or "self", got "others"' }],
    [7, { problem: 'scope must be "all" or "self", got 7' }],
  ])('reads %j as %j', (input, scope) => {
    expect(reloadScope(input)).toEqual(scope);
  });
});

suite('reload watch', () => {
  it.each([
    [999, undefined],
    [1000, undefined],
    [1001, 'signal'],
    [undefined, undefined],
  ])('a chat that loaded its plugins at 1000 meets a signal of %j: reloads for %j', (signal, cause) => {
    expect(new ReloadWatch(1000).take(signal)).toBe(cause);
  });

  it('answers one signal once, and the next signal again', () => {
    const watch = new ReloadWatch(1000);
    expect([watch.take(2000), watch.take(2000), watch.take(2001), watch.take(2001)]).toEqual(['signal', undefined, 'signal', undefined]);
  });

  it('counts a reload from anywhere: a signal older than it is not due, a newer one is', () => {
    const watch = new ReloadWatch(1000);
    watch.loaded(3000);
    expect([watch.take(2999), watch.take(3000), watch.take(3001)]).toEqual([undefined, undefined, 'signal']);
  });

  it('never moves back: an older reload does not make an answered signal due again', () => {
    const watch = new ReloadWatch(1000);
    expect(watch.take(2000)).toBe('signal');
    watch.loaded(1500);
    expect(watch.take(2000)).toBe(undefined);
  });

  it("answers the chat's own ask once, with or without a signal, and names a due signal as the cause over it", () => {
    const watch = new ReloadWatch(1000);
    watch.askSelf();
    expect([watch.take(undefined), watch.take(undefined)]).toEqual(['self', undefined]);
    watch.askSelf();
    expect([watch.take(900), watch.take(900)]).toEqual(['self', undefined]);
    watch.askSelf();
    expect([watch.take(2000), watch.take(2000)]).toEqual(['signal', undefined]);
  });
});
