import { describe, expect, it } from 'vitest';
import { hookFailureText, message, missingDefinition, unresolvedLoopText } from '../plugins/tool-visibility-controller/src/failures.ts';

describe('failure diagnostics', () => {
  it.each([
    Object.assign(new Error('file missing'), { code: 'ENOENT' }),
    new Error("ENOENT: no such file or directory, open '/defs/missing.md'"),
    { message: 'ENOENT: serialized missing file' },
    { code: undefined, message: 'ENOENT: missing file without an errno code' },
    'ENOENT: missing file',
  ])('recognizes a missing definition: %s', (error) => {
    expect(missingDefinition(error)).toBe(true);
  });

  it.each([
    Object.assign(new Error('ENOENT in unrelated context'), { code: 'EACCES' }),
    new Error("EACCES: permission denied, open '/defs/ENOENT.md'"),
    new Error('read failed'),
    new Error('ENOENTISH is not an errno'),
    { code: 'EIO' },
    null,
    undefined,
  ])('does not skip another failure as missing: %s', (error) => {
    expect(missingDefinition(error)).toBe(false);
  });

  it('keeps error messages from both engine objects and thrown values', () => {
    expect(message(new Error('reason'))).toBe('reason');
    expect(message({ message: 'serialized reason' })).toBe('serialized reason');
    expect(message('reason')).toBe('reason');
    expect(message(null)).toBe('null');
  });

  it('names the unresolved identity, unchecked action, fallback and recovery', () => {
    expect(unresolvedLoopText('worker1', 'rewriting agent_listing_delta')).toMatch(
      /worker1.*no agent type.*rewriting agent_listing_delta.*unchecked.*left whole.*restore.*agent-list.*SubagentStart/,
    );
  });

  it('explicitly names a failure with no engine message rather than printing undefined', () => {
    expect(hookFailureText('tool.call', { kind: 'timeout' }, 'tool Read, loop main')).toContain(
      'timeout: engine supplied no failure message',
    );
  });

  it.each(['throw', 'timeout', 're-entry'] as const)('names the hook, %s reason and target context', (kind) => {
    expect(hookFailureText('tool.call', { kind, message: 'worker unavailable' }, 'tool Read, loop worker1')).toBe(
      `tool.call failed; proceeding unchecked (tool Read, loop worker1; ${kind}: worker unavailable)`,
    );
  });
});
