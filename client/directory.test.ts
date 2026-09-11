import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createDirectoryWatcher } from "./directory";

type Agent = {
  id: string;
  workspaceId: string | null;
  status: string;
  title?: string | null;
  provider?: string;
  createdAt?: string;
  archivedAt?: string | null;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  updatedAt?: string;
};
type Workspace = {
  id: string;
  name: string;
  title?: string | null;
  projectDisplayName: string;
  status?: string | null;
  diffStat?: { additions: number; deletions: number } | null;
  archivingAt?: string | null;
};

const END_PAGE = { nextCursor: null, hasMore: false };

function fakePaseo(state: { agents: Agent[]; workspaces: Workspace[] }) {
  const agentListeners = new Set<(event: unknown) => void>();
  const workspaceListeners = new Set<(event: unknown) => void>();
  let failNextRead = false;
  const reads = { agents: 0, workspaces: 0 };

  const paseo = {
    agents: {
      list: async (options?: { subscribe?: unknown }) => {
        // The seeding request carries `subscribe`; a refresh read does not.
        if (failNextRead && !options?.subscribe) {
          failNextRead = false;
          throw new Error("offline");
        }
        if (!options?.subscribe) reads.agents++;
        return { entries: state.agents.map((agent) => ({ agent })), pageInfo: END_PAGE };
      },
      subscribe: (fn: (event: unknown) => void) => {
        agentListeners.add(fn);
        return () => agentListeners.delete(fn);
      },
    },
    workspaces: {
      list: async (options?: { subscribe?: unknown }) => {
        if (!options?.subscribe) reads.workspaces++;
        return { entries: state.workspaces.map((workspace) => ({ ...workspace })), pageInfo: END_PAGE };
      },
      subscribe: (fn: (event: unknown) => void) => {
        workspaceListeners.add(fn);
        return () => workspaceListeners.delete(fn);
      },
    },
  } as unknown as PluginClientContext["paseo"];

  return {
    paseo,
    reads,
    state,
    failNextRead: () => { failNextRead = true; },
    emitAgent: (event: unknown) => agentListeners.forEach((fn) => fn(event)),
    emitWorkspace: (event: unknown) => workspaceListeners.forEach((fn) => fn(event)),
    listenerCounts: () => ({ agents: agentListeners.size, workspaces: workspaceListeners.size }),
  };
}

function workspace(id: string, name: string, projectDisplayName = "pi-demo", extra: Partial<Workspace> = {}): Workspace {
  return { id, name, title: null, projectDisplayName, status: "done", ...extra };
}
function agent(id: string, workspaceId: string | null, status = "idle", extra: Partial<Agent> = {}): Agent {
  return {
    id,
    workspaceId,
    status,
    title: `会话 ${id}`,
    provider: "pi",
    createdAt: `2026-01-0${id.length}`,
    ...extra,
  };
}

describe("directory snapshot", () => {
  it("counts agents per workspace and reports a total", async () => {
    const fake = fakePaseo({
      workspaces: [workspace("w1", "第一个"), workspace("w2", "第二个")],
      agents: [agent("a1", "w1"), agent("a2", "w1"), agent("a3", "w2"), agent("orphan", null)],
    });
    const watcher = createDirectoryWatcher(fake.paseo);
    await watcher.start();
    await vi.waitFor(() => expect(watcher.snapshot()).toBeDefined());
    const snapshot = watcher.snapshot()!;
    expect(snapshot.total).toBe(3);
    expect(snapshot.workspaces.map((row) => [row.id, row.count])).toEqual([["w1", 2], ["w2", 1]]);
    expect(snapshot.workspaces[0].agents.map((row) => row.id)).toEqual(["a1", "a2"]);
    watcher.stop();
  });

  it("counts archived and closed agents, and dedupes a record repeated across pages", async () => {
    const fake = fakePaseo({
      workspaces: [workspace("w1", "第一个")],
      agents: [agent("a1", "w1", "closed"), agent("a2", "w1", "idle", { archivedAt: "2026-01-01" }), agent("a1", "w1")],
    });
    const watcher = createDirectoryWatcher(fake.paseo);
    await watcher.start();
    await vi.waitFor(() => expect(watcher.snapshot()?.total).toBe(2));
    watcher.stop();
  });

  it("omits workspaces that are being archived and carries host fields through", async () => {
    const fake = fakePaseo({
      workspaces: [
        workspace("w1", "第一个", "pi-demo", {
          status: "attention",
          diffStat: { additions: 12, deletions: 3 },
        }),
        workspace("w2", "归档中", "pi-demo", { archivingAt: "2026-01-01" }),
      ],
      agents: [
        agent("a1", "w1", "running", { requiresAttention: true, attentionReason: "permission" }),
        agent("a2", "w2"),
      ],
    });
    const watcher = createDirectoryWatcher(fake.paseo);
    await watcher.start();
    await vi.waitFor(() => expect(watcher.snapshot()).toBeDefined());
    const snapshot = watcher.snapshot()!;
    expect(snapshot.workspaces.map((row) => row.id)).toEqual(["w1"]);
    // The host's own roll-up is passed through untouched, not re-derived.
    expect(snapshot.workspaces[0].status).toBe("attention");
    expect(snapshot.workspaces[0].diffStat).toEqual({ additions: 12, deletions: 3 });
    expect(snapshot.workspaces[0].agents[0]).toMatchObject({
      attentionReason: "permission",
      requiresAttention: true,
      archivedAt: null,
    });
    // An agent in an archiving workspace is not counted toward the total.
    expect(snapshot.total).toBe(1);
    watcher.stop();
  });
});

describe("directory refresh", () => {
  it("refreshes on a lifecycle change but ignores streaming with an unchanged key", async () => {
    const fake = fakePaseo({
      workspaces: [workspace("w1", "第一个")],
      agents: [agent("a1", "w1")],
    });
    const watcher = createDirectoryWatcher(fake.paseo);
    const onChange = vi.fn();
    watcher.subscribe(onChange);
    await watcher.start();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

    // Streaming rewrites updatedAt on every fragment; that is not a change.
    fake.emitAgent({ kind: "upsert", agent: agent("a1", "w1", "idle", { updatedAt: "new" }) });
    fake.emitAgent({ kind: "upsert", agent: agent("a1", "w1", "idle", { updatedAt: "newer" }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).toHaveBeenCalledTimes(1);

    fake.emitAgent({ kind: "upsert", agent: agent("a1", "w1", "closed") });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    watcher.stop();
  });

  it("republishes a new count after an agent is added and after one is removed", async () => {
    const fake = fakePaseo({
      workspaces: [workspace("w1", "第一个")],
      agents: [agent("a1", "w1")],
    });
    const watcher = createDirectoryWatcher(fake.paseo);
    await watcher.start();
    await vi.waitFor(() => expect(watcher.snapshot()?.total).toBe(1));

    fake.state.agents.push(agent("a2", "w1"));
    fake.emitAgent({ kind: "upsert", agent: agent("a2", "w1") });
    await vi.waitFor(() => expect(watcher.snapshot()?.total).toBe(2));

    fake.state.agents.pop();
    fake.emitAgent({ kind: "remove", agentId: "a2" });
    await vi.waitFor(() => expect(watcher.snapshot()?.total).toBe(1));
    watcher.stop();
  });

  it("keeps the previous snapshot and reports the reason when a read fails", async () => {
    const fake = fakePaseo({
      workspaces: [workspace("w1", "第一个")],
      agents: [agent("a1", "w1")],
    });
    const watcher = createDirectoryWatcher(fake.paseo);
    await watcher.start();
    await vi.waitFor(() => expect(watcher.snapshot()?.total).toBe(1));
    expect(watcher.error()).toBeNull();

    fake.failNextRead();
    fake.emitAgent({ kind: "upsert", agent: agent("a1", "w1", "closed") });
    await vi.waitFor(() => expect(watcher.error()).toBe("offline"));
    // A failed read is not an empty directory.
    expect(watcher.snapshot()?.total).toBe(1);

    fake.emitAgent({ kind: "upsert", agent: agent("a1", "w1", "idle") });
    await vi.waitFor(() => expect(watcher.error()).toBeNull());
    watcher.stop();
  });

  it("releases its listeners on stop and publishes nothing afterwards", async () => {
    const fake = fakePaseo({
      workspaces: [workspace("w1", "第一个")],
      agents: [agent("a1", "w1")],
    });
    const watcher = createDirectoryWatcher(fake.paseo);
    await watcher.start();
    await vi.waitFor(() => expect(watcher.snapshot()).toBeDefined());
    expect(fake.listenerCounts()).toEqual({ agents: 1, workspaces: 1 });

    const onChange = vi.fn();
    watcher.subscribe(onChange);
    watcher.stop();
    expect(fake.listenerCounts()).toEqual({ agents: 0, workspaces: 0 });

    fake.state.agents.push(agent("a2", "w1"));
    fake.emitAgent({ kind: "upsert", agent: agent("a2", "w1") });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("releases listeners and reports the failure when the observation cannot be created", async () => {
    const failing = {
      agents: {
        list: async () => { throw new Error("cannot subscribe"); },
        subscribe: () => () => {},
      },
      workspaces: { list: async () => ({ entries: [], pageInfo: END_PAGE }), subscribe: () => () => {} },
    } as unknown as PluginClientContext["paseo"];
    const watcher = createDirectoryWatcher(failing);
    await expect(watcher.start()).rejects.toThrow("cannot subscribe");
    expect(watcher.snapshot()).toBeUndefined();
  });
});
