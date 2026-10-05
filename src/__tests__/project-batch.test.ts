import { describe, expect, it } from "vitest";

import {
  MAX_BATCH_PROJECTS,
  PLATFORM_CREATES_PER_HOUR,
  createRateLimitNote,
  isExactProjectSlug,
  parseProjectBatch,
  sameProjectSet,
} from "../lib/project-batch";

const names = (count: number, workspace = "acme") =>
  Array.from({ length: count }, (_, i) => `${workspace}/app-${i + 1}`);

describe("parseProjectBatch mirrors the platform's list rules", () => {
  it("accepts one workspace and keeps the order sent, lowercased", () => {
    expect(parseProjectBatch(["Acme/Beta", " acme/alpha "])).toEqual({
      ok: true,
      batch: {
        workspace: "acme",
        slugs: ["beta", "alpha"],
        refs: ["acme/beta", "acme/alpha"],
      },
    });
  });

  it("accepts one name and exactly twenty", () => {
    expect(parseProjectBatch(names(1)).ok).toBe(true);
    expect(parseProjectBatch(names(MAX_BATCH_PROJECTS)).ok).toBe(true);
  });

  it("refuses twenty-one names and an empty list, saying the range", () => {
    for (const list of [names(21), []]) {
      const out = parseProjectBatch(list);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.message).toContain("between 1 and 20");
    }
  });

  it.each([
    ["a string", "acme/app"],
    ["an object", { 0: "acme/app" }],
    ["nothing", undefined],
  ])("refuses %s where a list belongs", (_label, value) => {
    const out = parseProjectBatch(value);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("must be an array");
  });

  it.each([
    ["a bare slug", "app"],
    ["three segments", "acme/app/extra"],
    ["an empty project", "acme/"],
    ["a number", 7],
    ["an object", { project: "acme/app" }],
  ])("refuses the whole list over %s", (_label, bad) => {
    const out = parseProjectBatch(["acme/good", bad]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("<workspace>/<project>");
  });

  it("refuses a second workspace and names both", () => {
    const out = parseProjectBatch(["acme/app", "globex/tool"]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain("globex");
      expect(out.message).toContain("acme");
      expect(out.message).toContain("one workspace");
    }
  });

  it("refuses a name given twice, including one that differs only by case", () => {
    for (const list of [
      ["acme/app", "acme/app"],
      ["acme/app", "ACME/App"],
    ]) {
      const out = parseProjectBatch(list);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.message).toContain("named twice");
    }
  });

  it.each([
    ["a dot", "acme/my.app"],
    ["an underscore", "acme/my_app"],
    ["a space", "acme/my app"],
    ["a leading dash", "acme/-app"],
    ["a trailing dash", "acme/app-"],
    ["a doubled dash", "acme/my--app"],
    ["a lone dash", "acme/-"],
    ["forty-nine characters", `acme/${"p".repeat(49)}`],
  ])("refuses a name with %s, which the platform would rename", (_label, bad) => {
    const out = parseProjectBatch(["acme/good", bad]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("exact slug");
  });

  it("accepts a slug of exactly forty-eight characters", () => {
    expect(parseProjectBatch([`acme/${"p".repeat(48)}`]).ok).toBe(true);
    expect(isExactProjectSlug("p".repeat(48))).toBe(true);
    expect(isExactProjectSlug("p".repeat(49))).toBe(false);
  });

  it("refuses a workspace longer than the platform stores", () => {
    expect(parseProjectBatch([`${"w".repeat(65)}/app`]).ok).toBe(false);
    expect(parseProjectBatch([`${"w".repeat(64)}/app`]).ok).toBe(true);
  });
});

describe("sameProjectSet", () => {
  it("ignores order and case, and refuses a subset or a superset", () => {
    expect(sameProjectSet(["a", "b"], ["B", "a"])).toBe(true);
    expect(sameProjectSet(["a", "b"], ["a"])).toBe(false);
    expect(sameProjectSet(["a"], ["a", "b"])).toBe(false);
    expect(sameProjectSet(["a", "b"], ["a", "c"])).toBe(false);
  });
});

describe("the creation limit is named, with its number", () => {
  it("states ten per hour and the fifteen minute grant", () => {
    expect(PLATFORM_CREATES_PER_HOUR).toBe(10);
    expect(createRateLimitNote()).toContain("at most 10 projects per hour");
    expect(createRateLimitNote()).toContain("15 minutes");
  });
});
