import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const temp = async () => { const d = await mkdtemp(join(tmpdir(), 'plugin-log-')); dirs.push(d); return d; };
async function writer(): Promise<typeof import('../plugins/tool-visibility-controller/src/plugin-log.ts')> {
  return import('../plugins/tool-visibility-controller/src/plugin-log.ts');
}
const NOW = 1791991231123;
const PLUGIN = 'tool-visibility-controller';
const fields = { plugin: PLUGIN, level: 'error' as const, event: 'check-failed', msg: 'policy read failed', where: 'hooks/tool-visibility-controller.ts#checkCall' };
const run = async (argv: readonly string[]) => {
  try {
    const result = await exec(argv[0]!, argv.slice(1));
    return { exitCode: 0, ...result };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message };
  }
};

describe('plugin log row contract', () => {
  it.each([
    { session: '5f0c2a', detail: { error: 'unreadable' }, keys: ['ts', 'plugin', 'level', 'event', 'msg', 'where', 'session', 'detail'] },
    { session: undefined, detail: undefined, keys: ['ts', 'plugin', 'level', 'event', 'msg', 'where'] },
  ])('writes exact ordered keys, timestamp and optional session: $session', async ({ session, detail, keys }) => {
    const { levelRow } = await writer();
    const row = levelRow({ ...fields, session, detail }, NOW);
    expect(row).toBe(`${JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', ...fields, ...(session ? { session } : {}), ...(detail ? { detail } : {}) })}\n`);
    expect(Object.keys(JSON.parse(row))).toEqual(keys);
    expect(Buffer.byteLength(row)).toBeLessThanOrEqual(4096);
  });

  it.each([
    { override: '/x/logs', home: '/h/u', expected: '/x/logs/auto-effort' },
    { override: undefined, home: '/h/u', expected: '/h/u/.local/state/auto-effort/logs' },
    { override: undefined, home: undefined, expected: undefined },
    { override: '', home: '/h/u/', expected: '/h/u/.local/state/auto-effort/logs' },
  ])('resolves directory $expected', async ({ override, home, expected }) => {
    expect((await writer()).pluginLogDir(override, home, 'auto-effort')).toBe(expected);
  });

  it.each([
    { msg: '🙂'.repeat(5000), detail: { error: 'e'.repeat(5000) } },
    { msg: 'ok', detail: { error: 'x'.repeat(5000) } },
    { msg: '\n\"\\'.repeat(5000), detail: undefined },
  ])('caps escaped and UTF-8 rows while marking dropped detail', async ({ msg, detail }) => {
    const { levelRow, ROW_MAX_BYTES } = await writer();
    const fullBytes = Buffer.byteLength(`${JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', ...fields, msg, ...(detail ? { detail } : {}) })}\n`);
    const row = levelRow({ ...fields, msg, detail }, NOW);
    expect(ROW_MAX_BYTES).toBe(4096);
    expect(Buffer.byteLength(row)).toBeLessThanOrEqual(ROW_MAX_BYTES);
    expect(JSON.parse(row).detail).toEqual({ truncated: true, bytes: fullBytes });
    expect(JSON.parse(row).msg).not.toContain('�');
  });

  it('bounds metadata as well as the message', async () => {
    const { levelRow } = await writer();
    const row = levelRow({ ...fields, where: `hooks/${'🙂'.repeat(5000)}#checkCall`, session: 's'.repeat(10000) }, NOW);
    expect(Buffer.byteLength(row)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(row)).toMatchObject({ level: 'error', event: 'check-failed', detail: { truncated: true } });
  });
});

describe('plugin log append door', () => {
  it.each([
    { name: 'ASCII', session: 's'.repeat(3900) },
    { name: 'escaped', session: '"\\\n'.repeat(650) },
    { name: 'UTF-8', session: '🙂'.repeat(975) },
    { name: 'previously rejected', session: 's'.repeat(3922) },
  ])('bounds cascading cap notices and retains the session key: $name', async ({ session }) => {
    const { levelRow, appendArgv } = await writer();
    const dir = await temp();
    const before = Buffer.alloc(20971521, 'x');
    for (const file of ['errors.jsonl', 'warnings.jsonl']) await writeFile(join(dir, file), before);
    const row = levelRow({ ...fields, event: '', msg: '', where: '', session }, NOW);
    expect(JSON.parse(row).session).toBe(session);
    expect(await run(appendArgv(dir, PLUGIN, [row])[0]!)).toMatchObject({ exitCode: 0 });
    const lines = (await readFile(join(dir, 'warnings.jsonl'), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const [index, line] of lines.entries()) {
      expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(4096);
      expect(JSON.parse(line)).toMatchObject({ plugin: PLUGIN, level: 'warning', event: 'log-capped', where: 'src/plugin-log.ts#APPEND_SCRIPT', session: Array.from(session).slice(0, 64).join(''), detail: { file: ['warnings.jsonl', 'errors.jsonl'][index], bytes: 20971521 } });
      expect((await readFile(join(dir, `${['warnings.jsonl', 'errors.jsonl'][index]}.1`))).equals(before)).toBe(true);
    }
    expect(await readFile(join(dir, 'errors.jsonl'), 'utf8')).toBe(row);
  });
  it('appends three exact rows through real sh, keeps argv literal and sets private modes', async () => {
    const { levelRow, appendArgv, APPEND_SCRIPT } = await writer();
    const dir = join(await temp(), "logs with spaces ' $(not-a-command)");
    const rows = (['error', 'warning', 'info'] as const).map((level) => levelRow({ ...fields, level, msg: "quotes ' $(touch nope)\nsecond line" }, NOW));
    const [argv] = appendArgv(dir, PLUGIN, rows);
    expect(argv!.slice(0, 4)).toEqual(['/bin/sh', '-c', APPEND_SCRIPT, 'plugin-log']);
    expect(await run(argv!)).toMatchObject({ exitCode: 0 });
    for (const [index, file] of ['errors', 'warnings', 'info'].entries()) {
      expect(await readFile(join(dir, `${file}.jsonl`), 'utf8')).toBe(rows[index]);
      expect((await stat(join(dir, `${file}.jsonl`))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('caps each level by moving to .1 and records exact log-capped warning', async () => {
    const { levelRow, appendArgv, PLUGIN_LOG_CAP_BYTES } = await writer();
    expect(PLUGIN_LOG_CAP_BYTES).toBe(20971520);
    for (const level of ['error', 'warning', 'info'] as const) {
      const dir = join(await temp(), level);
      await mkdir(dir);
      const file = { error: 'errors.jsonl', warning: 'warnings.jsonl', info: 'info.jsonl' }[level];
      const before = Buffer.alloc(20971521, 'x');
      await writeFile(join(dir, file), before);
      await writeFile(join(dir, `${file}.1`), 'older');
      const row = levelRow({ ...fields, level }, NOW);
      expect(await run(appendArgv(dir, PLUGIN, [row])[0]!)).toMatchObject({ exitCode: 0 });
      expect((await readFile(join(dir, `${file}.1`))).equals(before)).toBe(true);
      const warnings = (await readFile(join(dir, 'warnings.jsonl'), 'utf8')).trim().split('\n').map((r) => JSON.parse(r));
      expect(warnings.filter((r) => r.event === 'log-capped')).toEqual([expect.objectContaining({ plugin: PLUGIN, level: 'warning', where: 'src/plugin-log.ts#APPEND_SCRIPT', detail: { file, bytes: 20971521 } })]);
      const actual = await readFile(join(dir, file), 'utf8');
      expect(actual.endsWith(row)).toBe(true);
    }
  });

  it.skipIf(process.getuid?.() === 0)('returns a path-bearing error for chmod-500 directory (skip-because:superuser)', async () => {
    const { levelRow, appendArgv } = await writer();
    const dir = await temp();
    await chmod(dir, 0o500);
    try {
      const result = await run(appendArgv(dir, PLUGIN, [levelRow(fields, NOW)])[0]!);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(dir);
      expect((await stat(dir)).mode & 0o777).toBe(0o500);
    } finally { await chmod(dir, 0o700); }
    const deniedDir = await temp();
    await chmod(deniedDir, 0o755);
    const deniedFile = join(deniedDir, 'errors.jsonl');
    await writeFile(deniedFile, 'kept');
    await chmod(deniedFile, 0o400);
    try {
      const result = await run(appendArgv(deniedDir, PLUGIN, [levelRow(fields, NOW)])[0]!);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(deniedFile);
      expect((await stat(deniedDir)).mode & 0o777).toBe(0o755);
      expect((await stat(deniedFile)).mode & 0o777).toBe(0o400);
      expect(await readFile(deniedFile, 'utf8')).toBe('kept');
    } finally { await chmod(deniedFile, 0o600); }
  });

  it('keeps concurrent append rows whole', async () => {
    const { levelRow, appendArgv } = await writer();
    const dir = await temp();
    const rows = Array.from({ length: 130 }, (_, i) => levelRow({ ...fields, msg: `row-${i}` }, NOW));
    const results = await Promise.all(appendArgv(dir, PLUGIN, rows).map(run));
    expect(results.map((r) => r.exitCode)).toEqual([0, 0, 0]);
    const actual = (await readFile(join(dir, 'errors.jsonl'), 'utf8')).trim().split('\n');
    expect(actual.map((r) => JSON.parse(r).msg).sort()).toEqual(rows.map((r) => JSON.parse(r).msg).sort());
  });
});

describe('plugin log queue', () => {
  it('serializes 64-row batches, drains work and avoids empty forks', async () => {
    const { PluginLogQueue, levelRow } = await writer();
    const queue = new PluginLogQueue('/x/logs', PLUGIN, () => {});
    let active = 0;
    const sizes: number[] = [];
    const processRun = async (argv: readonly string[]) => {
      expect(active++).toBe(0);
      sizes.push((argv.length - 6) / 3);
      await Promise.resolve();
      active--;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    expect(await queue.flush(processRun)).toEqual({ written: 0, dropped: 0 });
    for (let i = 0; i < 130; i++) queue.add(levelRow(fields, NOW));
    const first = queue.flush(processRun);
    queue.add(levelRow(fields, NOW));
    const second = queue.flush(processRun);
    expect(await first).toEqual({ written: 130, dropped: 0 });
    expect(await second).toEqual({ written: 1, dropped: 0 });
    expect(sizes).toEqual([64, 64, 2, 1]);
  });

  it.each(['reject', 'nonzero', 'missing'] as const)('drops failures and re-arms a single fallback after recovery: %s', async (failure) => {
    const { PluginLogQueue, levelRow } = await writer();
    const notices: string[] = [];
    const queue = new PluginLogQueue('/x/logs', PLUGIN, (text: string) => notices.push(text));
    const bad = failure === 'missing' ? undefined : async () => {
      if (failure === 'reject') throw new Error('cannot start');
      return { exitCode: 1, stdout: '', stderr: 'permission denied\nmore' };
    };
    for (let i = 0; i < 2; i++) {
      queue.add(levelRow(fields, NOW));
      expect(await queue.flush(bad)).toEqual({ written: 0, dropped: 1 });
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('/x/logs');
    expect(notices[0]).toMatch(/cannot start|permission denied|process.run/);
    queue.add(levelRow(fields, NOW));
    expect(await queue.flush(async () => ({ exitCode: 0, stdout: '', stderr: '' }))).toEqual({ written: 1, dropped: 0 });
    queue.add(levelRow(fields, NOW));
    await queue.flush(bad);
    expect(notices).toHaveLength(2);
  });

  it.each(['no directory', 'write failure'] as const)('shows every warning and info diagnostic when there is %s', async (failure) => {
    const { PluginLogQueue, levelRow } = await writer();
    const notices: string[] = [];
    const queue = new PluginLogQueue(failure === 'no directory' ? undefined : '/x/logs', PLUGIN, (text) => notices.push(text));
    for (const level of ['warning', 'info'] as const) {
      queue.add(levelRow({ ...fields, level, msg: `${level} must not vanish` }, NOW));
      expect(await queue.flush(async () => ({ exitCode: 1, stdout: '', stderr: 'disk full' }))).toEqual({ written: 0, dropped: 1 });
    }
    expect(notices.filter((line) => line.includes('plugin log '))).toHaveLength(1);
    expect(notices).toContain('warning must not vanish');
    expect(notices).toContain('info must not vanish');
  });

  it('reports no-home explicitly without throwing even when the fallback itself throws', async () => {
    const { PluginLogQueue, levelRow } = await writer();
    const notices: string[] = [];
    const queue = new PluginLogQueue(undefined, PLUGIN, (text: string) => { notices.push(text); throw new Error('screen off'); });
    queue.add(levelRow(fields, NOW));
    expect(await queue.flush(undefined)).toEqual({ written: 0, dropped: 1 });
    expect(notices[0]).toContain('plugin log off: no PLUGIN_LOG_DIR and no HOME');
  });
});

it.skipIf(process.getuid?.() === 0)('reports a cap inspection failure instead of appending to a write-only file (skip-because:superuser)', async () => {
  const { levelRow, appendArgv } = await writer();
  const dir = await temp();
  const file = join(dir, 'errors.jsonl');
  await writeFile(file, 'original');
  await chmod(file, 0o200);
  try {
    const result = await run(appendArgv(dir, PLUGIN, [levelRow(fields, NOW)])[0]!);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(file);
    await chmod(file, 0o600);
    expect(await readFile(file, 'utf8')).toBe('original');
  } finally { await chmod(file, 0o600); }
});

it('preserves only the canonical triggering session in every cascading cap notice', async () => {
  const { levelRow, appendArgv } = await writer();
  const actual: Array<Array<{ file: string; session?: string; hasSession: boolean }>> = [];
  const expected: typeof actual = [];
  const samples = [
    { session: '5f0c2a', detail: { session: 'fake detail session' } },
    { session: 'quotes " backslash \\ newline\nend', detail: { session: 'fake " \\ \n' } },
    { session: undefined, detail: { session: 'fake top-level session', nested: { session: 'fake nested session' } } },
  ];
  for (const sample of samples) {
    const dir = await temp();
    for (const file of ['errors.jsonl', 'warnings.jsonl']) {
      await writeFile(join(dir, file), Buffer.alloc(20971521, 'x'));
    }
    const row = levelRow({ ...fields, ...sample, msg: 'field-looking text ,"session":"fake", "detail": {"session":"fake"}', where: 'src/plugin-log.ts#check "session": "fake"' }, NOW);
    const [argv] = appendArgv(dir, PLUGIN, [row]);
    expect(argv!.slice(4)).toEqual([dir, PLUGIN, 'errors.jsonl', row, sample.session === undefined ? '' : `,"session":${JSON.stringify(sample.session)}`]);
    expect(await run(argv!)).toMatchObject({ exitCode: 0 });
    const notices = (await readFile(join(dir, 'warnings.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(notices.map((notice) => notice.event)).toEqual(['log-capped', 'log-capped']);
    actual.push(notices.map((notice) => ({ file: notice.detail.file, ...(Object.hasOwn(notice, 'session') ? { session: notice.session } : {}), hasSession: Object.hasOwn(notice, 'session') })));
    expected.push(['warnings.jsonl', 'errors.jsonl'].map((file) => ({ file, ...(sample.session === undefined ? {} : { session: sample.session }), hasSession: sample.session !== undefined })));
  }
  expect(actual).toEqual(expected);
});
