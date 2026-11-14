import { describe, expect, it } from "vitest";

import config from "../../vitest.config";

type AliasEntry = { find: RegExp | string; replacement: string };

describe("every engine alias is an exact match, because a bare string alias is a prefix replacement that would swallow the bridge subpath", () => {
  it("matches the bare specifier and not its subpath export", () => {
    const aliases = (config as { resolve?: { alias?: AliasEntry[] } }).resolve?.alias ?? [];
    const develop = aliases.find((entry) => entry.find instanceof RegExp && entry.find.test("extension-develop"));

    expect(develop).toBeDefined();
    expect((develop!.find as RegExp).test("extension-develop/bridge")).toBe(false);
    expect(aliases.every((entry) => entry.find instanceof RegExp)).toBe(true);
  });
});
