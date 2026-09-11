import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { describe, expect, it, vi } from "vitest";
import { createCounter, planTitle } from "./counter";

function workspace(id = "w1", title: string | null = "开发空间") {
  return { id, title, name: title ?? "main", archivingAt: null as string | null };
}
function agent(id: string, workspaceId: string | null, archivedAt: string | null = null) {
  return { agent: { id, workspaceId, archivedAt, status: "idle" as string } };
}
const end = { nextCursor: null, hasMore: false };

async function setup() {
  const file = join(await mkdtemp(join(tmpdir(), "paseo-counter-test-")), "state.json");
  const workspaces = [workspace()];
  const agents = [agent("a1", "w1"), agent("a2", "w1", "2026-01-01")];
  type Api = PluginHandlerContext["paseo"];
  type AgentHandler = Parameters<Api["agents"]["subscribe"]>[0];
  type WorkspaceHandler = Parameters<Api["workspaces"]["subscribe"]>[0];
  const agentListeners = new Set<AgentHandler>();
  const workspaceListeners = new Set<WorkspaceHandler>();
  const emitAgent = (event: unknown) => agentListeners.forEach((fn) => fn(event as Parameters<AgentHandler>[0]));
  const emitWorkspace = (event: unknown) => workspaceListeners.forEach((fn) => fn(event as Parameters<WorkspaceHandler>[0]));
  const setTitle = vi.fn(async (id: string, title: string | null) => {
    const w = workspaces.find((item) => item.id === id)!;
    w.title = title;
    w.name = title ?? "main";
    emitWorkspace({ kind: "upsert", workspace: { ...w } });
    return { title };
  });
  const workspaceList = vi.fn(async (options: { filter?: { query?: string } } = {}) => ({
    entries: workspaces.filter((w) => !options.filter?.query || w.id.includes(options.filter.query)).map((w) => ({ ...w })),
    pageInfo: end,
  }));
  const agentList = vi.fn(async () => ({ entries: [...agents], pageInfo: end }));
  const seedAgents = vi.fn(async () => ({ entries: [...agents], pageInfo: end }));
  const seedWorkspaces = vi.fn(async () => ({ entries: [...workspaces], pageInfo: end }));
  const context = { paseo: {
    workspaces: {
      list: (options: Parameters<Api["workspaces"]["list"]>[0]) => options?.subscribe ? seedWorkspaces() : workspaceList(options),
      ref: (id: string) => ({ setTitle: (title: string | null) => setTitle(id, title) }),
      subscribe: (fn: WorkspaceHandler) => { workspaceListeners.add(fn); return () => workspaceListeners.delete(fn); },
    },
    agents: {
      list: (options: Parameters<Api["agents"]["list"]>[0]) => options?.subscribe ? seedAgents() : (agentList as (...args: unknown[]) => unknown)(options),
      subscribe: (fn: AgentHandler) => { agentListeners.add(fn); return () => agentListeners.delete(fn); },
    },
  } } as unknown as PluginHandlerContext;
  return { file, context, workspaces, agents, setTitle, workspaceList, agentList, seedAgents, seedWorkspaces,
    emitAgent, emitWorkspace, agentListeners, workspaceListeners, run: createCounter(file) };
}

describe("title formatting", () => {
  it("puts the compact count before the title and keeps Chinese/emoji intact", () => {
    expect(planTitle(workspace(), 0).appliedTitle).toBe("(0) 开发空间");
    expect(planTitle(workspace("w", "🧪 测试 / Café"), 1).appliedTitle).toBe("(1) 🧪 测试 / Café");
  });
  it("never stacks its own count prefix", () => {
    const previous = planTitle(workspace(), 2);
    expect(planTitle(workspace("w1", previous.appliedTitle), 12, previous).appliedTitle).toBe("(12) 开发空间");
  });
  it("preserves manual renames with and without an existing owned prefix", () => {
    const previous = planTitle(workspace(), 2);
    expect(planTitle(workspace("w1", "(2) 新标题"), 3, previous).appliedTitle).toBe("(3) 新标题");
    expect(planTitle(workspace("w1", "全新标题"), 3, previous).baseTitle).toBe("全新标题");
  });
  it("migrates the old owned suffix without changing the original title", () => {
    const legacy = {
      baseTitle: "开发空间", fallbackName: "开发空间",
      suffix: " · 2 agents", appliedTitle: "开发空间 · 2 agents",
    };
    expect(planTitle(workspace("w1", legacy.appliedTitle), 3, legacy).appliedTitle).toBe("(3) 开发空间");
    expect(planTitle(workspace("w1", "新标题 · 2 agents"), 3, legacy).appliedTitle).toBe("(3) 新标题");
  });
  it("does not strip an unowned count-shaped title", () => {
    expect(planTitle(workspace("w1", "(2) Team"), 1).appliedTitle).toBe("(1) (2) Team");
  });
  it("preserves null base titles across restart", () => {
    const previous = planTitle(workspace("w1", null), 2);
    const next = planTitle(workspace("w1", previous.appliedTitle), 3, previous);
    expect(next.baseTitle).toBeNull();
    expect(next.appliedTitle).toBe("(3) main");
  });
  it("rejects invalid counts", () => {
    for (const count of [-1, 0.5, NaN, Infinity]) expect(() => planTitle(workspace(), count)).toThrow();
  });
});

describe("persistent counter", () => {
  it("counts unique workspace IDs, includes archived agents, handles empty workspaces", async () => {
    const s = await setup();
    s.workspaces.push(workspace("w2"));
    s.agents.push(agent("a1", "w1"), agent("other", "elsewhere"), agent("orphan", null));
    expect(await s.run({ action: "sync" }, s.context)).toEqual({ paused: false, updated: 1 });
    expect(s.workspaces.map((w) => w.title)).toEqual(["(2) 开发空间", "开发空间"]);
    expect(s.agentList.mock.calls[0]).toEqual([expect.objectContaining({ filter: { includeArchived: true } })]);
    expect(s.workspaceList).toHaveBeenCalledWith(expect.objectContaining({ filter: { query: "w1" } }));
  });
  it("fetches every page and deduplicates overlap", async () => {
    const s = await setup();
    s.agentList.mockResolvedValueOnce({ entries: [agent("a1", "w1")], pageInfo: { nextCursor: "page2", hasMore: true } } as never);
    s.agentList.mockResolvedValueOnce({ entries: [agent("a1", "w1"), agent("a2", "w1")], pageInfo: end });
    await s.run({ action: "sync" }, s.context);
    expect(s.agentList).toHaveBeenCalledTimes(2);
    expect(s.workspaces[0].title).toBe("(2) 开发空间");
  });
  it("updates after creation/deletion but does not rewrite unchanged titles", async () => {
    const s = await setup();
    await s.run({ action: "resume" }, s.context);
    await s.run({ action: "resume" }, s.context);
    expect(s.setTitle).toHaveBeenCalledTimes(1);
    s.agents.push(agent("a3", "w1"));
    await s.run({ action: "resume" }, s.context);
    expect(s.workspaces[0].title).toBe("(3) 开发空间");
    s.agents.length = 0;
    await s.run({ action: "resume" }, s.context);
    expect(s.workspaces[0].title).toBe("(0) 开发空间");
  });
  it("serializes concurrent clients and establishes only one pair of subscriptions", async () => {
    const s = await setup();
    await Promise.all(Array.from({ length: 5 }, () => s.run({ action: "sync" }, s.context)));
    expect(s.setTitle).toHaveBeenCalledTimes(1);
    expect(s.agentList).toHaveBeenCalledTimes(5);
    expect(s.seedAgents).toHaveBeenCalledTimes(1);
    expect(s.seedWorkspaces).toHaveBeenCalledTimes(1);
  });
  it("retains recovery data across reload and can pause/restore/resume", async () => {
    const s = await setup();
    s.workspaces[0] = workspace("w1", null);
    await s.run({ action: "sync" }, s.context);
    // A real reload destroys the old subprocess and its SDK listeners.
    s.agentListeners.clear();
    s.workspaceListeners.clear();
    const reload = createCounter(s.file);
    await reload({ action: "sync" }, s.context);
    expect(s.workspaces[0].title).toBe("(2) main");
    await reload({ action: "restore" }, s.context);
    expect(s.workspaces[0].title).toBeNull();
    expect(await reload({ action: "sync" }, s.context)).toEqual({ paused: true, updated: 0 });
    await reload({ action: "resume" }, s.context);
    expect(s.workspaces[0].title).toBe("(2) main");
  });
  it("uses a manually changed title as its new base", async () => {
    const s = await setup();
    await s.run({ action: "sync" }, s.context);
    s.workspaces[0].title = "(2) 用户新标题";
    await s.run({ action: "resume" }, s.context);
    await s.run({ action: "restore" }, s.context);
    expect(s.workspaces[0].title).toBe("用户新标题");
  });
  it("does not overwrite a rename observed during refresh or restore", async () => {
    const s = await setup();
    s.workspaceList.mockImplementationOnce(async () => {
      const snapshot = { ...s.workspaces[0] };
      s.workspaces[0].title = "刚刚改的标题";
      return { entries: [snapshot], pageInfo: end };
    });
    await s.run({ action: "sync" }, s.context);
    expect(s.setTitle).not.toHaveBeenCalled();
    await s.run({ action: "resume" }, s.context);
    s.workspaces[0].title = "另一个手动标题";
    await s.run({ action: "restore" }, s.context);
    expect(s.workspaces[0].title).toBe("另一个手动标题");
  });
  it("aborts on failed or incomplete listings instead of publishing zero", async () => {
    const s = await setup();
    s.agentList.mockRejectedValueOnce(new Error("offline"));
    await expect(s.run({ action: "sync" }, s.context)).rejects.toThrow("offline");
    expect(s.setTitle).not.toHaveBeenCalled();
    s.agentList.mockResolvedValueOnce({ entries: [], pageInfo: { nextCursor: null, hasMore: true } });
    await expect(s.run({ action: "sync" }, s.context)).rejects.toThrow("missing cursor");
    expect(s.setTitle).not.toHaveBeenCalled();
    await s.run({ action: "sync" }, s.context);
    expect(s.setTitle).toHaveBeenCalledTimes(1);
  });
  it("does not erase a corrupted recovery file", async () => {
    const s = await setup();
    await writeFile(s.file, "broken JSON");
    await expect(s.run({ action: "sync" }, s.context)).rejects.toThrow();
    expect(await readFile(s.file, "utf8")).toBe("broken JSON");
    expect(s.setTitle).not.toHaveBeenCalled();
  });
  it("saves the base before writing, and retries after an RPC failure", async () => {
    const s = await setup();
    s.setTitle.mockImplementationOnce(async () => {
      const state = JSON.parse(await readFile(s.file, "utf8"));
      expect(state.titles.w1.baseTitle).toBe("开发空间");
      throw new Error("write rejected");
    });
    await expect(s.run({ action: "sync" }, s.context)).rejects.toThrow("write rejected");
    await s.run({ action: "sync" }, s.context);
    expect(s.workspaces[0].title).toBe("(2) 开发空间");
  });
  it("skips workspaces being archived", async () => {
    const s = await setup();
    s.workspaces[0].archivingAt = "2026-01-01";
    await s.run({ action: "sync" }, s.context);
    expect(s.setTitle).not.toHaveBeenCalled();
  });
  it("recovers a failed count change without adopting its own old suffix as the base", async () => {
    const s = await setup();
    await s.run({ action: "resume" }, s.context);
    s.agents.push(agent("a3", "w1"));
    s.setTitle.mockRejectedValueOnce(new Error("count change failed"));
    await expect(s.run({ action: "resume" }, s.context)).rejects.toThrow("count change failed");
    expect(s.workspaces[0].title).toBe("(2) 开发空间");
    s.agentListeners.clear();
    s.workspaceListeners.clear();
    await createCounter(s.file)({ action: "sync" }, s.context);
    expect(s.workspaces[0].title).toBe("(3) 开发空间");
  });
  it("can restore even when the last count write failed", async () => {
    const s = await setup();
    await s.run({ action: "resume" }, s.context);
    s.agents.push(agent("a3", "w1"));
    s.setTitle.mockRejectedValueOnce(new Error("count change failed"));
    await expect(s.run({ action: "resume" }, s.context)).rejects.toThrow();
    await s.run({ action: "restore" }, s.context);
    expect(s.workspaces[0].title).toBe("开发空间");
  });
  it("fetches all workspace pages and rejects repeated cursors", async () => {
    const s = await setup();
    s.workspaces.push(workspace("w2"));
    s.agents.push(agent("second", "w2"));
    s.workspaceList.mockResolvedValueOnce({ entries: [{ ...s.workspaces[0] }], pageInfo: { nextCursor: "next", hasMore: true } } as never);
    s.workspaceList.mockResolvedValueOnce({ entries: [{ ...s.workspaces[1] }], pageInfo: end });
    await s.run({ action: "resume" }, s.context);
    expect(s.setTitle).toHaveBeenCalledTimes(2);
    s.agentList.mockResolvedValue({ entries: [], pageInfo: { nextCursor: "loop", hasMore: true } } as never);
    await expect(s.run({ action: "resume" }, s.context)).rejects.toThrow("Repeated pagination cursor");
    expect(s.setTitle).toHaveBeenCalledTimes(2);
  });
});

describe("daemon directory events", () => {
  it("refreshes immediately on creation and deletion, even less than two seconds apart", async () => {
    const s = await setup();
    await s.run({ action: "sync" }, s.context);
    s.agents.push(agent("a3", "w1"));
    s.emitAgent({ kind: "upsert", agent: s.agents[2].agent });
    await vi.waitFor(() => expect(s.workspaces[0].title).toBe("(3) 开发空间"));
    s.agents.pop();
    s.emitAgent({ kind: "remove", agentId: "a3" });
    await vi.waitFor(() => expect(s.workspaces[0].title).toBe("(2) 开发空间"));
  });
  it("refreshes on close/reopen/archive but ignores streaming with unchanged lifecycle", async () => {
    const s = await setup();
    await s.run({ action: "sync" }, s.context);
    s.emitAgent({ kind: "upsert", agent: { ...s.agents[0].agent, status: "idle", updatedAt: "new" } });
    s.emitAgent({ kind: "upsert", agent: { ...s.agents[0].agent, status: "idle", updatedAt: "newer" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.agentList).toHaveBeenCalledTimes(1);
    s.emitAgent({ kind: "upsert", agent: { ...s.agents[0].agent, status: "closed" } });
    await vi.waitFor(() => expect(s.agentList).toHaveBeenCalledTimes(2));
    s.emitAgent({ kind: "upsert", agent: { ...s.agents[0].agent, status: "idle" } });
    await vi.waitFor(() => expect(s.agentList).toHaveBeenCalledTimes(3));
    s.emitAgent({ kind: "upsert", agent: { ...s.agents[0].agent, archivedAt: "2026-09-03" } });
    await vi.waitFor(() => expect(s.agentList).toHaveBeenCalledTimes(4));
    expect(s.workspaces[0].title).toBe("(2) 开发空间");
  });
  it("does not loop on its own title echoes, but follows manual renames and empty workspace creation", async () => {
    const s = await setup();
    await s.run({ action: "sync" }, s.context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.agentList).toHaveBeenCalledTimes(1);
    s.workspaces[0].title = "新的标题";
    s.emitWorkspace({ kind: "upsert", workspace: { ...s.workspaces[0] } });
    await vi.waitFor(() => expect(s.workspaces[0].title).toBe("(2) 新的标题"));
    s.workspaces.push(workspace("w2", "空空间"));
    s.emitWorkspace({ kind: "upsert", workspace: { ...s.workspaces[1] } });
    await vi.waitFor(() => expect(s.agentList).toHaveBeenCalledTimes(3));
    expect(s.workspaces[1].title).toBe("空空间");
    expect(s.setTitle).toHaveBeenCalledTimes(2);
  });
  it("follows workspace migrations and skips irrelevant workspace activity changes", async () => {
    const s = await setup();
    s.workspaces.push(workspace("w2"));
    await s.run({ action: "sync" }, s.context);
    s.emitWorkspace({ kind: "upsert", workspace: { ...s.workspaces[0], status: "running", activityAt: "new" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.agentList).toHaveBeenCalledTimes(1);
    s.agents[0].agent.workspaceId = "w2";
    s.emitAgent({ kind: "upsert", agent: { ...s.agents[0].agent } });
    await vi.waitFor(() => expect(s.workspaces.map((w) => w.title)).toEqual(["(1) 开发空间", "(1) 开发空间"]));
  });
  it("does a trailing refresh for events arriving during an in-flight snapshot", async () => {
    const s = await setup();
    await s.run({ action: "sync" }, s.context);
    let finish!: () => void;
    s.agentList.mockImplementationOnce(() => {
      const entries = [...s.agents];
      return new Promise((resolve) => { finish = () => resolve({ entries, pageInfo: end }); });
    });
    s.agents.push(agent("a3", "w1"));
    s.emitAgent({ kind: "upsert", agent: s.agents[2].agent });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    s.agents.push(agent("a4", "w1"), agent("a5", "w1"));
    s.emitAgent({ kind: "upsert", agent: s.agents[3].agent });
    s.emitAgent({ kind: "upsert", agent: s.agents[4].agent });
    finish();
    await vi.waitFor(() => expect(s.workspaces[0].title).toBe("(5) 开发空间"));
    expect(s.agentList).toHaveBeenCalledTimes(3);
  });
  it("keeps paused workspaces unchanged when lifecycle events arrive", async () => {
    const s = await setup();
    await s.run({ action: "sync" }, s.context);
    await s.run({ action: "restore" }, s.context);
    s.agents.push(agent("a3", "w1"));
    s.emitAgent({ kind: "upsert", agent: s.agents[2].agent });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.workspaces[0].title).toBe("开发空间");
    expect(s.agentList).toHaveBeenCalledTimes(1);
  });
  it("cleans listeners when subscription setup fails and retries on explicit refresh", async () => {
    const s = await setup();
    s.seedAgents.mockRejectedValueOnce(new Error("cannot subscribe"));
    await expect(s.run({ action: "sync" }, s.context)).rejects.toThrow("cannot subscribe");
    expect(s.agentListeners.size).toBe(0);
    expect(s.workspaceListeners.size).toBe(0);
    expect(s.setTitle).not.toHaveBeenCalled();
    await s.run({ action: "sync" }, s.context);
    expect(s.agentListeners.size).toBe(1);
    expect(s.workspaceListeners.size).toBe(1);
  });
});


describe("creation safety", () => {
  it("leaves a new empty workspace untouched", async () => {
    const s = await setup();
    s.agents.length = 0;
    await s.run({ action: "sync" }, s.context);
    expect(s.setTitle).not.toHaveBeenCalled();
  });
  it.each(["initializing", "running"])("defers title writes while an agent is %s, then updates on idle", async (status) => {
    const s = await setup();
    s.agents[0].agent.status = status;
    await s.run({ action: "sync" }, s.context);
    expect(s.setTitle).not.toHaveBeenCalled();
    s.agents[0].agent.status = "idle";
    s.emitAgent({ kind: "upsert", agent: { ...s.agents[0].agent } });
    await vi.waitFor(() => expect(s.workspaces[0].title).toBe("(2) 开发空间"));
  });
});
