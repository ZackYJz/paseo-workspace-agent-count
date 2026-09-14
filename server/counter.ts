import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { counterRpc } from "../shared/counter";
import { allPages } from "../shared/paging";
import { readDirectoryPage } from "../shared/registry";
import { tallyAgents } from "../shared/tally";
import { watchDirectory } from "./events";

type PaseoApi = PluginHandlerContext["paseo"];
type Workspace = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];
type Input = z.output<typeof counterRpc.input>;
type Result = z.output<typeof counterRpc.output>;
const PAGE_SIZE = 200;
type Watcher = Awaited<ReturnType<typeof watchDirectory>>;

const titleRecord = z.object({
  baseTitle: z.string().nullable(),
  fallbackName: z.string(),
  appliedTitle: z.string(),
  suffix: z.string(),
  pending: z.object({ previousTitle: z.string().nullable(), previousSuffix: z.string().nullable() }).optional(),
});
const stateSchema = z.object({
  version: z.literal(1), paused: z.boolean(), titles: z.record(z.string(), titleRecord),
});
type State = z.output<typeof stateSchema>;
type TitleRecord = z.output<typeof titleRecord>;

export function planTitle(workspace: Pick<Workspace, "name" | "title">, count: number, previous?: TitleRecord): TitleRecord {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid agent count");
  let baseTitle = workspace.title ?? null;
  let fallbackName = workspace.name;
  if (previous && (baseTitle === previous.appliedTitle || (previous.pending && baseTitle === previous.pending.previousTitle))) {
    baseTitle = previous.baseTitle;
    fallbackName = previous.fallbackName;
  } else if (previous) {
    const withoutCurrent = stripOwnedDecoration(baseTitle, previous.suffix);
    baseTitle = withoutCurrent === baseTitle && previous.pending?.previousSuffix
      ? stripOwnedDecoration(baseTitle, previous.pending.previousSuffix)
      : withoutCurrent;
  }
  const suffix = `(${count}) `;
  return { baseTitle, fallbackName, suffix, appliedTitle: `${suffix}${baseTitle ?? fallbackName}` };
}

function stripOwnedDecoration(title: string | null, decoration: string): string | null {
  if (!title) return title;
  // Existing ledgers may contain the old trailing " · N agents" decoration.
  if (decoration.startsWith(" · ") && title.endsWith(decoration)) {
    return title.slice(0, -decoration.length) || null;
  }
  if (title.startsWith(decoration)) {
    return title.slice(decoration.length) || null;
  }
  return title;
}

async function loadState(file: string): Promise<State> {
  try {
    return stateSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, paused: false, titles: {} };
    }
    throw error; // A damaged ledger must never be replaced with an empty one.
  }
}

async function saveState(file: string, state: State) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

async function listWorkspaces(paseo: PaseoApi) {
  return allPages((cursor) => readDirectoryPage(() => paseo.workspaces.list({
    sort: [{ key: "project_id", direction: "asc" }], page: { limit: PAGE_SIZE, cursor },
  })));
}

async function countAgents(paseo: PaseoApi) {
  const entries = await allPages((cursor) => readDirectoryPage(() => paseo.agents.list({
    filter: { includeArchived: true },
    sort: [{ key: "created_at", direction: "asc" }], page: { limit: PAGE_SIZE, cursor },
  })));
  return tallyAgents(entries.map(({ agent }) => agent));
}

async function currentWorkspace(paseo: PaseoApi, id: string) {
  // v0.7.2's daemon honors query, but silently ignores idPrefix for workspaces.
  const page = await readDirectoryPage(() =>
    paseo.workspaces.list({ filter: { query: id }, page: { limit: PAGE_SIZE } }),
  );
  return page.entries.find((workspace) => workspace.id === id && !workspace.archivingAt);
}

async function restore(paseo: PaseoApi, state: State, file: string, watcher: Watcher): Promise<Result> {
  state.paused = true;
  await saveState(file, state);
  let updated = 0;
  for (const [id, previous] of Object.entries(state.titles)) {
    const workspace = await currentWorkspace(paseo, id);
    if (!workspace) continue;
    // A user's newer title wins. Never blindly roll back a manual rename.
    if (workspace.title === previous.appliedTitle || (previous.pending && (workspace.title ?? null) === previous.pending.previousTitle)) {
      watcher.expectTitle(id, previous.baseTitle);
      await paseo.workspaces.ref(id).setTitle(previous.baseTitle);
      updated++;
    }
    delete state.titles[id];
    await saveState(file, state);
  }
  return { paused: true, updated };
}

async function synchronize(paseo: PaseoApi, state: State, file: string, watcher: Watcher): Promise<Result> {
  // Complete both listings before changing any title: failed reads are not zero counts.
  const [workspaces, { counts, busy }] = await Promise.all([listWorkspaces(paseo), countAgents(paseo)]);
  let updated = 0;
  for (const listed of workspaces) {
    if (listed.archivingAt) continue;
    const count = counts.get(listed.id) ?? 0;
    // Title events can disturb Paseo 0.7.2 draft submission. Do not decorate
    // a new empty workspace or write during initialization/foreground work.
    if (busy.has(listed.id) || (count === 0 && !state.titles[listed.id])) continue;
    const planned = planTitle(listed, count, state.titles[listed.id]);
    if (listed.title === planned.appliedTitle && state.titles[listed.id]?.appliedTitle === listed.title && !state.titles[listed.id]?.pending) continue;
    const current = await currentWorkspace(paseo, listed.id);
    if (!current || current.title !== listed.title) continue;
    const next = planTitle(current, count, state.titles[current.id]);
    // Save recovery data before the mutation, so process failure cannot lose the base title.
    const previous = state.titles[current.id];
    state.titles[current.id] = {
      ...next,
      pending: { previousTitle: current.title ?? null, previousSuffix: previous?.suffix ?? null },
    };
    await saveState(file, state);
    if (current.title !== next.appliedTitle) {
      watcher.expectTitle(current.id, next.appliedTitle);
      const result = await paseo.workspaces.ref(current.id).setTitle(next.appliedTitle);
      if (result.title !== next.appliedTitle) throw new Error(`Title update not applied: ${current.id}`);
      updated++;
    }
    state.titles[current.id] = next;
    await saveState(file, state);
  }
  return { paused: false, updated };
}

export function createCounter(file: string) {
  let queue: Promise<unknown> = Promise.resolve();
  let watcher: Watcher | undefined;
  let dirty = false;
  let pumping = false;

  function onChange(context: PluginHandlerContext) {
    dirty = true;
    if (pumping) return;
    pumping = true;
    void (async () => {
      try {
        while (dirty) {
          dirty = false;
          try {
            await run({ action: "sync" }, context);
          } catch {
            // run() logs failures. A newer queued event still deserves its own refresh.
          }
        }
      } finally {
        pumping = false;
      }
    })();
  }

  function run(input: Input, context: PluginHandlerContext): Promise<Result> {
    const { paseo } = context;
    const operation = queue.then(async () => {
      watcher ??= await watchDirectory(paseo, () => onChange(context));
      const state = await loadState(file);
      if (input.action === "restore") return restore(paseo, state, file, watcher);
      if (input.action === "resume") {
        state.paused = false;
        await saveState(file, state);
      }
      if (state.paused) {
        return { paused: state.paused, updated: 0 };
      }
      const result = await synchronize(paseo, state, file, watcher);
      if (result.updated) console.log(`[workspace-agent-count] Updated ${result.updated} workspace titles`);
      return result;
    });
    // Report failures and allow later calls to retry, without poisoning the serial queue.
    queue = operation.catch((error) => console.error("[workspace-agent-count]", error));
    return operation;
  }
  return run;
}

const stateFile = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "workspace-agent-count.json");
export const updateCounter = createCounter(stateFile);
