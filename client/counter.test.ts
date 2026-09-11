import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, expect, it, vi } from "vitest";
import { counterRpc } from "../shared/counter";
import { settingsContracts } from "../shared/settings";
import { startClient } from "./counter";

const READ = settingsContracts.read.name;

/** A host `rpc` that answers the settings read and the counter action by contract name. */
function hostRpc(options: { titleCounts?: boolean; failRead?: boolean } = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const rpc = vi.fn(async (contract: { name: string }, input: unknown) => {
    calls.push({ method: contract.name, input });
    if (contract.name === READ) {
      if (options.failRead) throw new Error("offline");
      return { status: "ready", revision: "r1", values: { titleCounts: options.titleCounts ?? false } };
    }
    return { paused: !options.titleCounts, updated: 0 };
  });
  return { rpc, calls, context: { rpc } as unknown as PluginClientContext };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("states the stored preference once on connect and never polls", async () => {
  vi.useFakeTimers();
  const host = hostRpc({ titleCounts: false });
  const cleanup = startClient(host.context);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(host.calls).toEqual([
    { method: READ, input: {} },
    { method: counterRpc.name, input: { action: "restore" } },
  ]);
  cleanup();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(host.calls).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("resumes title decoration when the preference is on", async () => {
  vi.useFakeTimers();
  const host = hostRpc({ titleCounts: true });
  startClient(host.context);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(host.calls[1]).toEqual({ method: counterRpc.name, input: { action: "resume" } });
});

it("reports an unreadable preference without issuing a ledger action or retrying", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = hostRpc({ failRead: true });
  const cleanup = startClient(host.context);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(error).toHaveBeenCalled();
  // The read failed, so no title action may follow: guessing would either strip
  // titles the user asked for or decorate titles they asked to leave alone.
  expect(host.calls).toEqual([{ method: READ, input: {} }]);
  cleanup();
});

it("does not schedule work after an in-flight request completes following teardown", async () => {
  vi.useFakeTimers();
  // The stub resolves to nothing usable, so the reconcile is expected to report a
  // failure; what matters here is that it schedules no further work.
  vi.spyOn(console, "error").mockImplementation(() => {});
  let finish!: () => void;
  const rpc = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const cleanup = startClient({ rpc } as unknown as PluginClientContext);
  cleanup();
  finish();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(rpc).toHaveBeenCalledTimes(1);
});
