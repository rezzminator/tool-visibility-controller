// Failure classification and diagnostics, pure. Operational failures keep the
// documented fail-open result; the screen must say what was not checked and why.
import type { HookFailure } from 'claude-code';

export function message(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);
}

/** The worker may preserve an errno code or serialize it into the message. */
export function missingDefinition(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code === 'ENOENT';
  return /^ENOENT\b/.test(message(error));
}

export function unresolvedLoopText(agentId: string, action: string): string {
  return `tool-visibility-controller: loop ${agentId} resolves to no agent type while ${action}; proceeding unchecked: its listings, spawns and tool calls are left whole; restore its agent-list entry or SubagentStart type announcement to resume visibility checks`;
}

export function hookFailureText(hook: string, failure: Pick<HookFailure, 'kind' | 'message'>, context: string): string {
  return `${hook} failed; proceeding unchecked (${context}; ${failure.kind}: ${failure.message ?? 'engine supplied no failure message'})`;
}
