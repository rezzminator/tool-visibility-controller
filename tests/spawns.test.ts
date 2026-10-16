import { describe as suite, expect, it } from 'vitest';
import { SpawnCalls } from '../plugins/tool-visibility-controller/src/spawns.ts';

suite('SpawnCalls', () => {
  it('claims a noted call once, so a later resume under the same id is not a fresh spawn', () => {
    const calls = new SpawnCalls();
    calls.note('t1');
    expect(calls.claim('t1')).toBe(true);
    expect(calls.claim('t1')).toBe(false);
  });

  it('never claims a call it was not told of, an empty id or none', () => {
    const calls = new SpawnCalls();
    calls.note('');
    expect(calls.claim('t9')).toBe(false);
    expect(calls.claim('')).toBe(false);
    expect(calls.claim(undefined)).toBe(false);
  });

  it('forgets the oldest call past its cap', () => {
    const calls = new SpawnCalls(2);
    for (const id of ['a', 'b', 'c']) calls.note(id);
    expect(calls.claim('a')).toBe(false);
    expect(calls.claim('b')).toBe(true);
    expect(calls.claim('c')).toBe(true);
  });
});
