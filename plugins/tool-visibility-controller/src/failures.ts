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

/** An engine-owned loop (a fork of its own: compaction, memory) carries an id no agent list row or announcement names; no rule governs it. */
export function engineLoopText(agentId: string, action: string): string {
  return `tool-visibility-controller: loop ${agentId} is the engine's own (no agent list row or SubagentStart names it) while ${action}; no visibility rule governs it, its listings, spawns and tool calls are left whole`;
}

export function hookFailureText(hook: string, failure: Pick<HookFailure, 'kind' | 'message'>, context: string): string {
  return `${hook} failed; proceeding unchecked (${context}; ${failure.kind}: ${failure.message ?? 'engine supplied no failure message'})`;
}

/** A Skill call whose skill argument names nothing: only the Skill tool itself is checked. */
export function skillUnnamedText(skill: unknown, loop: string): string {
  const what = skill === undefined || skill === null ? 'absent' : typeof skill === 'string' ? 'blank' : `a ${typeof skill}`;
  return `tool-visibility-controller: a Skill call from loop ${loop} names no skill (its skill argument is ${what}); only the Skill tool itself is checked`;
}

/** The agent list could not be read: the loop takes the type SubagentStart announced, else it is unknown and goes unchecked. */
export function agentListFailedText(agentId: string, action: string, reason: string, type: string | undefined): string {
  return `tool-visibility-controller: listing agents failed: ${reason} while ${action}; loop ${agentId} ${type ? `takes its announced type ${type}` : 'is treated as unknown'}`;
}
