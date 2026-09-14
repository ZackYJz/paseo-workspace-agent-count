/**
 * Tolerance for a daemon that has never written a directory registry.
 *
 * Paseo 0.8.0 creates its workspace registry file lazily. On a daemon that has
 * never had a workspace, `workspaces.list` fails with
 * `ENOENT ... lstat '<home>/projects/workspaces.json'` instead of returning an
 * empty page, and the raw error reaches the user as a failed RPC. A daemon with
 * no agents can fail the same way on its own registry.
 *
 * The tolerance is scoped to a single listing call on purpose: a directory
 * listing can only ENOENT on its own registry, so inside that call ENOENT means
 * "this directory has never held an entry", which is the truth rather than a
 * failure. Every other error still propagates, and a mid-session read failure
 * keeps the previous snapshot where that contract applies.
 */
export function isMissingDirectoryRegistry(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ENOENT");
}

export interface DirectoryPage<E> {
  entries: E[];
  pageInfo: { nextCursor?: string | null; hasMore: boolean };
}

export function emptyPage<E>(): DirectoryPage<E> {
  return { entries: [], pageInfo: { nextCursor: null, hasMore: false } };
}

/**
 * Reads one directory page, reporting a never-created registry as an empty page.
 *
 * The cast is bounded: callers only read `entries` and the two pageInfo fields,
 * both of which the empty page supplies.
 */
export function readDirectoryPage<E, P extends DirectoryPage<E>>(read: () => Promise<P>): Promise<P> {
  return read().catch((error: unknown) => {
    if (!isMissingDirectoryRegistry(error)) throw error;
    return emptyPage<E>() as P;
  });
}
