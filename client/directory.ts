import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { agentChangeKey, workspaceChangeKey } from "../shared/changes";
import { allPages } from "../shared/paging";
import { readDirectoryPage } from "../shared/registry";
import { tallyAgents } from "../shared/tally";

type Paseo = PluginClientContext["paseo"];

export interface AgentRow {
  id: string;
  title: string | null;
  status: string;
  provider: string;
  createdAt: string;
  requiresAttention: boolean;
  attentionReason: string | null;
  /** Kept as the raw timestamp so a row satisfies `PresentedAgent` structurally. */
  archivedAt: string | null;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  title: string | null;
  projectDisplayName: string;
  /** The host's own roll-up of this workspace's agents; not re-derived here. */
  status: string | null;
  diffStat: { additions: number; deletions: number } | null;
  count: number;
  agents: AgentRow[];
}

export interface DirectorySnapshot {
  /** Workspaces that are not being archived, in project order. */
  workspaces: WorkspaceRow[];
  /** Agents counted across those workspaces. */
  total: number;
}

export interface DirectoryState {
  /** Undefined until the first successful read. */
  snapshot: DirectorySnapshot | undefined;
  error: string | null;
}

export interface DirectoryWatcher {
  start(): Promise<void>;
  snapshot(): DirectorySnapshot | undefined;
  error(): string | null;
  subscribe(listener: () => void): () => void;
  stop(): void;
}

const PAGE_SIZE = 200;

async function readSnapshot(paseo: Paseo): Promise<DirectorySnapshot> {
  // Both listings must complete before anything is published: a failed read is
  // not an empty directory, and publishing one would report every count as zero.
  const [workspaces, agentEntries] = await Promise.all([
    allPages((cursor) =>
      readDirectoryPage(() =>
        paseo.workspaces.list({
          sort: [{ key: "project_id", direction: "asc" }],
          page: { limit: PAGE_SIZE, cursor },
        }),
      ),
    ),
    allPages((cursor) =>
      readDirectoryPage(() =>
        paseo.agents.list({
          filter: { includeArchived: true },
          sort: [{ key: "created_at", direction: "asc" }],
          page: { limit: PAGE_SIZE, cursor },
        }),
      ),
    ),
  ]);

  const { counts } = tallyAgents(agentEntries.map(({ agent }) => agent));
  const agentsByWorkspace = new Map<string, AgentRow[]>();
  const seen = new Set<string>();
  for (const { agent } of agentEntries) {
    if (!agent.workspaceId || seen.has(agent.id)) continue;
    seen.add(agent.id);
    const rows = agentsByWorkspace.get(agent.workspaceId) ?? [];
    rows.push({
      id: agent.id,
      title: agent.title,
      status: agent.status,
      provider: agent.provider,
      createdAt: agent.createdAt,
      requiresAttention: agent.requiresAttention === true,
      attentionReason: agent.attentionReason ?? null,
      archivedAt: agent.archivedAt ?? null,
    });
    agentsByWorkspace.set(agent.workspaceId, rows);
  }

  const rows: WorkspaceRow[] = workspaces
    .filter((workspace) => !workspace.archivingAt)
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      title: workspace.title ?? null,
      projectDisplayName: workspace.projectDisplayName,
      status: workspace.status,
      diffStat: workspace.diffStat ?? null,
      count: counts.get(workspace.id) ?? 0,
      agents: agentsByWorkspace.get(workspace.id) ?? [],
    }));

  return { workspaces: rows, total: rows.reduce((sum, row) => sum + row.count, 0) };
}

/**
 * Follows both directories and republishes a complete snapshot on change.
 *
 * Subscriptions are used only as change signals; every refresh re-reads both
 * directories in full, which is the same contract the daemon side uses. Change
 * keys filter streaming noise, so an agent emitting reasoning does not trigger a
 * re-read. Refreshes are coalesced: changes arriving during an in-flight read
 * produce exactly one trailing refresh and are never throttled away.
 */
export function createDirectoryWatcher(paseo: Paseo): DirectoryWatcher {
  const listeners = new Set<() => void>();
  const agentKeys = new Map<string, string | null>();
  const workspaceKeys = new Map<string, string | null>();
  let current: DirectorySnapshot | undefined;
  let failure: string | null = null;
  let stopped = false;
  let dirty = false;
  let pumping = false;
  let stopAgents: (() => void) | undefined;
  let stopWorkspaces: (() => void) | undefined;

  function notify() {
    for (const listener of [...listeners]) listener();
  }

  function requestRefresh() {
    dirty = true;
    if (pumping || stopped) return;
    pumping = true;
    void (async () => {
      try {
        while (dirty && !stopped) {
          dirty = false;
          try {
            const next = await readSnapshot(paseo);
            if (stopped) return;
            current = next;
            failure = null;
          } catch (error) {
            if (stopped) return;
            // Keep the previous snapshot so a transient failure does not blank
            // the UI; report the reason instead.
            failure = error instanceof Error ? error.message : String(error);
          }
          notify();
        }
      } finally {
        pumping = false;
      }
    })();
  }

  function releaseListeners() {
    stopAgents?.();
    stopWorkspaces?.();
    stopAgents = undefined;
    stopWorkspaces = undefined;
  }

  return {
    async start() {
      if (stopped) return;
      // Register local listeners before creating the observations, so an event
      // emitted during seeding cannot be missed.
      stopAgents = paseo.agents.subscribe((event) => {
        const id = event.kind === "remove" ? event.agentId : event.agent.id;
        const key = event.kind === "remove" ? null : agentChangeKey(event.agent);
        if (agentKeys.has(id) && agentKeys.get(id) === key) return;
        agentKeys.set(id, key);
        requestRefresh();
      });
      stopWorkspaces = paseo.workspaces.subscribe((event) => {
        const id = event.kind === "remove" ? event.id : event.workspace.id;
        const key = event.kind === "remove" ? null : workspaceChangeKey(event.workspace);
        if (workspaceKeys.has(id) && workspaceKeys.get(id) === key) return;
        workspaceKeys.set(id, key);
        requestRefresh();
      });
      try {
        // These two requests create the observations that make the daemon stream
        // directory updates to this session. Paseo 0.8 issues each observation
        // its own ID and reissues it on reconnect, so neither request names one.
        const [agentPage, workspacePage] = await Promise.all([
          readDirectoryPage(() =>
            paseo.agents.list({
              filter: { includeArchived: true },
              subscribe: {},
              page: { limit: PAGE_SIZE },
            }),
          ),
          readDirectoryPage(() => paseo.workspaces.list({ subscribe: {}, page: { limit: PAGE_SIZE } })),
        ]);
        // Seed the change keys from the same pages, or the first streaming event
        // for every record looks new and forces a full re-read of both
        // directories right after startup.
        for (const { agent } of agentPage.entries) {
          if (!agentKeys.has(agent.id)) agentKeys.set(agent.id, agentChangeKey(agent));
        }
        for (const workspace of workspacePage.entries) {
          if (!workspaceKeys.has(workspace.id)) {
            workspaceKeys.set(workspace.id, workspaceChangeKey(workspace));
          }
        }
      } catch (error) {
        releaseListeners();
        throw error;
      }
      requestRefresh();
    },
    snapshot: () => current,
    error: () => failure,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      stopped = true;
      releaseListeners();
      listeners.clear();
    },
  };
}

/** Live directory state for a contributed component. */
export function useDirectory(paseo: Paseo): DirectoryState {
  const [state, setState] = useState<DirectoryState>({ snapshot: undefined, error: null });

  useEffect(() => {
    const watcher = createDirectoryWatcher(paseo);
    let cancelled = false;
    const publish = () => {
      if (!cancelled) setState({ snapshot: watcher.snapshot(), error: watcher.error() });
    };
    const unsubscribe = watcher.subscribe(publish);
    watcher.start().catch((error: unknown) => {
      if (cancelled) return;
      setState({ snapshot: watcher.snapshot(), error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      cancelled = true;
      unsubscribe();
      watcher.stop();
    };
  }, [paseo]);

  return state;
}
