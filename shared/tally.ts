/**
 * The minimal agent shape the tally needs.
 *
 * Shared modules cannot import `@getpaseo/client` or `@getpaseo/plugin/server`
 * types, because shared code compiles into the app bundle too. Both runtimes
 * pass their richer SDK objects, which satisfy this structurally.
 */
export interface TallyAgent {
  id: string;
  /** Optional and nullable so both runtimes' SDK agent shapes satisfy this. */
  workspaceId?: string | null;
  status: string;
}

export interface AgentTally {
  /** Retained agent records per workspace ID, including archived and closed ones. */
  counts: Map<string, number>;
  /** Workspaces with an initializing or running agent. */
  busy: Set<string>;
}

const BUSY_STATUSES: ReadonlySet<string> = new Set(["initializing", "running"]);

/**
 * The single authoritative definition of "how many agents does this workspace
 * have". The title decoration, the overview surface, and the header button all
 * report this number, so they can never disagree.
 *
 * Agents without a workspace are skipped. A record repeated across overlapping
 * pages counts once.
 */
export function tallyAgents(agents: readonly TallyAgent[]): AgentTally {
  const counts = new Map<string, number>();
  const busy = new Set<string>();
  const seen = new Set<string>();
  for (const agent of agents) {
    if (!agent.workspaceId) continue;
    if (BUSY_STATUSES.has(agent.status)) busy.add(agent.workspaceId);
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    counts.set(agent.workspaceId, (counts.get(agent.workspaceId) ?? 0) + 1);
  }
  return { counts, busy };
}
