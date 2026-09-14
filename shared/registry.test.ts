import { describe, expect, it } from "vitest";
import { emptyPage, isMissingDirectoryRegistry, readDirectoryPage } from "./registry";

describe("isMissingDirectoryRegistry", () => {
  it("recognises the daemon's lazy-registry ENOENT", () => {
    expect(
      isMissingDirectoryRegistry(
        new Error(
          "ENOENT: no such file or directory, lstat '/Users/jachin/.paseo/projects/workspaces.json'",
        ),
      ),
    ).toBe(true);
  });

  it("does not swallow unrelated failures", () => {
    expect(isMissingDirectoryRegistry(new Error("offline"))).toBe(false);
    expect(isMissingDirectoryRegistry(new Error("EACCES: permission denied"))).toBe(false);
    expect(isMissingDirectoryRegistry("boom")).toBe(false);
    expect(isMissingDirectoryRegistry(undefined)).toBe(false);
  });
});

describe("readDirectoryPage", () => {
  it("passes a successful page through untouched", async () => {
    const page = { entries: [1, 2], pageInfo: { nextCursor: null, hasMore: false } };
    await expect(readDirectoryPage(async () => page)).resolves.toBe(page);
  });

  it("reports a never-created registry as an empty page", async () => {
    const page = { entries: [], pageInfo: { nextCursor: null, hasMore: false } };
    const read = async (): Promise<typeof page> => {
      throw new Error("ENOENT: no such file or directory, lstat '/x/workspaces.json'");
    };
    await expect(readDirectoryPage(read)).resolves.toEqual(emptyPage());
  });

  it("rethrows every other failure", async () => {
    const read = async () => {
      throw new Error("offline");
    };
    await expect(readDirectoryPage(read)).rejects.toThrow("offline");
  });
});
