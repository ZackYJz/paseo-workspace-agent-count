/**
 * Status vocabulary → label, tone, and sort rank.
 *
 * The overview renders every agent in every workspace, so one status has to read
 * the same way in every row and sort the same way in every list. Keeping the
 * mapping here makes it testable without React Native and keeps the precedence
 * rules in a single place instead of scattered across JSX conditionals.
 *
 * Labels are Chinese because every other string this plugin contributes is.
 */

export type Tone = "danger" | "warning" | "success" | "accent" | "muted";

export interface StateMeta {
  readonly label: string;
  readonly tone: Tone;
  /** Lower sorts first, so actionable states lead the list. */
  readonly rank: number;
}

/**
 * The agent fields presentation depends on.
 *
 * Declared structurally for the same reason as `TallyAgent`: shared code
 * compiles into the app bundle too, so it cannot import host SDK types. Both
 * runtimes pass richer objects that satisfy this.
 */
export interface PresentedAgent {
  status: string;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  archivedAt?: string | null;
}

const ARCHIVED: StateMeta = { label: "已归档", tone: "muted", rank: 60 };
const PERMISSION: StateMeta = { label: "等待授权", tone: "danger", rank: 0 };
const ERROR: StateMeta = { label: "出错", tone: "danger", rank: 1 };
const NEEDS_ATTENTION: StateMeta = { label: "需要处理", tone: "warning", rank: 2 };
const RUNNING: StateMeta = { label: "运行中", tone: "accent", rank: 10 };
const INITIALIZING: StateMeta = { label: "启动中", tone: "accent", rank: 11 };
const FINISHED: StateMeta = { label: "已完成", tone: "success", rank: 20 };
const IDLE: StateMeta = { label: "空闲", tone: "muted", rank: 40 };
const CLOSED: StateMeta = { label: "已关闭", tone: "muted", rank: 50 };

/**
 * Resolves one agent to a single state.
 *
 * Precedence is deliberate:
 * - Archived outranks everything. An archived agent is retained for the count but
 *   cannot be acted on, so it must not borrow a live agent's urgency.
 * - A concrete `attentionReason` beats the bare `requiresAttention` flag, and
 *   both beat `status`, because the host states *why* it wants attention.
 * - A live status beats `finished`: an agent still emitting output is not done,
 *   whatever a stale attention reason says.
 */
export function agentState(agent: PresentedAgent): StateMeta {
  if (agent.archivedAt != null && agent.archivedAt !== "") return ARCHIVED;
  if (agent.attentionReason === "permission") return PERMISSION;
  if (agent.attentionReason === "error" || agent.status === "error") return ERROR;
  if (agent.requiresAttention === true) return NEEDS_ATTENTION;
  if (agent.status === "running") return RUNNING;
  if (agent.status === "initializing") return INITIALIZING;
  if (agent.attentionReason === "finished") return FINISHED;
  if (agent.status === "closed") return CLOSED;
  return IDLE;
}

/**
 * Resolves the host's own workspace roll-up status.
 *
 * This is Paseo's judgement, not a re-derivation from agents, so the overview
 * agrees with the native sidebar instead of contradicting it.
 */
export function workspaceState(status: string | null | undefined): StateMeta {
  switch (status) {
    case "needs_input":
      return { label: "需要输入", tone: "danger", rank: 0 };
    case "failed":
      return { label: "失败", tone: "danger", rank: 1 };
    case "attention":
      return { label: "需要处理", tone: "warning", rank: 2 };
    case "running":
      return RUNNING;
    case "done":
      return FINISHED;
    default:
      return IDLE;
  }
}

/**
 * Whether a state earns a badge.
 *
 * Resting states are the common case; badging them would drown the few rows that
 * actually ask for something. Success and muted tones stay unbadged.
 */
export function isNotable(meta: StateMeta): boolean {
  return meta.tone === "danger" || meta.tone === "warning" || meta.tone === "accent";
}

export interface AgentStateSummary {
  /** Agents in a danger or warning state: something is waiting on you. */
  attention: number;
  /** Agents mid-turn. */
  running: number;
  total: number;
}

export function summarizeAgentStates(states: readonly StateMeta[]): AgentStateSummary {
  let attention = 0;
  let running = 0;
  for (const state of states) {
    if (state.tone === "danger" || state.tone === "warning") attention++;
    else if (state.tone === "accent") running++;
  }
  return { attention, running, total: states.length };
}

/**
 * Whether a per-row column is worth rendering.
 *
 * A column that reads the same on every row is noise rather than information, so
 * the provider tag only appears once the directory actually mixes providers.
 */
export function hasMixedValues(values: Iterable<string>): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    // An absent value is not a second value. Agents recorded before the field
    // existed carry an empty provider; counting it would open a column that then
    // reads the same on every row.
    if (value === "") continue;
    seen.add(value);
    if (seen.size > 1) return true;
  }
  return false;
}

/** Actionable first, then oldest first so long-waiting agents surface. */
export function compareAgents<A extends PresentedAgent & { createdAt: string }>(a: A, b: A): number {
  return (
    agentState(a).rank - agentState(b).rank || a.createdAt.localeCompare(b.createdAt)
  );
}

/** Needs-attention first, then busiest, then alphabetical for a stable order. */
export function compareWorkspaces<W extends { status: string | null; count: number; name: string }>(
  a: W,
  b: W,
): number {
  return (
    workspaceState(a.status).rank - workspaceState(b.status).rank ||
    b.count - a.count ||
    a.name.localeCompare(b.name)
  );
}
