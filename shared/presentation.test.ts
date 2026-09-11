import { describe, expect, it } from "vitest";
import {
  agentState,
  compareAgents,
  compareWorkspaces,
  hasMixedValues,
  isNotable,
  summarizeAgentStates,
  workspaceState,
} from "./presentation";

describe("agentState precedence", () => {
  it("reports an archived agent as archived even when it still asks for attention", () => {
    expect(
      agentState({
        status: "running",
        requiresAttention: true,
        attentionReason: "permission",
        archivedAt: "2026-01-01",
      }).label,
    ).toBe("已归档");
  });

  it("prefers a concrete attention reason over the bare flag", () => {
    expect(
      agentState({ status: "idle", requiresAttention: true, attentionReason: "permission" }).label,
    ).toBe("等待授权");
    expect(agentState({ status: "idle", attentionReason: "error" }).label).toBe("出错");
    expect(agentState({ status: "idle", requiresAttention: true }).label).toBe("需要处理");
  });

  it("treats a live status as stronger than a stale finished reason", () => {
    expect(agentState({ status: "running", attentionReason: "finished" }).label).toBe("运行中");
    expect(agentState({ status: "idle", attentionReason: "finished" }).label).toBe("已完成");
  });

  it("reads an error from status alone", () => {
    expect(agentState({ status: "error" }).label).toBe("出错");
    expect(agentState({ status: "error" }).tone).toBe("danger");
  });

  it("falls back to idle and closed", () => {
    expect(agentState({ status: "idle" }).label).toBe("空闲");
    expect(agentState({ status: "closed" }).label).toBe("已关闭");
    expect(agentState({ status: "initializing" }).label).toBe("启动中");
  });

  it("treats an empty archivedAt as not archived", () => {
    expect(agentState({ status: "idle", archivedAt: "" }).label).toBe("空闲");
    expect(agentState({ status: "idle", archivedAt: null }).label).toBe("空闲");
  });
});

describe("workspaceState", () => {
  it("maps the host roll-up statuses", () => {
    expect(workspaceState("needs_input").label).toBe("需要输入");
    expect(workspaceState("failed").tone).toBe("danger");
    expect(workspaceState("attention").label).toBe("需要处理");
    expect(workspaceState("running").label).toBe("运行中");
    expect(workspaceState("done").label).toBe("已完成");
  });

  it("reports an absent or unknown status as idle rather than inventing one", () => {
    expect(workspaceState(null).label).toBe("空闲");
    expect(workspaceState(undefined).label).toBe("空闲");
    expect(workspaceState("something_new").label).toBe("空闲");
  });
});

describe("badging", () => {
  it("badges only states that ask for something", () => {
    expect(isNotable(agentState({ status: "idle", attentionReason: "permission" }))).toBe(true);
    expect(isNotable(agentState({ status: "running" }))).toBe(true);
    expect(isNotable(agentState({ status: "idle", attentionReason: "finished" }))).toBe(false);
    expect(isNotable(agentState({ status: "idle" }))).toBe(false);
    expect(isNotable(agentState({ status: "idle", archivedAt: "x" }))).toBe(false);
  });

  it("counts attention separately from running", () => {
    const summary = summarizeAgentStates([
      agentState({ status: "idle", attentionReason: "permission" }),
      agentState({ status: "error" }),
      agentState({ status: "running" }),
      agentState({ status: "initializing" }),
      agentState({ status: "idle" }),
    ]);
    expect(summary).toEqual({ attention: 2, running: 2, total: 5 });
  });

  it("reports zeros for an empty directory", () => {
    expect(summarizeAgentStates([])).toEqual({ attention: 0, running: 0, total: 0 });
  });
});

describe("column pruning", () => {
  it("hides a column whose value never varies", () => {
    expect(hasMixedValues(["pi", "pi", "pi"])).toBe(false);
    expect(hasMixedValues(["pi"])).toBe(false);
    expect(hasMixedValues([])).toBe(false);
  });

  it("shows a column as soon as a second value appears", () => {
    expect(hasMixedValues(["pi", "codex"])).toBe(true);
    expect(hasMixedValues(["pi", "pi", "claude"])).toBe(true);
  });

  it("does not treat an absent value as a second value", () => {
    expect(hasMixedValues(["", "pi", ""])).toBe(false);
    expect(hasMixedValues(["", "pi", "codex"])).toBe(true);
  });
});

describe("ordering", () => {
  const agent = (id: string, extra: Partial<Parameters<typeof agentState>[0]> = {}) => ({
    id,
    createdAt: id,
    status: "idle",
    ...extra,
  });

  it("sorts agents by urgency, then oldest first", () => {
    const rows = [
      agent("c", { status: "idle" }),
      agent("b", { attentionReason: "permission" }),
      agent("a", { status: "running" }),
    ];
    expect([...rows].sort(compareAgents).map((row) => row.id)).toEqual(["b", "a", "c"]);
  });

  it("keeps equal-urgency agents in creation order", () => {
    const rows = [agent("2026-03"), agent("2026-01"), agent("2026-02")];
    expect([...rows].sort(compareAgents).map((row) => row.id)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
  });

  it("puts archived agents last", () => {
    const rows = [agent("b", { archivedAt: "2026-01" }), agent("a", { status: "idle" })];
    expect([...rows].sort(compareAgents).map((row) => row.id)).toEqual(["a", "b"]);
  });

  const workspace = (name: string, status: string | null, count: number) => ({
    name,
    status,
    count,
  });

  it("sorts workspaces by attention, then by count, then by name", () => {
    const rows = [
      workspace("zzz", "done", 9),
      workspace("bbb", null, 5),
      workspace("aaa", null, 5),
      workspace("ccc", "failed", 1),
    ];
    // "failed" leads; "done" outranks idle because a finished workspace may still
    // be waiting for review; the two idle ones tie on count and fall back to name.
    expect([...rows].sort(compareWorkspaces).map((row) => row.name)).toEqual([
      "ccc",
      "zzz",
      "aaa",
      "bbb",
    ]);
  });
});
