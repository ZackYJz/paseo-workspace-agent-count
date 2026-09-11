import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { agentChangeKey, workspaceChangeKey } from "../shared/changes";

type PaseoApi = PluginHandlerContext["paseo"];
const SEED_PAGE_SIZE = 200;

export async function watchDirectory(paseo: PaseoApi, onChange: () => void) {
  const agents = new Map<string, string | null>();
  const workspaces = new Map<string, string | null>();
  const ownTitles = new Map<string, string | null>();
  const stopAgents = paseo.agents.subscribe((event) => {
    const id = event.kind === "remove" ? event.agentId : event.agent.id;
    const key = event.kind === "remove" ? null : agentChangeKey(event.agent);
    if (agents.has(id) && agents.get(id) === key) return;
    agents.set(id, key);
    onChange();
  });
  const stopWorkspaces = paseo.workspaces.subscribe((event) => {
    const id = event.kind === "remove" ? event.id : event.workspace.id;
    const key = event.kind === "remove" ? null : workspaceChangeKey(event.workspace);
    const unchanged = workspaces.has(id) && workspaces.get(id) === key;
    workspaces.set(id, key);
    if (event.kind === "upsert" && ownTitles.has(id) && ownTitles.get(id) === (event.workspace.title ?? null)) {
      ownTitles.delete(id);
      return; // Do not feed this plugin's title writes back into synchronization.
    }
    if (!unchanged) onChange();
  });
  try {
    // Use the plugin subprocess session, never replace the app's own subscriptions.
    // In v0.7 the filter, not the seed page, determines which live entries emit events.
    // Paseo 0.8 issues each observation its own subscription ID and reissues it on
    // reconnect, so the request carries an empty `subscribe` instead of a chosen ID.
    const [agentPage, workspacePage] = await Promise.all([
      paseo.agents.list({ filter: { includeArchived: true }, subscribe: {}, page: { limit: SEED_PAGE_SIZE } }),
      paseo.workspaces.list({ subscribe: {}, page: { limit: SEED_PAGE_SIZE } }),
    ]);
    for (const { agent } of agentPage.entries) {
      if (!agents.has(agent.id)) agents.set(agent.id, agentChangeKey(agent));
    }
    for (const workspace of workspacePage.entries) {
      if (!workspaces.has(workspace.id)) workspaces.set(workspace.id, workspaceChangeKey(workspace));
    }
  } catch (error) {
    stopAgents();
    stopWorkspaces();
    throw error;
  }
  // Paseo closes this dedicated SDK session and subprocess on disable/reload/removal.
  return { expectTitle: (id: string, title: string | null) => { ownTitles.set(id, title); } };
}
