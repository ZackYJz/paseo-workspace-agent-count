import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  HIDE_TITLE_COUNTS_COMMAND_ID,
  SETTINGS_SCREEN_ID,
  SHOW_TITLE_COUNTS_COMMAND_ID,
  SIDEBAR_ITEM_ID,
  SURFACE_ID,
} from "./shared/contributions";
import { startClient } from "./client/counter";
import { Overview } from "./client/overview";
import { TitleModeSettings } from "./client/settings";
import { setTitleMode, titleModeRpc } from "./client/title-mode";

export default function contribute(client: PluginClientContext) {
  // The surface must exist before the sidebar item points at it.
  client.addSurface(SURFACE_ID, Overview);
  client.addSidebarItem({
    id: SIDEBAR_ITEM_ID,
    title: "Agent 总览",
    icon: "Layers",
    surface: SURFACE_ID,
  });

  client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: "Workspace Agent Count",
    icon: "SlidersHorizontal",
    Component: TitleModeSettings,
  });

  // Both commands go through the same transition the settings switch uses, so
  // the persisted preference and the daemon ledger stay consistent.
  client.addCommandCenterItem({
    id: SHOW_TITLE_COUNTS_COMMAND_ID,
    title: "在标题前显示 Workspace 会话数量",
    icon: "Eye",
    context: "global",
    async onSelect(context) {
      await setTitleMode(titleModeRpc(context), true);
    },
  });
  client.addCommandCenterItem({
    id: HIDE_TITLE_COUNTS_COMMAND_ID,
    title: "恢复原标题并停止改写 Workspace 标题",
    icon: "EyeOff",
    context: "global",
    async onSelect(context) {
      await setTitleMode(titleModeRpc(context), false);
    },
  });

  return startClient(client);
}
