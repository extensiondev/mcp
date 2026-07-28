import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchesLogQuery, readLogEvents } from "extension-develop/bridge";
import { makeFilter } from "../tools/logs-filter";
import { logsPath } from "../lib/session-paths";
import { schema as logsSchema } from "../tools/logs-schema";

type Event = Record<string, unknown>;

const CORPUS: Event[] = [
  { type: "header", runId: "run-1", v: 1 },
  { context: "background", level: "error", seq: 1, message: "boom" },
  { context: "background", level: "warn", seq: 2, message: "careful" },
  { context: "content", level: "info", seq: 3, url: "https://shop.example/a" },
  { context: "content", level: "log", seq: 4, hostname: "shop.example" },
  { context: "popup", level: "debug", seq: 5, tabId: 7 },
  { context: "options", level: "trace", seq: 6, tabId: 9 },
  {
    context: "background",
    eventType: "dx.signal",
    level: "info",
    seq: 7,
    code: "manifest.invalid",
  },
  { context: "devtools", seq: 8, message: "no level at all" },
  { context: "content", level: "info", seq: 9, url: "http://other.test/x" },
];

function select(predicate: (event: unknown) => boolean): number[] {
  return CORPUS.filter((event) => predicate(event)).map(
    (event) => event.seq as number,
  );
}

/* Every clause below is now the engine's. These assertions are what makes
   deleting this package's copy of the level ranking, the glob matcher, the
   context set and the header rule safe: they pin makeFilter to
   matchesLogQuery's answer on the same corpus, so a divergence in either
   direction fails here rather than quietly changing what an agent sees. */
describe("makeFilter agrees with the engine's matchesLogQuery", () => {
  const cases: Array<{ name: string; args: Record<string, unknown>; query: Record<string, unknown> }> = [
    { name: "no filter", args: {}, query: {} },
    { name: "level all", args: { level: "all" }, query: { level: "all" } },
    { name: "level error", args: { level: "error" }, query: { level: "error" } },
    { name: "level warn", args: { level: "warn" }, query: { level: "warn" } },
    { name: "level info", args: { level: "info" }, query: { level: "info" } },
    { name: "level debug", args: { level: "debug" }, query: { level: "debug" } },
    { name: "level trace", args: { level: "trace" }, query: { level: "trace" } },
    {
      name: "single context",
      args: { context: ["content"] },
      query: { context: ["content"] },
    },
    {
      name: "several contexts",
      args: { context: ["content", "popup"] },
      query: { context: ["content", "popup"] },
    },
    {
      name: "comma separated contexts",
      args: { context: "content,popup" },
      query: { context: "content,popup" },
    },
    { name: "signalsOnly", args: { signalsOnly: true }, query: { signalsOnly: true } },
    { name: "since cursor", args: { since: 4 }, query: { since: 4 } },
    { name: "since zero", args: { since: 0 }, query: { since: 0 } },
    { name: "url glob", args: { url: "https://shop.example/*" }, query: { url: "https://shop.example/*" } },
    {
      name: "unanchored glob, matching mid-url",
      args: { url: "shop.example/*" },
      query: { url: "shop.example/*" },
    },
    {
      name: "unanchored glob, matching a url prefix only",
      args: { url: "https://shop*" },
      query: { url: "https://shop*" },
    },
    {
      name: "glob with regex metacharacters that must stay literal",
      args: { url: "other.test/*" },
      query: { url: "other.test/*" },
    },
    { name: "url bare glob", args: { url: "*.example*" }, query: { url: "*.example*" } },
    { name: "url substring", args: { url: "shop.example" }, query: { url: "shop.example" } },
    { name: "tab id", args: { tab: 7 }, query: { tab: 7 } },
    {
      name: "level plus context plus since",
      args: { level: "info", context: ["content"], since: 3 },
      query: { level: "info", context: ["content"], since: 3 },
    },
  ];

  for (const { name, args, query } of cases) {
    it(`matches the engine for ${name}`, () => {
      const mine = select(makeFilter({ projectPath: "/p", ...args }));
      const theirs = select((event) => matchesLogQuery(event as never, query));
      expect(mine).toEqual(theirs);
    });
  }

  it("drops the header record, which is the engine's rule now", () => {
    const matches = makeFilter({ projectPath: "/p" });
    expect(matches(CORPUS[0])).toBe(false);
  });

  it("keeps treating log as info when ranking severity", () => {
    const info = makeFilter({ projectPath: "/p", level: "info" });
    expect(info({ context: "content", level: "log" })).toBe(true);
    const warn = makeFilter({ projectPath: "/p", level: "warn" });
    expect(warn({ context: "content", level: "log" })).toBe(false);
  });

  it("keeps an unknown or absent level below every threshold", () => {
    const trace = makeFilter({ projectPath: "/p", level: "trace" });
    expect(trace({ context: "devtools" })).toBe(false);
    expect(trace({ context: "devtools", level: "wat" })).toBe(false);
    const all = makeFilter({ projectPath: "/p", level: "all" });
    expect(all({ context: "devtools" })).toBe(true);
  });

  it("rejects a non-object, which the engine also rejects", () => {
    const matches = makeFilter({ projectPath: "/p" });
    expect(matches(null)).toBe(false);
    expect(matches("a line")).toBe(false);
  });
});

/* The one clause deliberately NOT delegated. extension_logs and `extension
   logs` mean opposite things by level 'off', and this test states which is
   which so nobody "fixes" the divergence by accident. */
describe("level off is this package's meaning, not the engine's", () => {
  it("the engine treats off as a synonym for all", () => {
    const theirs = select((event) =>
      matchesLogQuery(event as never, { level: "off" }),
    );
    expect(theirs).toEqual(select((event) => matchesLogQuery(event as never, {})));
    expect(theirs).toContain(1);
  });

  it("extension_logs treats off as logging disabled, signals only", () => {
    const mine = select(makeFilter({ projectPath: "/p", level: "off" }));
    expect(mine).toEqual([7]);
  });

  it("expresses off as the engine's own clauses rather than a private rule", () => {
    const mine = select(makeFilter({ projectPath: "/p", level: "off" }));
    const equivalent = select((event) =>
      matchesLogQuery(event as never, { level: "all", signalsOnly: true }),
    );
    expect(mine).toEqual(equivalent);
  });

  it("still applies the other clauses at level off", () => {
    const scoped = makeFilter({
      projectPath: "/p",
      level: "off",
      context: ["popup"],
    });
    expect(select(scoped)).toEqual([]);
  });
});

/* The engine publishes logLevelRank and LOG_LEVEL_ORDER, and nothing in this
   package ranks or orders levels by hand: makeFilter hands every severity
   comparison to matchesLogQuery, which applies the engine's rank. What this
   package does own is the VOCABULARY the tool schema offers an agent, and that
   is a separate copy of the same ordering, written as a JSON Schema enum.
   Reordering the engine's rank without touching the enum would leave the schema
   promising "a level includes everything more severe" about an order that is no
   longer the one being applied, so the enum is checked against the engine's
   observable rank rather than against LOG_LEVEL_ORDER, which the pinned bridge
   entry does not export. */
describe("the schema's level vocabulary matches the engine's rank", () => {
  const severities = (logsSchema.inputSchema.properties.level.enum as string[])
    .filter((level) => level !== "all" && level !== "off");

  it("offers exactly the levels the engine ranks, in the engine's order", () => {
    const selected = severities.map(
      (level) =>
        CORPUS.filter((event) =>
          matchesLogQuery(event as never, { level }),
        ).length,
    );
    for (let i = 1; i < selected.length; i += 1) {
      expect(
        selected[i],
        `${severities[i]} must select at least as much as ${severities[i - 1]}`,
      ).toBeGreaterThanOrEqual(selected[i - 1]);
    }
    expect(selected[0]).toBeLessThan(selected[selected.length - 1]);
  });

  /* The console emits `log`; the filter vocabulary calls it `info`, and the
     engine's rank is what aliases the two. Offering `log` in the enum would
     imply a sixth level that ranks separately, which it does not. */
  it("does not offer log as a level of its own", () => {
    expect(severities).not.toContain("log");
    expect(severities).toContain("info");
  });
});

describe("readLogEvents reads the file the path helper names", () => {
  it("reads through logsPath and filters with the same query rules", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-logs-read-"));
    const file = logsPath(project, "chrome");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${CORPUS.map((event) => JSON.stringify(event)).join("\n")}\nnot json\n`,
    );

    const errors = readLogEvents(project, "chrome", { level: "error" });
    expect(errors.map((event) => (event as Event).seq)).toEqual([1]);

    const all = readLogEvents(project, "chrome", {});
    expect(all.map((event) => (event as Event).seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("returns an empty array for a project that never logged", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-logs-none-"));
    expect(readLogEvents(project, "chrome", {})).toEqual([]);
  });
});
