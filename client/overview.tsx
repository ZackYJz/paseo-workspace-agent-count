import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  agentState,
  compareAgents,
  compareWorkspaces,
  hasMixedValues,
  isNotable,
  summarizeAgentStates,
  workspaceState,
  type StateMeta,
  type Tone,
} from "../shared/presentation";
import { useDirectory, type AgentRow, type WorkspaceRow } from "./directory";

interface PreparedAgent {
  row: AgentRow;
  state: StateMeta;
  label: string;
}

interface PreparedWorkspace {
  row: WorkspaceRow;
  label: string;
  state: StateMeta;
  agents: PreparedAgent[];
}

interface PreparedGroup {
  project: string;
  count: number;
  workspaces: PreparedWorkspace[];
}

const UNTITLED = "(无标题)";
const NO_PROVIDER = "—";

/**
 * Resolves labels, states, and order once per snapshot.
 *
 * Map iteration preserves the daemon's project ordering, so sections appear in the
 * same order as the native sidebar; only rows inside a group are sorted.
 */
function prepare(workspaces: readonly WorkspaceRow[]): PreparedGroup[] {
  const groups = new Map<string, WorkspaceRow[]>();
  for (const workspace of workspaces) {
    const rows = groups.get(workspace.projectDisplayName) ?? [];
    rows.push(workspace);
    groups.set(workspace.projectDisplayName, rows);
  }
  return [...groups.entries()].map(([project, rows]) => {
    const prepared = [...rows].sort(compareWorkspaces).map(
      (row): PreparedWorkspace => ({
        row,
        label: row.title ?? row.name,
        state: workspaceState(row.status),
        agents: [...row.agents].sort(compareAgents).map(
          (agent): PreparedAgent => ({
            row: agent,
            state: agentState(agent),
            label: agent.title ?? UNTITLED,
          }),
        ),
      }),
    );
    return {
      project,
      count: prepared.reduce((sum, workspace) => sum + workspace.row.count, 0),
      workspaces: prepared,
    };
  });
}

export function Overview({ theme, layout, navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const { snapshot, error } = useDirectory(paseo);
  const compact = layout.compact;

  // One alignment axis: the card header and every agent row share the same
  // horizontal padding, the same gap, and a gutter exactly as wide as the count
  // badge. That puts each status dot under its count and every agent title under
  // its workspace title, with no guide line needed to imply the nesting.
  const padX = compact ? 10 : 12;
  const rowGap = compact ? 8 : 10;
  const badgeW = compact ? 22 : 26;

  const groups = useMemo(() => prepare(snapshot?.workspaces ?? []), [snapshot]);

  const summary = useMemo(
    () =>
      summarizeAgentStates(
        groups.flatMap((group) =>
          group.workspaces.flatMap((workspace) => workspace.agents.map((agent) => agent.state)),
        ),
      ),
    [groups],
  );

  // A column that reads the same on every row is noise, not information.
  const showProvider = useMemo(
    () =>
      hasMixedValues(
        groups.flatMap((group) =>
          group.workspaces.flatMap((workspace) =>
            workspace.agents.map((agent) => agent.row.provider),
          ),
        ),
      ),
    [groups],
  );

  const toneColor = useMemo<Record<Tone, string>>(
    () => ({
      danger: theme.colors.statusDanger,
      warning: theme.colors.statusWarning,
      success: theme.colors.statusSuccess,
      accent: theme.colors.accent,
      muted: theme.colors.foregroundMuted,
    }),
    [theme],
  );

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: {
        padding: compact ? 12 : 20,
        paddingBottom: 32,
        // Sections breathe more than the cards inside them, so the grouping
        // reads before the tiles do.
        gap: compact ? 12 : 16,
      },
      header: { gap: 6 },
      title: {
        color: theme.colors.foreground,
        fontSize: compact ? 18 : 22,
        fontWeight: "700" as const,
      },
      summaryRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 8,
      },
      chip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 8,
        paddingVertical: 3,
      },
      chipText: { fontSize: compact ? 11 : 12, fontWeight: "600" as const },
      dot: { width: 7, height: 7, borderRadius: 4 },
      total: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 13 },
      projectHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        marginBottom: compact ? 5 : 7,
      },
      project: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 11 : 12,
        fontWeight: "700" as const,
        textTransform: "uppercase" as const,
        letterSpacing: 0.8,
      },
      projectRule: { flex: 1, height: 1, backgroundColor: theme.colors.border },
      projectCount: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 11 : 12,
        fontVariant: ["tabular-nums" as const],
      },
      card: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden" as const,
      },
      cardWrap: { marginBottom: compact ? 6 : 8 },
      cardHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: rowGap,
        paddingVertical: compact ? 8 : 10,
        paddingHorizontal: padX,
      },
      // Deliberately quiet: a count is an index, not a verdict. Color is reserved
      // for state, so a wall of identical badges cannot drain the accent of
      // meaning.
      badge: {
        width: badgeW,
        paddingVertical: 2,
        borderRadius: badgeW / 2,
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface2,
      },
      badgeText: {
        fontSize: compact ? 11 : 12,
        fontWeight: "600" as const,
        color: theme.colors.foregroundMuted,
        fontVariant: ["tabular-nums" as const],
      },
      cardTitle: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: compact ? 13 : 14,
        fontWeight: "600" as const,
      },
      diff: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 10 : 11,
        fontVariant: ["tabular-nums" as const],
      },
      pill: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
      pillText: { fontSize: compact ? 10 : 11, fontWeight: "600" as const },
      agentList: { paddingBottom: compact ? 4 : 6 },
      // Same padding and gap as the header, plus a gutter as wide as the badge:
      // this is what keeps the two text columns on one axis.
      agentRow: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: rowGap,
        paddingVertical: compact ? 3 : 4,
        paddingHorizontal: padX,
      },
      gutter: {
        width: badgeW,
        alignItems: "center" as const,
        paddingTop: compact ? 4 : 5,
      },
      agentTitle: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: compact ? 12 : 13,
        lineHeight: compact ? 17 : 19,
      },
      dim: { color: theme.colors.foregroundMuted },
      agentState: {
        fontSize: compact ? 10 : 11,
        fontWeight: "600" as const,
        marginTop: compact ? 2 : 3,
      },
      provider: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 10 : 11,
        minWidth: 34,
        marginTop: compact ? 2 : 3,
        textAlign: "right" as const,
      },
      empty: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 12 : 13,
        paddingHorizontal: padX,
        paddingBottom: compact ? 8 : 10,
      },
      pressed: { opacity: 0.65 },
      notice: { color: theme.colors.foregroundMuted, fontSize: compact ? 13 : 14 },
      danger: { color: theme.colors.statusDanger, fontSize: compact ? 13 : 14 },
    }),
    [theme, compact, padX, rowGap, badgeW],
  );

  function summaryChips() {
    const chips: { tone: Tone; label: string }[] = [];
    if (summary.attention > 0) {
      chips.push({ tone: "danger", label: `需要处理 ${summary.attention}` });
    }
    if (summary.running > 0) chips.push({ tone: "accent", label: `运行中 ${summary.running}` });
    return chips.map((chip) => (
      <View key={chip.label} style={[styles.chip, { borderColor: toneColor[chip.tone] }]}>
        <View style={[styles.dot, { backgroundColor: toneColor[chip.tone] }]} />
        <Text style={[styles.chipText, { color: toneColor[chip.tone] }]}>{chip.label}</Text>
      </View>
    ));
  }

  function agentLine(agent: PreparedAgent) {
    const color = toneColor[agent.state.tone];
    const archived = agent.row.archivedAt != null;
    // Idle and closed are the resting states; labelling every one of them would
    // bury the rows that actually ask for something. The dot still carries it.
    const showState = isNotable(agent.state) || archived;
    const provider = agent.row.provider === "" ? NO_PROVIDER : agent.row.provider;
    const inner = (
      <>
        <View style={styles.gutter}>
          <View style={[styles.dot, { backgroundColor: color }]} />
        </View>
        <Text style={[styles.agentTitle, archived ? styles.dim : null]} numberOfLines={3}>
          {agent.label}
        </Text>
        {showState ? (
          <Text style={[styles.agentState, { color }]}>{agent.state.label}</Text>
        ) : null}
        {showProvider ? <Text style={styles.provider}>{provider}</Text> : null}
      </>
    );

    // Older hosts do not provide navigation; keep rows readable rather than
    // offering a press that silently does nothing.
    if (!navigation) return <View style={styles.agentRow}>{inner}</View>;

    const agentId = agent.row.id;
    const { label } = agent;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`打开会话 ${label}，${agent.state.label}`}
        style={({ pressed }) => [styles.agentRow, pressed ? styles.pressed : null]}
        onPress={() => navigation.openAgent({ agentId })}
      >
        {inner}
      </Pressable>
    );
  }

  function workspaceCard(workspace: PreparedWorkspace) {
    const { row, label, state, agents } = workspace;
    const diff = row.diffStat;
    const showDiff = diff !== null && (diff.additions !== 0 || diff.deletions !== 0);

    const headerInner = (
      <>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{row.count}</Text>
        </View>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {label}
        </Text>
        {showDiff && diff ? (
          <Text style={styles.diff}>
            +{diff.additions} −{diff.deletions}
          </Text>
        ) : null}
        {isNotable(state) ? (
          <View style={[styles.pill, { borderColor: toneColor[state.tone] }]}>
            <Text style={[styles.pillText, { color: toneColor[state.tone] }]}>{state.label}</Text>
          </View>
        ) : null}
      </>
    );

    const header = navigation ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`打开 ${label}，${row.count} 个会话`}
        style={({ pressed }) => [styles.cardHeader, pressed ? styles.pressed : null]}
        onPress={() => navigation.openWorkspace({ workspaceId: row.id })}
      >
        {headerInner}
      </Pressable>
    ) : (
      <View style={styles.cardHeader}>{headerInner}</View>
    );

    return (
      <View style={styles.cardWrap}>
        <View style={styles.card}>
          {header}
          {agents.length === 0 ? (
            <Text style={styles.empty}>没有会话</Text>
          ) : (
            <View style={styles.agentList}>
              {agents.map((agent) => (
                <View key={agent.row.id}>{agentLine(agent)}</View>
              ))}
            </View>
          )}
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Agent 总览</Text>
        {snapshot ? (
          <View style={styles.summaryRow}>
            {summaryChips()}
            <Text style={styles.total}>
              {snapshot.total} 个会话 · {snapshot.workspaces.length} 个 workspace
            </Text>
          </View>
        ) : null}
      </View>

      {error ? (
        <Text accessibilityRole="alert" style={styles.danger}>
          目录读取失败：{error}
        </Text>
      ) : null}

      {!snapshot && !error ? <Text style={styles.notice}>正在读取目录…</Text> : null}

      {snapshot && snapshot.workspaces.length === 0 ? (
        <Text style={styles.notice}>还没有 workspace。</Text>
      ) : null}

      {groups.map((group) => (
        <View key={group.project}>
          <View style={styles.projectHeader}>
            <Text style={styles.project}>{group.project}</Text>
            <View style={styles.projectRule} />
            <Text style={styles.projectCount}>{group.count}</Text>
          </View>
          {group.workspaces.map((workspace) => (
            <View key={workspace.row.id}>{workspaceCard(workspace)}</View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
