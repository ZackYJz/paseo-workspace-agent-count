import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped preferences for this installation.
 *
 * `titleCounts` is the only switch: the overview surface and the header button
 * are always on, while rewriting workspace titles is opt-in because it mutates
 * persisted user data.
 */
export const displaySettings = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({
    titleCounts: z.boolean().default(false),
  }),
});

/**
 * The host-implemented read/write/reset contracts for the document above.
 * Created once so every call site uses the same method names.
 */
export const settingsContracts = settingsRpc(displaySettings.id);
