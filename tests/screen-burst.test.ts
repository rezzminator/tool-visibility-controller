import { describe, expect, it } from 'vitest';
import { BURST_WINDOW_MS, ScreenBurst } from '../plugins/tool-visibility-controller/src/screen-burst.ts';

const LINE = 'tool-visibility-controller: tool.call failed; proceeding unchecked';

describe('screen burst', () => {
  it('shows the first line of a burst and counts the identical repeats', () => {
    const burst = new ScreenBurst();
    expect(burst.offer(LINE, 1000)).toEqual([LINE]);
    for (let i = 0; i < 16; i++) expect(burst.offer(LINE, 1000 + i * 100)).toEqual([]);
    expect(burst.pending()).toBe(16);
    expect(burst.drain()).toEqual([`${LINE} (and 16 more)`]);
    expect(burst.pending()).toBe(0);
    expect(burst.drain()).toEqual([]);
  });

  it('summarises on the first repeat past the window, then opens a new burst', () => {
    const burst = new ScreenBurst();
    burst.offer(LINE, 0);
    burst.offer(LINE, 10);
    burst.offer(LINE, 20);
    expect(burst.offer(LINE, BURST_WINDOW_MS)).toEqual([`${LINE} (and 2 more)`, LINE]);
    expect(burst.offer(LINE, BURST_WINDOW_MS + 1)).toEqual([]);
    expect(burst.drain()).toEqual([`${LINE} (and 1 more)`]);
  });

  it('shows a line again after a drain, and keeps different lines apart', () => {
    const burst = new ScreenBurst();
    const other = 'tool-visibility-controller: agent.spawn failed; proceeding unchecked';
    expect(burst.offer(LINE, 0)).toEqual([LINE]);
    expect(burst.offer(other, 1)).toEqual([other]);
    expect(burst.offer(LINE, 2)).toEqual([]);
    expect(burst.offer(other, 3)).toEqual([]);
    expect(burst.drain()).toEqual([`${LINE} (and 1 more)`, `${other} (and 1 more)`]);
    expect(burst.offer(LINE, 4)).toEqual([LINE]);
  });

  it('forgets a quiet line so the map stays bounded', () => {
    const burst = new ScreenBurst();
    for (let i = 0; i < 500; i++) burst.offer(`line ${i}`, i);
    expect(burst.size()).toBeGreaterThan(0);
    expect(burst.offer('line 0', BURST_WINDOW_MS * 2)).toEqual(['line 0']);
    expect(burst.size()).toBeLessThan(10);
  });
});
