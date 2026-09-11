import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const counterRpc = defineRpc({
  name: "counter.update",
  input: z.object({ action: z.enum(["sync", "resume", "restore"]) }),
  output: z.object({ paused: z.boolean(), updated: z.number().int().nonnegative() }),
});
