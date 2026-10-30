import { describe as suite, expect, it } from 'vitest';
import { AgentTypes } from '../plugins/tool-visibility-controller/src/agent-types.ts';

suite('AgentTypes', () => {
  it('answers an announced type for an id no list row names', async () => {
    const types = new AgentTypes();
    types.learn('wf1', 'general-purpose');
    expect(await types.of('wf1', async () => [])).toBe('general-purpose');
  });

  it("takes the list's type over an announcement for an id the list names: a teammate's announcement carries its name", async () => {
    const types = new AgentTypes();
    types.learn('tm1', 'scout-2');
    expect(await types.of('tm1', async () => [{ id: 'tm1', type: 'general-purpose' }])).toBe('general-purpose');
  });

  it('asks the list for an id nothing announced and remembers the answer', async () => {
    const types = new AgentTypes();
    let asked = 0;
    const list = async () => (asked += 1, [{ id: 'a1', type: 'Explore' }]);
    expect(await types.of('a1', list)).toBe('Explore');
    expect(await types.of('a1', list)).toBe('Explore');
    expect(asked).toBe(1);
  });

  it('gives undefined for an id neither names, and asks the list again next time', async () => {
    const types = new AgentTypes();
    let asked = 0;
    const list = async () => (asked += 1, []);
    expect(await types.of('fork1', list)).toBeUndefined();
    expect(await types.of('fork1', list)).toBeUndefined();
    expect(asked).toBe(2);
  });

  it('ignores an announcement with no id or no type', async () => {
    const types = new AgentTypes();
    types.learn('', 'Explore');
    types.learn('a1', '');
    expect(await types.of('', async () => [])).toBeUndefined();
    expect(await types.of('a1', async () => [])).toBeUndefined();
  });

  it('names an id a list row or an announcement named, typed or not, and no other: an engine loop', async () => {
    const types = new AgentTypes();
    types.learn('wf1', '');
    expect(await types.of('wf1', async () => [])).toBeUndefined();
    expect(await types.of('ls1', async () => [{ id: 'ls1', type: '' }])).toBeUndefined();
    expect(await types.of('fork1', async () => [])).toBeUndefined();
    expect([types.named('wf1'), types.named('ls1'), types.named('fork1'), types.named('')]).toEqual([true, true, false, false]);
  });

  it('reports an unresolved loop once per id', () => {
    const types = new AgentTypes();
    expect([types.firstMiss('fork1'), types.firstMiss('fork1'), types.firstMiss('fork2'), types.firstMiss('fork1')]).toEqual([true, false, true, false]);
  });
});
