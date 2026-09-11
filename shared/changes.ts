/**
 * Change detection for directory events.
 *
 * Both runtimes watch the same two directories. They must agree on what counts
 * as a change, or one of them refreshes on noise the other ignores. Streaming
 * output rewrites `updatedAt` and `activityAt` on every fragment without
 * changing anything a count depends on, so those fields are deliberately
 * excluded: only lifecycle and identity fields are keyed.
 */

export interface AgentChangeFields {
  workspaceId?: string | null;
  status: string;
  archivedAt?: string | null;
}

export interface WorkspaceChangeFields {
  title?: string | null;
  name: string;
  archivingAt?: string | null;
}

export function agentChangeKey(agent: AgentChangeFields): string {
  return JSON.stringify([agent.workspaceId ?? null, agent.status, agent.archivedAt ?? null]);
}

export function workspaceChangeKey(workspace: WorkspaceChangeFields): string {
  return JSON.stringify([workspace.title ?? null, workspace.name, workspace.archivingAt ?? null]);
}
