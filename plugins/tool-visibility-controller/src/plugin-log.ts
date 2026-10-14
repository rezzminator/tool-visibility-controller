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
if [ -L "$dir" ]; then echo "plugin log $dir: directory is a symlink" >&2; exit 1; fi
for leaf in errors.jsonl errors.jsonl.1 warnings.jsonl warnings.jsonl.1 info.jsonl info.jsonl.1; do
  if [ -L "$dir/$leaf" ]; then echo "plugin log $dir/$leaf: level endpoint is a symlink" >&2; exit 1; fi
done
if [ -e "$dir" ] && { [ ! -d "$dir" ] || [ ! -w "$dir" ] || [ ! -x "$dir" ]; }; then
  printf 'plugin log directory not writable: %s\\n' "$dir" >&2
  exit 1
fi
mkdir -p "$dir"
log_files='errors.jsonl errors.jsonl.1 warnings.jsonl warnings.jsonl.1 info.jsonl info.jsonl.1'
# Inspect original access before chmod can grant previously denied access.
for existing in $log_files; do
  if [ -e "$dir/$existing" ] && { [ ! -f "$dir/$existing" ] || [ ! -r "$dir/$existing" ] || [ ! -w "$dir/$existing" ]; }; then
    printf 'plugin log file not readable and writable: %s/%s\\n' "$dir" "$existing" >&2
    exit 1
  fi
done
chmod 700 "$dir"
for existing in $log_files; do
  if [ -e "$dir/$existing" ]; then chmod 600 "$dir/$existing"; fi
done
render_cap_notice() {
  printf '{"ts":"%s","plugin":"%s","level":"warning","event":"log-capped","msg":"%s","where":"src/plugin-log.ts#APPEND_SCRIPT"%s%s}' "$stamp" "$plugin" "$cap_msg" "$session_fragment" "$cap_detail"
}
# Keep each prepared notice local while a warnings cap is handled recursively.
cap_file() (
  if [ ! -f "$dir/$1" ]; then return; fi
  size=$(wc -c < "$dir/$1")
  if [ "$size" -gt ${PLUGIN_LOG_CAP_BYTES} ]; then
    archived_size=$size
    stamp=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    cap_full_msg='level file moved aside after reaching the cap'
    cap_msg=$cap_full_msg
    cap_detail=$(printf ',"detail":{"file":"%s","bytes":%s}' "$1" "$archived_size")
    cap_notice=$(render_cap_notice)
    cap_bytes=$(printf '%s\\n' "$cap_notice" | wc -c)
    if [ "$cap_bytes" -gt ${ROW_MAX_BYTES} ]; then
      cap_detail=$(printf ',"detail":{"truncated":true,"bytes":%s}' "$cap_bytes")
      cap_msg=''
      cap_notice=$(render_cap_notice)
      cap_bytes=$(printf '%s\\n' "$cap_notice" | wc -c)
      if [ "$cap_bytes" -gt ${ROW_MAX_BYTES} ]; then
        cap_detail=''
        cap_notice=$(render_cap_notice)
        cap_bytes=$(printf '%s\\n' "$cap_notice" | wc -c)
      fi
      if [ "$cap_bytes" -gt ${ROW_MAX_BYTES} ]; then
        printf 'plugin log %s/warnings.jsonl: session exceeds cap notice byte budget\\n' "$dir" >&2
        exit 1
      fi
      # Only this fixed ASCII message is cut, never serialized session DATA.
      remaining=$((${ROW_MAX_BYTES} - cap_bytes))
      if [ "$remaining" -gt 0 ]; then
        cap_msg=$(printf '%s' "$cap_full_msg" | cut -c "1-$remaining")
      fi
      cap_notice=$(render_cap_notice)
    fi
    # Refuse an impossible parent or cascading notice before moving either file.
    if [ "$1" != warnings.jsonl ]; then cap_file warnings.jsonl; fi
    mv -f "$dir/$1" "$dir/$1.1"
    printf '%s\\n' "$cap_notice" >> "$dir/warnings.jsonl"
  fi
)
while [ "$#" -gt 0 ]; do
  file=$1
  row=$2
  shift 2
  case "$file" in errors.jsonl|warnings.jsonl|info.jsonl) ;; *) printf 'invalid plugin log file: %s/%s\\n' "$dir" "$file" >&2; exit 2 ;; esac
  # levelRow's canonical header puts session before detail. Escaped JSON
  # strings cannot imitate these unescaped property boundaries. This is
  # serialized JSON DATA for printf, never evaluated as shell source.
  detail_key=',"detail":'
  session_key=',"session":'
  header=\${row%?}
  header=\${header%'}'}
  header=\${header%%"$detail_key"*}
  session_fragment=''
  case "$header" in
    *"$session_key"*) session_fragment="$session_key\${header#*"$session_key"}" ;;
  esac
  cap_file "$file"
  printf '%s' "$row" >> "$dir/$file"
done`;

export function appendArgv(dir: string, plugin: string, rows: readonly string[]): string[][] {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plugin)) throw new Error(`invalid plugin log name: ${plugin}`);
  const commands: string[][] = [];
  for (let i = 0; i < rows.length; i += 64) {
    const argv = ['/bin/sh', '-c', APPEND_SCRIPT, 'plugin-log', dir, plugin];
    for (const row of rows.slice(i, i + 64)) {
      const level = JSON.parse(row).level as Level;
      if (!Object.hasOwn(FILES, level)) throw new Error(`invalid plugin log level: ${String(level)}`);
      argv.push(FILES[level], row);
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

  private failure(error: unknown, dropped: number): void {
    if (this.failing) return;
    this.failing = true;
    const cause = error instanceof Error ? error.message : String(error);
    const text = this.dir === undefined
      ? 'plugin log off: no PLUGIN_LOG_DIR and no HOME'
      : `plugin log ${this.dir}: ${cause}; dropped ${dropped} row(s)`;
    try { this.notice(text); } catch {
      // The last-resort screen door can itself be unavailable. Its failure
      // must not escape into the policy result, and no other I/O door exists.
    }
  }

  flush(run: ProcessRun | undefined): Promise<FlushResult> {
    const rows = this.rows.splice(0);
    const task = this.chain.then(async () => {
      const result: FlushResult = { written: 0, dropped: 0 };
      if (rows.length === 0) return result;
      if (this.dir === undefined) {
        this.failure('no directory', rows.length);
        return { written: 0, dropped: rows.length };
      }
      let commands: string[][];
      try { commands = appendArgv(this.dir, this.plugin, rows); } catch (error) {
        this.failure(error, rows.length);
        return { written: 0, dropped: rows.length };
      }
      for (const argv of commands) {
        const count = (argv.length - 6) / 2;
        try {
          if (!run) throw new Error('process.run is unavailable');
          const response = await run(argv);
          if (response.exitCode !== 0) throw new Error(`exit ${response.exitCode}: ${response.stderr.split('\n')[0] || 'append failed'}`);
          this.failing = false;
          result.written += count;
        } catch (error) {
          this.failure(error, count);
          result.dropped += count;
        }
      }
      return result;
    });
    this.chain = task;
    return task;
  }
}
