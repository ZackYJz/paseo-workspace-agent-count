import { describe, expect, it, vi } from "vitest";
import { counterRpc } from "../shared/counter";
import { settingsContracts } from "../shared/settings";
import { applyTitleMode, reconcileTitleMode, setTitleMode, type TitleModeRpc } from "./title-mode";

const READ = settingsContracts.read.name;
const WRITE = settingsContracts.write.name;

function calls(overrides: Partial<TitleModeRpc> = {}) {
  const readSettings = vi.fn(async () => ({
    status: "ready" as const,
    revision: "r1",
    values: { titleCounts: false },
  }));
  const writeSettings = vi.fn(async () => ({
    status: "saved" as const,
    revision: "r2",
    values: { titleCounts: true },
  }));
  const updateCounter = vi.fn(async () => ({ paused: false, updated: 0 }));
  return {
    spies: { readSettings, writeSettings, updateCounter },
    rpc: { readSettings, writeSettings, updateCounter, ...overrides } as unknown as TitleModeRpc,
  };
}

describe("applyTitleMode", () => {
  it("maps the preference onto exactly one ledger action", async () => {
    const { rpc, spies } = calls();
    await applyTitleMode(rpc, true);
    expect(spies.updateCounter).toHaveBeenCalledWith({ action: "resume" });
    await applyTitleMode(rpc, false);
    expect(spies.updateCounter).toHaveBeenLastCalledWith({ action: "restore" });
    // Applying a preference never writes it; only setTitleMode does.
    expect(spies.writeSettings).not.toHaveBeenCalled();
  });
});

describe("reconcileTitleMode", () => {
  it("applies the stored preference without writing it", async () => {
    const { rpc, spies } = calls();
    await reconcileTitleMode(rpc);
    expect(spies.readSettings).toHaveBeenCalledTimes(1);
    expect(spies.writeSettings).not.toHaveBeenCalled();
    expect(spies.updateCounter).toHaveBeenCalledWith({ action: "restore" });
  });

  it("resumes when the stored preference is on", async () => {
    const { rpc, spies } = calls({
      readSettings: vi.fn(async () => ({
        status: "ready" as const,
        revision: "r1",
        values: { titleCounts: true },
      })),
    });
    await reconcileTitleMode(rpc);
    expect(spies.updateCounter).toHaveBeenCalledWith({ action: "resume" });
  });

  it("propagates a transport failure instead of guessing a preference", async () => {
    const { rpc, spies } = calls({
      readSettings: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await expect(reconcileTitleMode(rpc)).rejects.toThrow("offline");
    expect(spies.updateCounter).not.toHaveBeenCalled();
  });

  it("reports invalid stored data instead of guessing a preference", async () => {
    const { rpc, spies } = calls({
      readSettings: vi.fn(async () => ({
        status: "invalid" as const,
        revision: "r1",
        error: "broken",
      })),
    });
    await expect(reconcileTitleMode(rpc)).rejects.toThrow("插件设置数据无效：broken");
    expect(spies.updateCounter).not.toHaveBeenCalled();
  });

  it("rejects a payload that does not match the schema rather than defaulting it", async () => {
    const { rpc, spies } = calls({
      readSettings: vi.fn(async () => ({
        status: "ready" as const,
        revision: "r1",
        values: { titleCounts: "yes" },
      })),
    });
    await expect(reconcileTitleMode(rpc)).rejects.toThrow("插件设置数据无效");
    expect(spies.updateCounter).not.toHaveBeenCalled();
  });
});

describe("setTitleMode", () => {
  it("writes against the revision it read, then applies", async () => {
    const { rpc, spies } = calls();
    await setTitleMode(rpc, true);
    expect(spies.writeSettings).toHaveBeenCalledWith({
      revision: "r1",
      values: { titleCounts: true },
    });
    expect(spies.updateCounter).toHaveBeenCalledWith({ action: "resume" });
  });

  it("preserves unrelated keys in the document", async () => {
    const { rpc, spies } = calls({
      readSettings: vi.fn(async () => ({
        status: "ready" as const,
        revision: "r1",
        values: { titleCounts: false, somethingElse: 7 },
      })),
    });
    await setTitleMode(rpc, true);
    expect(spies.writeSettings).toHaveBeenCalledWith({
      revision: "r1",
      values: { titleCounts: true, somethingElse: 7 },
    });
  });

  it("leaves the ledger untouched when another client won the write", async () => {
    const { rpc, spies } = calls({
      writeSettings: vi.fn(async () => ({ status: "conflict" as const, error: "stale revision" })),
    });
    await expect(setTitleMode(rpc, true)).rejects.toThrow("设置已被其他客户端修改");
    expect(spies.updateCounter).not.toHaveBeenCalled();
  });

  it("leaves the ledger untouched when the write is rejected as invalid", async () => {
    const { rpc, spies } = calls({
      writeSettings: vi.fn(async () => ({ status: "invalid" as const, error: "bad document" })),
    });
    await expect(setTitleMode(rpc, true)).rejects.toThrow("设置保存失败");
    expect(spies.updateCounter).not.toHaveBeenCalled();
  });

  it("does not write when the current document cannot be read", async () => {
    const { rpc, spies } = calls({
      readSettings: vi.fn(async () => ({ status: "invalid" as const, revision: "r1", error: "broken" })),
    });
    await expect(setTitleMode(rpc, true)).rejects.toThrow("插件设置数据无效：broken");
    expect(spies.writeSettings).not.toHaveBeenCalled();
    expect(spies.updateCounter).not.toHaveBeenCalled();
  });
});

describe("contract wiring", () => {
  it("targets this plugin's own settings document and counter RPC", () => {
    expect(READ).toBe("settings.display.read");
    expect(WRITE).toBe("settings.display.write");
    expect(counterRpc.name).toBe("counter.update");
  });
});
