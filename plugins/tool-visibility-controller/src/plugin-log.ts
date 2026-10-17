/** Standalone JSONL plugin logs; the adapter owns all engine API calls. */
export const PLUGIN_LOG_CAP_BYTES = 20971520;
export const ROW_MAX_BYTES = 4096;

export type Level = 'error' | 'warning' | 'info';
export type LevelFields = {
  plugin: string;
  level: Level;
  event: string;
  msg: string;
  where: string;
  session?: string;
  detail?: Record<string, unknown>;
};
export type ProcessResult = { exitCode: number; stdout: string; stderr: string };
export type ProcessRun = (argv: readonly string[]) => Promise<ProcessResult>;
export type FlushResult = { written: number; dropped: number };
const FILES: Record<Level, string> = { error: 'errors.jsonl', warning: 'warnings.jsonl', info: 'info.jsonl' };
const bytes = (text: string) => new TextEncoder().encode(text).length;

export function pluginLogDir(override: string | undefined, home: string | undefined, plugin: string): string | undefined {
  const root = override || home;
  if (!root) return undefined;
  const base = root.replace(/\/+$/, '');
  return override ? `${base}/${plugin}` : `${base}/.local/state/${plugin}/logs`;
}

/** Keep JSON key order and count UTF-8 bytes, including the newline. */
export function levelRow(fields: LevelFields, nowMs: number): string {
  const row = {
    ts: new Date(nowMs).toISOString(),
    plugin: fields.plugin,
    level: fields.level,
    event: fields.event,
    msg: fields.msg,
    where: fields.where,
    ...(fields.session ? { session: fields.session } : {}),
    ...(fields.detail === undefined ? {} : { detail: fields.detail }),
  };
  const encode = () => `${JSON.stringify(row)}\n`;
  const original = encode();
  if (bytes(original) <= ROW_MAX_BYTES) return original;
  row.detail = { truncated: true, bytes: bytes(original) };
  // Paths and identifiers can dominate the row, not just its message.
  row.plugin = Array.from(row.plugin).slice(0, 64).join('');
  row.event = Array.from(row.event).slice(0, 64).join('');
  row.where = Array.from(row.where).slice(0, 256).join('');
  if (row.session) row.session = Array.from(row.session).slice(0, 64).join('');
  const msg = Array.from(row.msg);
  let low = 0;
  let high = msg.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    row.msg = msg.slice(0, mid).join('');
    if (bytes(encode()) <= ROW_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  row.msg = msg.slice(0, low).join('');
  return encode();
}

/** Literal argv only. Rename-aside cap races are deliberately not locked. */
export const APPEND_SCRIPT = `set -eu
umask 077
dir=$1
plugin=$2
shift 2
mkdir -p "$dir"
# The session fragment is JSON data bounded by levelRow, never shell source.
cap_file() (
  if [ ! -f "$dir/$1" ]; then return; fi
  size=$(wc -c < "$dir/$1")
  if [ "$size" -gt ${PLUGIN_LOG_CAP_BYTES} ]; then
    archived_size=$size
    if [ "$1" != warnings.jsonl ]; then cap_file warnings.jsonl; fi
    mv -f "$dir/$1" "$dir/$1.1"
    stamp=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    printf '{"ts":"%s","plugin":"%s","level":"warning","event":"log-capped","msg":"level file moved aside after reaching the cap","where":"src/plugin-log.ts#APPEND_SCRIPT"%s,"detail":{"file":"%s","bytes":%s}}\\n' "$stamp" "$plugin" "$session_fragment" "$1" "$archived_size" >> "$dir/warnings.jsonl"
  fi
)
while [ "$#" -gt 0 ]; do
  file=$1
  row=$2
  session_fragment=$3
  shift 3
  case "$file" in errors.jsonl|warnings.jsonl|info.jsonl) ;; *) printf 'invalid plugin log file: %s/%s\\n' "$dir" "$file" >&2; exit 2 ;; esac
  cap_file "$file"
  printf '%s' "$row" >> "$dir/$file"
done`;

export function appendArgv(dir: string, plugin: string, rows: readonly string[]): string[][] {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plugin)) throw new Error(`invalid plugin log name: ${plugin}`);
  const commands: string[][] = [];
  for (let i = 0; i < rows.length; i += 64) {
    const argv = ['/bin/sh', '-c', APPEND_SCRIPT, 'plugin-log', dir, plugin];
    for (const row of rows.slice(i, i + 64)) {
      const parsed = JSON.parse(row) as LevelFields & { ts: string };
      const level = parsed.level;
      if (!Object.hasOwn(FILES, level)) throw new Error(`invalid plugin log level: ${String(level)}`);
      // Reserve the longest filename and a 19-digit filesystem byte count.
      // Reuse the row truncation rule for pathological session values.
      const cap = JSON.parse(levelRow({ plugin, level: 'warning', event: 'log-capped', msg: 'level file moved aside after reaching the cap', where: 'src/plugin-log.ts#APPEND_SCRIPT', session: parsed.session, detail: { file: 'warnings.jsonl', bytes: 2 ** 63 } }, Date.parse(parsed.ts))) as LevelFields;
      const session = cap.session ? `,"session":${JSON.stringify(cap.session)}` : '';
      argv.push(FILES[level], row, session);
    }
    commands.push(argv);
  }
  return commands;
}

/** Each flush drains a snapshot, drops failed batches, and never rejects. */
export class PluginLogQueue {
  private rows: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private failing = false;

  constructor(private dir: string | undefined, private plugin: string, private notice: (text: string) => void) {}

  add(row: string): void { this.rows.push(row); }

  private show(text: string): void {
    try { this.notice(text); } catch {
      // No other screen door exists, and logging must not alter policy.
    }
  }

  private dropped(rows: readonly string[]): FlushResult {
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row) as LevelFields;
        // Errors already reached the screen synchronously in the adapter.
        if (parsed.level !== 'error') this.show(parsed.msg);
      } catch (error) {
        this.show(`plugin log fallback: ${error instanceof Error ? error.message : String(error)}; row: ${row}`);
      }
    }
    return { written: 0, dropped: rows.length };
  }

  private failure(error: unknown, dropped: number): void {
    if (this.failing) return;
    this.failing = true;
    const cause = error instanceof Error ? error.message : String(error);
    const text = this.dir === undefined
      ? 'plugin log off: no PLUGIN_LOG_DIR and no HOME'
      : `plugin log ${this.dir}: ${cause}; dropped ${dropped} row(s)`;
    this.show(text);
  }

  flush(run: ProcessRun | undefined): Promise<FlushResult> {
    const rows = this.rows.splice(0);
    const task = this.chain.then(async () => {
      const result: FlushResult = { written: 0, dropped: 0 };
      if (rows.length === 0) return result;
      if (this.dir === undefined) {
        this.failure('no directory', rows.length);
        return this.dropped(rows);
      }
      let commands: string[][];
      try { commands = appendArgv(this.dir, this.plugin, rows); } catch (error) {
        this.failure(error, rows.length);
        return this.dropped(rows);
      }
      for (const argv of commands) {
        const count = (argv.length - 6) / 3;
        try {
          if (!run) throw new Error('process.run is unavailable');
          const response = await run(argv);
          if (response.exitCode !== 0) throw new Error(`exit ${response.exitCode}: ${response.stderr.split('\n')[0] || 'append failed'}`);
          this.failing = false;
          result.written += count;
        } catch (error) {
          this.failure(error, count);
          const start = result.written + result.dropped;
          result.dropped += this.dropped(rows.slice(start, start + count)).dropped;
        }
      }
      return result;
    });
    this.chain = task;
    return task;
  }
}
