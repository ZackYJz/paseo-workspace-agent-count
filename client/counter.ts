import type { PluginClientContext } from "@getpaseo/plugin/client";
import { reconcileTitleMode, titleModeRpc } from "./title-mode";

/**
 * Runs when a client connects.
 *
 * The daemon owns the directory subscription and the lifecycle events, so it
 * keeps counts current without any client. A connecting client only states the
 * persisted title-mode preference, which also cleans up decorations left behind
 * by an earlier version when the switch is off. Nothing here polls.
 */
export function startClient(client: PluginClientContext) {
  void reconcileTitleMode(titleModeRpc(client)).catch((error) => {
    console.error(
      "[workspace-agent-count] 初始化失败，可在 Settings → Plugins → Workspace Agent Count 里重试",
      error,
    );
  });
  return () => {};
}
