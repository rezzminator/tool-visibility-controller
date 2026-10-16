/**
 * Tells a fresh spawn from a resume. A fresh spawn is an Agent tool call's own:
 * its `tool.call` fires first under the same tool_use_id. A resume (a wake when
 * an agent's children finish, or a message sent to a finished agent) raises
 * `agent.spawn` outside any Agent tool call, under the loop doing the resuming,
 * which is not the agent's parent, so gating it by that loop refuses the
 * agent's own resume and the engine drops the notices it was woken for.
 */
export class SpawnCalls {
  private readonly open = new Set<string>();

  constructor(private readonly cap = 512) {}

  /** Records an Agent tool call about to spawn. */
  note(toolUseId: string): void {
    if (toolUseId === '') return;
    this.open.add(toolUseId);
    while (this.open.size > this.cap) this.open.delete(this.open.values().next().value as string);
  }

  /** True once for the spawn of a noted call; a resume, never noted or already spawned, is false. */
  claim(toolUseId: string | undefined): boolean {
    if (toolUseId === undefined || !this.open.has(toolUseId)) return false;
    this.open.delete(toolUseId);
    return true;
  }
}
