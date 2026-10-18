/** Collapses a burst of identical screen lines into the first plus a count. */
export const BURST_WINDOW_MS = 30000;
const MAX_RUNS = 200;

type Run = { shownAt: number; suppressed: number };
const summary = (text: string, suppressed: number) => `${text} (and ${suppressed} more)`;

export class ScreenBurst {
  private runs = new Map<string, Run>();

  /** The lines to show now: the text when it opens a burst, preceded by the summary of the burst it follows; nothing for a repeat inside the window. */
  offer(text: string, nowMs: number): string[] {
    const run = this.runs.get(text);
    if (run !== undefined && nowMs - run.shownAt < BURST_WINDOW_MS) {
      run.suppressed += 1;
      return [];
    }
    const shown = run !== undefined && run.suppressed > 0 ? [summary(text, run.suppressed)] : [];
    this.runs.delete(text);
    for (const [key, other] of this.runs) {
      if (other.suppressed === 0 && (nowMs - other.shownAt >= BURST_WINDOW_MS || this.runs.size >= MAX_RUNS)) this.runs.delete(key);
    }
    this.runs.set(text, { shownAt: nowMs, suppressed: 0 });
    return [...shown, text];
  }

  /** The summary of every burst with suppressed repeats; the next occurrence of each line is shown afresh. */
  drain(): string[] {
    const lines = [...this.runs].filter(([, run]) => run.suppressed > 0).map(([text, run]) => summary(text, run.suppressed));
    this.runs.clear();
    return lines;
  }

  /** Repeats suppressed and not yet summarised. */
  pending(): number {
    let total = 0;
    for (const run of this.runs.values()) total += run.suppressed;
    return total;
  }

  size(): number { return this.runs.size; }
}
