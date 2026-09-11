import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { counterRpc } from "./shared/counter";
import { displaySettings } from "./shared/settings";
import { updateCounter } from "./server/counter";

/**
 * Daemon-side contributions.
 *
 * Lifecycle events arrive in this subprocess without any client connection, so
 * title reconciliation no longer depends on an app being open. Deletions are not
 * covered by a lifecycle event; `server/events.ts` keeps a directory
 * subscription for those. When title decoration is switched off the ledger is
 * paused and `updateCounter` returns early, so these handlers stay cheap.
 */
export default function contribute(server: PluginServerContext) {
  server.registerSettings(displaySettings);
  server.handle(counterRpc, updateCounter);

  // Every event payload differs, but reconciliation only needs the SDK handle.
  function reconcile(_event: unknown, { paseo }: PluginHookContext) {
    // run() reports its own failures through the serial queue; swallow the
    // rejection here so a lifecycle event cannot produce an unhandled one.
    void updateCounter({ action: "sync" }, { paseo }).catch(() => {});
  }

  const unsubscribe = [
    // A new or archived agent, or a new workspace, can change a count.
    server.on("agent.created", reconcile),
    server.on("agent.archived", reconcile),
    server.on("workspace.created", reconcile),
    // An archived workspace leaves the listable directory, so its decoration must go.
    server.on("workspace.archived", reconcile),
    // Title writes are deferred while an agent is initializing or running; the
    // turn ending is what lifts that deferral.
    server.on("agent.turn_ended", reconcile),
  ];

  return () => {
    for (const off of unsubscribe) off();
  };
}
