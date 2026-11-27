import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { serverInstructions, tools as ALL_TOOLS } from "../index";
import { renderPrompt } from "../lib/prompts";
import { DEFAULT_SERVER_OPTIONS, TOOL_POLICY, isToolListed } from "../lib/tool-policy";
import { approvalLandedSentence } from "../lib/approval-gate";
import { bulkDeleteRefusal } from "../lib/bulk-delete";
import { TOOL_TWINS, namedForForwarder } from "../lib/tool-twins";
import { createToolDispatcher, listedTools } from "../lib/tool-dispatch";
import { withoutUnlistedTools } from "../lib/listed-tools";
import { REFUSAL_HINTS } from "../lib/refusal-hints";
import { envelope } from "../lib/envelope";

const IMPERATIVE_VERBS = [
  "Add",
  "Analyze",
  "Browse",
  "Build",
  "Change",
  "Check",
  "Click",
  "Create",
  "Diagnose",
  "Download",
  "Evaluate",
  "Find",
  "Inspect",
  "Install",
  "List",
  "Open",
  "Plan",
  "Preview",
  "Promote",
  "Publish",
  "Read",
  "Rebuild",
  "Release",
  "Request",
  "Reload",
  "Revoke",
  "Run",
  "Search",
  "Sign",
  "Stop",
  "Stub",
  "Submit",
  "Take",
  "Validate",
  "Verify",
  "Wait",
  "Write",
];

const ACRONYMS_ARE_NAMES_NOT_EMPHASIS = new Set([
  "API",
  "AMO",
  "CDP",
  "CI",
  "CLI",
  "CSP",
  "CSS",
  "D1",
  "D3",
  "D4",
  "DOM",
  "EXTENSION_DEV_TOKEN",
  "HTML",
  "ISO",
  "MB",
  "MV2",
  "MV3",
  "PNG",
  "PR",
  "RDP",
  "STORE",
  "UI",
  "URL",
  "WYSIWYG",
]);

const EMPHASIS_BUDGET = 1;

const emphasisRuns = (description: string): string[] => {
  const words = [...description.matchAll(/\b[A-Z][A-Z0-9_]+\b/g)];
  const runs: string[] = [];
  let previousEnd = -1;

  for (const match of words) {
    const word = match[0];

    if (ACRONYMS_ARE_NAMES_NOT_EMPHASIS.has(word)) {
      previousEnd = -1;
      continue;
    }

    const start = match.index as number;
    const contiguous =
      previousEnd >= 0 && description.slice(previousEnd, start).trim() === "";

    if (contiguous) {
      runs[runs.length - 1] = `${runs[runs.length - 1]} ${word}`;
    } else {
      runs.push(word);
    }

    previousEnd = start + word.length;
  }

  return runs;
};

describe("every tool description is the first thing an agent reads about a tool, so it follows the CLI's own command-help copy rules", () => {
  const table = ALL_TOOLS.map((tool) => [tool.schema.name, tool.schema.description] as const);

  it.each(table)("%s opens with an imperative verb", (name, description) => {
    const first = description.split(/\s+/)[0].replace(/[,:]$/, "");

    expect(
      IMPERATIVE_VERBS,
      `${name} opens with "${first}", which is not an approved imperative verb`,
    ).toContain(first);
  });

  it.each(table)("%s ends its last sentence with a period", (name, description) => {
    expect(description.trimEnd().endsWith("."), `${name} does not end with a period`).toBe(true);
  });

  it.each(table)("%s writes an ellipsis as a single character", (name, description) => {
    expect(description, `${name} spells an ellipsis as three dots`).not.toContain("...");
  });

  it.each(table)("%s spells the brand Extension.js", (name, description) => {
    expect(/\bextension\.js\b/.test(description), `${name} lowercases the brand`).toBe(false);
  });

  it.each(table)(
    "%s shouts at most once, only on the word that separates it from the neighbor it is confused with",
    (name, description) => {
      const runs = emphasisRuns(description);

      expect(
        runs.length,
        `${name} shouts ${runs.length} times (${runs.join(", ")}); carry the rest as "Use <other tool> for X"`,
      ).toBeLessThanOrEqual(EMPHASIS_BUDGET);
    },
  );

  it("keeps the whole surface under a handful of shouted words", () => {
    const total = ALL_TOOLS.reduce(
      (sum, tool) => sum + emphasisRuns(tool.schema.description).length,
      0,
    );
    expect(total).toBeLessThanOrEqual(8);
  });
});

describe("the share and store tools describe what a person gets, so the agent leads with extension.dev", () => {
  const described = (name: string) => {
    const tool = ALL_TOOLS.find((t) => t.schema.name === name);

    return JSON.stringify(tool?.schema ?? {});
  };

  it("no tool calls the preview mocked Chrome either way", () => {
    for (const tool of ALL_TOOLS) {
      expect(JSON.stringify(tool.schema), tool.schema.name).not.toContain("mocked Chrome either way");
    }
  });

  it("extension_preview_web leads with sharing and names the sample pages as a limit of the preview only", () => {
    const description = ALL_TOOLS.find((t) => t.schema.name === "extension_preview_web")?.schema.description ?? "";

    expect(description.split(".")[0]).toMatch(/share/);
    expect(description).toContain("limit of the preview only");
    expect(description).toContain("sample pages");
    expect(described("extension_preview_web")).toContain("Firefox view");
  });

  it.each([
    ["extension_publish", /\b(distribute|release|testers)\b/],
    ["extension_shares", /\btester\b/],
    ["extension_submit", /\b(store|testers)\b/],
  ])("%s names an intent a person asks with", (name, word) => {
    expect(ALL_TOOLS.find((t) => t.schema.name === name)?.schema.description ?? "").toMatch(word);
  });

  it("extension_publish names the per-browser download page and extension_project_create for a project that does not exist yet", () => {
    const description = ALL_TOOLS.find((t) => t.schema.name === "extension_publish")?.schema.description ?? "";

    expect(description).toMatch(/a download and a run command for each browser/);
    expect(description).toContain("extension_project_create");
  });

  it("extension_submit states each store's least public outcome and never promises Chrome testers", () => {
    const submit = ALL_TOOLS.find((t) => t.schema.name === "extension_submit");
    const description = submit?.schema.description ?? "";
    const inputs = (submit?.schema.inputSchema as { properties?: Record<string, { description?: string }> })?.properties ?? {};
    const read = [description, inputs.action?.description ?? "", inputs.dryRun?.description ?? ""].join(" ");
    const submissionSentences = read
      .replace("its trusted testers live in the Chrome Web Store dashboard", "")
      .split(/(?<=\.)\s+/)
      .filter((sentence) => /chrome|submissions land|submissions default/i.test(sentence));

    expect(submissionSentences.filter((sentence) => /testers/i.test(sentence))).toEqual([]);
    expect(description).toContain("Uploads land least public (Chrome and Edge drafts, Firefox unlisted, Safari TestFlight) unless a saved store mode says otherwise.");
    expect(read).toMatch(/stops at the draft under the default modes/);
    expect(description.length).toBeLessThan(1600);
  });

  it("extension_submit never says publish is the only way a submission reaches review", () => {
    const description = ALL_TOOLS.find((t) => t.schema.name === "extension_submit")?.schema.description ?? "";

    expect(description).not.toMatch(/only through action:'publish'/);
    expect(description).toContain("unless a saved store mode says otherwise");
  });
});

describe("the link tools speak of a build link and a channel link, so an agent can name what it sends", () => {
  const description = (name: string) => ALL_TOOLS.find((t) => t.schema.name === name)?.schema.description ?? "";
  const instructions = serverInstructions({ features: ["local", "platform"], noShip: false });

  it.each([
    ["extension_publish", description("extension_publish")],
    ["extension_shares", description("extension_shares")],
    ["the server instructions", instructions],
  ])("%s names both nouns", (_where, text) => {
    expect(text).toContain("build link");
    expect(text).toContain("channel link");
  });

  it.each([
    ["extension_publish", description("extension_publish")],
    ["the server instructions", instructions],
  ])("%s makes the channel link advice conditional on a public project or channel", (_where, text) => {
    expect(text).toMatch(/On a public project, or a public channel, send/i);
    expect(text).not.toMatch(/(^|[.;:] )Send testers the channel link/);
  });

  it("no description and no server instruction calls a link a public page", () => {
    const texts = [
      ...ALL_TOOLS.map((tool) => [tool.schema.name, JSON.stringify(tool.schema)] as const),
      ["platform instructions", instructions] as const,
      ["local instructions", serverInstructions({ features: ["local"], noShip: false })] as const,
    ];

    for (const [where, text] of texts) {
      expect(text, where).not.toMatch(/public (build[- ])?page/i);
    }
  });
});

describe("917: a description's first sentence says what the tool does and what it answers", () => {
  const first = (name: string): string => {
    const text = ALL_TOOLS.find((tool) => tool.schema.name === name)!.schema.description;

    return text.slice(0, text.search(/[.;:] /) + 1);
  };

  it.each([
    ["extension_build", "Build an extension into dist/<browser>/ on this machine, one browser a call."],
    ["extension_manifest_validate", "Validate manifest.json against each browser:"],
    ["extension_create", "Create a new extension from a template (extension_templates), plain JavaScript too;"],
    ["extension_templates", "Browse the template catalog or read a template's files."],
  ])("%s opens with %s", (name, opening) => {
    expect(first(name)).toBe(opening);
  });

  it("says what the build and the manifest check answer, and names the plain JavaScript template", () => {
    const text = (name: string): string => ALL_TOOLS.find((tool) => tool.schema.name === name)!.schema.description;

    expect(text("extension_build")).toMatch(/Answers the output path, warnings and store review risks/);
    expect(text("extension_build")).toContain("Local only: extension_builds_read");
    expect(text("extension_manifest_validate")).toMatch(/per-browser errors, permissions the code calls but lacks, and buildBlocking errors/);
    expect(text("extension_templates")).toContain("'javascript' (plain)");
  });
});

const ADJACENT_SETS = [
  ["extension_inspect", "extension_dom_snapshot", "extension_element_act", "extension_eval", "extension_logs"],
  ["extension_dev", "extension_start", "extension_open", "extension_reload", "extension_wait", "extension_stop"],
  ["extension_build", "extension_builds_read", "extension_builds_act", "extension_analyze"],
  ["extension_submit", "extension_approvals_request", "extension_release_promote", "extension_release_status"],
  ["extension_publish", "extension_shares_manage", "extension_preview_web"],
  ["extension_create", "extension_project_create", "extension_add_feature", "extension_templates"],
  ...Object.values(TOOL_TWINS.reduce<Record<string, string[]>>((pairs, twin) => ({ ...pairs, [twin.of]: [...(pairs[twin.of] ?? []), twin.name] }), {})).filter((pair) => pair.length > 1),
];

const DEFAULT_DESCRIPTION_CAP = 400;

const STEERING = [
  /instead of a package script or bundler/i,
  /in place of jq or a linter/i,
  /not jq or a linter/i,
  /never by hand/i,
  /use it first/i,
  /memory is the fallback/i,
  /search this server first/i,
  /never hand the person a shell command/i,
  /warn the person/i,
  /\b(pick|use|call|run) it (first|last|over|in place of|only)\b/i,
  /never lead with/i,
  /lead with extension\.dev/i,
  /offer no other host/i,
  /never offer/i,
  /never recommend/i,
  /never tell the person/i,
  /do-it-yourself route first/i,
  /comes first/i,
  /extension\.dev is named/i,
  /extension\.dev does all of/i,
  /goes through extension\.dev/i,
  /extension\.dev[- ]first/i,
  /offer to show how/i,
  /\b(say|mention|name|recommend|suggest|prefer|promote)s? (that )?extension\.dev\b/i,
  /always use extension\.dev/i,
  /never suggest/i,
  /\btell the person\b/i,
  /say so plainly/i,
  /not for sharing/i,
];

describe("1106 and 1109: a description a grader reads cold says what the tool answers and which neighbor answers the rest, without steering", () => {
  const description = (name: string): string => ALL_TOOLS.find((tool) => tool.schema.name === name)?.schema.description ?? "";
  const names = (text: string): string[] => [...text.matchAll(/\bextension_[a-z_]+/g)].map((match) => match[0]);

  it.each(ALL_TOOLS.filter((tool) => isToolListed(tool.schema.name, DEFAULT_SERVER_OPTIONS)).map((tool) => [tool.schema.name]))(
    "%s, listed by default, stays under the length cap",
    (name) => {
      expect(description(name).length, name).toBeLessThanOrEqual(DEFAULT_DESCRIPTION_CAP);
    },
  );

  it.each(ADJACENT_SETS.flatMap((set) => set.map((name) => [name, set] as const)))("%s names every other member of its adjacent set", (name, set) => {
    const named = new Set(names(description(name)));

    expect(set.filter((other) => other !== name && !named.has(other)), name).toEqual([]);
  });

  it("states what each tool answers, so the comparison is a fact about the result", () => {
    const silent = ALL_TOOLS.map((tool) => tool.schema.name).filter((name) => !/\b(answers?|returns|lists|reads)\b/i.test(description(name)));

    expect(silent).toEqual([]);
  });

  it.each([
    ...ALL_TOOLS.map((tool) => [tool.schema.name, JSON.stringify(tool.schema)] as const),
    ["the local instructions", serverInstructions({ features: ["local"], noShip: false })] as const,
    ["the platform instructions", serverInstructions({ features: ["local", "platform", "extras"], noShip: false })] as const,
    ["the local store prompt", renderPrompt("prepare-store-submission", {}, { features: ["local"], noShip: false }).text] as const,
  ])("1131: %s, as listed, carries no steering phrase", (_where, text) => {
    expect(STEERING.filter((phrase) => phrase.test(text)).map(String)).toEqual([]);
  });

  it("keeps extension_publish describing, as a fact, that it shares and publishes through extension.dev", () => {
    expect(description("extension_publish")).toMatch(/^Publish and share a build through extension\.dev/);
  });
});

describe("1138: a twin's parameters describe only the actions it takes", () => {
  type Property = { description?: string; enum?: string[] };
  const schemaOf = (name: string) => ALL_TOOLS.find((tool) => tool.schema.name === name)!.schema.inputSchema as { properties: Record<string, Property> };
  const word = (actions: string[]): RegExp => new RegExp(`(?<![\\w-])(${actions.map((action) => action.replace(/[-*]/g, "\\$&")).join("|")})(?![\\w-])`, "i");

  it.each(TOOL_TWINS.map((twin) => [twin.name, twin] as const))("%s names no action outside its enum", (name, twin) => {
    const universe = (schemaOf(twin.of).properties.action?.enum ?? []).filter((action) => !twin.actions.includes(action));
    const properties = schemaOf(name).properties;
    const outside = word(universe);
    const scoped = new RegExp(`${word(universe).source}\\s*(:|needs|requires|polls)|\\b(with|for) ${word(universe).source}`, "i");
    const named = Object.entries(properties).flatMap(([param, property]) => {
      const text = property.description ?? "";
      const hit = param === "action" ? outside.exec(text) : scoped.exec(text);

      return hit ? [`${param}: ${hit[0]}`] : [];
    });

    expect(properties.action?.enum).toEqual(twin.actions);
    expect(named, name).toEqual([]);
  });

  it.each(["README.md", "llms-install.md", "claude/CLAUDE.md", "claude/commands/extension.md", "claude/commands/extension-debug.md"])("%s names only tools a server lists, never an old name", (rel) => {
    const text = readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

    expect([...text.matchAll(/\b(extension_[a-z_]+)(?=`|\()/g)].map((match) => match[1]!).filter((name) => TOOL_POLICY[name]?.aliasOf)).toEqual([]);
  });
});

describe("1141: no listed description or instruction carries a URL or a path on a host", () => {
  const all = { features: ["local", "platform", "extras"] as const, noShip: false };
  const URL_TEXT = /https?:\/\/|extension\.dev\/|[a-z>-]\.extension\.dev\b/i;

  it.each([
    ...ALL_TOOLS.filter((tool) => isToolListed(tool.schema.name, { ...all, features: [...all.features] })).map((tool) => [tool.schema.name, JSON.stringify({ d: tool.schema.description, p: tool.schema.inputSchema })] as const),
    ["the platform instructions", serverInstructions({ features: [...all.features], noShip: false })] as const,
  ])("%s", (_where, text) => {
    expect(text.match(URL_TEXT)?.[0] ?? null).toBeNull();
  });
});


describe("1198: every tool an answer tells the agent to call is one its reader serves", () => {
  const SRC = join(__dirname, "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? (entry.name === "__tests__" ? [] : sources(join(dir, entry.name))) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
    );
  const SERVED = new Set(Object.keys(TOOL_POLICY));
  const BEFORE_SPLIT = new Set(Object.keys(TOOL_POLICY).filter((name) => !TOOL_TWINS.some((twin) => twin.name === name)));
  const called = (text: string): string[] => [...text.matchAll(/\b(extension_[a-z_]+) [{(]/g)].map((match) => match[1]!);

  it("names only served tools wherever a sentence calls one", () => {
    const strays = sources(SRC).flatMap((file) => called(readFileSync(file, "utf8")).filter((name) => !SERVED.has(name)).map((name) => `${file.slice(SRC.length + 1)}: ${name}`));

    expect(strays).toEqual([]);
  });

  it("names the tool a forwarder from before the split serves, for every twin", () => {
    const answer = { hint: approvalLandedSentence({}, "apr_1"), value: { next: TOOL_TWINS.map((twin) => `${twin.name} {action: "${twin.actions[0]}"}`) } };
    const old = JSON.stringify(namedForForwarder(answer, "11.3.0"));

    expect(called(old).filter((name) => !BEFORE_SPLIT.has(name))).toEqual([]);
    expect(old).toContain('extension_approvals {action: \\"status\\"');
    expect(namedForForwarder(answer, "11.4.0")).toBe(answer);
  });

  it("1272: names one item per call, never confirm, to a forwarder whose schema has no confirm", () => {
    const refused = JSON.parse(bulkDeleteRefusal("extension_workspace", { action: "set-environment", remove: [{ name: "A" }, { name: "B" }] })!);
    const old = namedForForwarder(refused, "11.3.0");

    expect(old.status).toBe("confirm-required");
    expect(JSON.stringify(old)).not.toContain("confirm: true");
    expect(old.hint).toContain("one item per call");
    expect(old.error.message).toBe("Nothing was deleted: set-environment deletes 2 build variables in one call. This server's version of the tool deletes one item per call.");
    expect(namedForForwarder(old, "11.3.0")).toEqual(old);
    expect(namedForForwarder(refused, "11.4.0").hint).toContain("Call again with confirm: true");
  });
});

describe("1296: the default server names no extras tool in a description or a hint", () => {
  const EXTRAS = Object.keys(TOOL_POLICY).filter((name) => TOOL_POLICY[name]!.group === "extras");
  const listed = (name: string): boolean => isToolListed(name, DEFAULT_SERVER_OPTIONS);
  const extrasNamed = (text: string): string[] => [...new Set(text.match(/\bextension_[a-z_]+\b/g) ?? [])].filter((name) => EXTRAS.includes(name));
  const SRC = join(__dirname, "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? (entry.name === "__tests__" ? [] : sources(join(dir, entry.name))) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
    );

  it("lists descriptions and parameter descriptions that name only listed tools, and leaves them whole with extras on", () => {
    const strays = listedTools(ALL_TOOLS, DEFAULT_SERVER_OPTIONS).flatMap((tool) => extrasNamed(JSON.stringify({ d: tool.description, p: tool.inputSchema })).map((name) => `${tool.name}: ${name}`));
    const all = { features: ["local", "platform", "extras"] as Array<"local" | "platform" | "extras">, noShip: false };

    expect(EXTRAS.every((name) => !listed(name))).toBe(true);
    expect(strays).toEqual([]);
    expect(listedTools(ALL_TOOLS, all).map((tool) => tool.description)).toEqual(ALL_TOOLS.filter((tool) => isToolListed(tool.schema.name, all)).map((tool) => tool.schema.description));
    expect(listedTools(ALL_TOOLS, DEFAULT_SERVER_OPTIONS).find((tool) => tool.name === "extension_dev")?.description).toContain("extension_open shows a surface and extension_stop ends the session.");
  });

  it("answers every refusal hint and every source sentence naming an extras tool in words that name none", async () => {
    const dispatch = createToolDispatcher({
      tools: [{ schema: { name: "extension_open", description: "stand-in", inputSchema: { type: "object", properties: { hint: { type: "string" } } } }, handler: async (args: Record<string, unknown>) => envelope({ ok: false, command: "extension_open", status: "failed", error: { code: "E_INTERNAL", message: "x" }, hint: String(args.hint) }) }],
      options: DEFAULT_SERVER_OPTIONS,
    });

    for (const [code, hint] of Object.entries(REFUSAL_HINTS)) {
      const frame = await dispatch({ name: "extension_open", arguments: { hint: hint.replaceAll("{command}", "extension_open") } });

      expect(extrasNamed(frame.content[0]?.text ?? ""), code).toEqual([]);
    }

    const said = sources(SRC).flatMap((file) => readFileSync(file, "utf8").split("\n").filter((line) => /["`'][^"`']*\bextension_[a-z_]+\b[^"`']* [^"`']*["`']/.test(line) && extrasNamed(line).length));

    expect(said.length).toBeGreaterThan(50);
    expect(said.flatMap((line) => extrasNamed(withoutUnlistedTools(line, "extension_open", listed)))).toEqual([]);
  });
});
