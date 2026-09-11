import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { z } from "zod";
import { counterRpc } from "../shared/counter";
import { displaySettings, settingsContracts } from "../shared/settings";

type ReadResult = RpcOutput<typeof settingsContracts.read>;
type WriteInput = RpcInput<typeof settingsContracts.write>;
type WriteResult = RpcOutput<typeof settingsContracts.write>;
type CounterInput = RpcInput<typeof counterRpc>;
type CounterResult = RpcOutput<typeof counterRpc>;
type SettingsValues = z.output<typeof displaySettings.schema>;
type JsonValue = WriteInput["values"];
type JsonObject = { [key: string]: JsonValue };

/** Bound RPC calls, so a component and a Command Center callback can both supply them. */
export interface TitleModeRpc {
  readSettings(): Promise<ReadResult>;
  writeSettings(input: RpcInput<typeof settingsContracts.write>): Promise<WriteResult>;
  updateCounter(input: CounterInput): Promise<CounterResult>;
}

/** Both `PluginClientContext` and a command context expose this `rpc`. */
export interface RpcCapable {
  rpc: PluginClientContext["rpc"];
}

/**
 * Binds the three calls the transition needs.
 *
 * Each call site passes a concrete contract, so the generic `rpc` signature
 * resolves here instead of being passed around as a value.
 */
export function titleModeRpc(host: RpcCapable): TitleModeRpc {
  return {
    readSettings: () => host.rpc(settingsContracts.read, {}),
    writeSettings: (input) => host.rpc(settingsContracts.write, input),
    updateCounter: (input) => host.rpc(counterRpc, input),
  };
}

/**
 * Narrows the host's generic JSON payload to this plugin's schema.
 *
 * A `ready` status means the host accepted the stored document, but the wire
 * type is untyped JSON, so the schema is the only thing that makes the value
 * safe to read. Invalid data is reported rather than defaulted, matching how the
 * daemon ledger treats a damaged file.
 *
 * The raw payload is returned alongside the parsed one: parsing strips keys this
 * schema version does not declare, and a write must not silently drop them from a
 * document a newer version of this plugin may own.
 */
function readValues(result: ReadResult): {
  revision: string;
  values: SettingsValues;
  raw: JsonObject;
} {
  if (result.status !== "ready") throw new Error(`插件设置数据无效：${result.error}`);
  const parsed = displaySettings.schema.safeParse(result.values);
  if (!parsed.success) throw new Error(`插件设置数据无效：${parsed.error.message}`);
  const stored = result.values;
  const raw: JsonObject =
    typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored : {};
  return { revision: result.revision, values: parsed.data, raw };
}

/**
 * Maps the persisted preference onto the daemon ledger.
 *
 * The settings document is the source of truth for title mode; the ledger's
 * `paused` flag is only its daemon-side mirror. This is the one place that
 * decides which action a preference means, so the surface, the settings screen,
 * the Command Center, and reconnect cannot disagree.
 */
export function applyTitleMode(calls: TitleModeRpc, titleCounts: boolean): Promise<CounterResult> {
  return calls.updateCounter({ action: titleCounts ? "resume" : "restore" });
}

/** Reads the stored preference and applies it. Used when a client connects. */
export async function reconcileTitleMode(calls: TitleModeRpc): Promise<CounterResult> {
  const { values } = readValues(await calls.readSettings());
  return applyTitleMode(calls, values.titleCounts);
}

/**
 * Writes the preference, then applies it.
 *
 * The write is revision-checked by the host, so a concurrent change from another
 * client surfaces as a conflict instead of being overwritten. A failed write
 * leaves the ledger untouched, so the two can never diverge silently.
 */
export async function setTitleMode(
  calls: TitleModeRpc,
  titleCounts: boolean,
): Promise<CounterResult> {
  const { revision, raw } = readValues(await calls.readSettings());
  const written = await calls.writeSettings({ revision, values: { ...raw, titleCounts } });
  if (written.status !== "saved") {
    throw new Error(
      written.status === "conflict"
        ? `设置已被其他客户端修改，请重试：${written.error}`
        : `设置保存失败：${written.error}`,
    );
  }
  return applyTitleMode(calls, titleCounts);
}
