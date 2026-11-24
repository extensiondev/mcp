import { describe, expect, it } from "vitest";

import { serverInstructions, tools as ALL_TOOLS } from "../index";
import { DEFAULT_SERVER_OPTIONS, isToolListed } from "../lib/tool-policy";

const IMPERATIVE_VERBS = [
  "Analyze",
  "Browse",
  "Build",
  "Check",
  "Click",
  "Create",
  "Diagnose",
  "Evaluate",
  "Find",
  "Inspect",
  "List",
  "Open",
  "Plan",
  "Preview",
  "Promote",
  "Publish",
  "Read",
  "Rebuild",
  "Release",
  "Reload",
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
    expect(text("extension_build")).toContain("Not for sharing (extension_builds)");
    expect(text("extension_manifest_validate")).toMatch(/per-browser errors, permissions the code calls but lacks, and buildBlocking errors/);
    expect(text("extension_templates")).toContain("'javascript' (plain)");
  });
});

const ADJACENT_SETS = [
  ["extension_inspect", "extension_dom_snapshot", "extension_element", "extension_eval", "extension_logs"],
  ["extension_dev", "extension_start", "extension_open", "extension_reload", "extension_wait", "extension_stop"],
  ["extension_build", "extension_builds", "extension_builds_act", "extension_analyze"],
  ["extension_submit", "extension_submit_check", "extension_release_promote", "extension_release_status"],
  ["extension_publish", "extension_shares", "extension_preview_web"],
  ["extension_create", "extension_project_create", "extension_add_feature", "extension_templates"],
  ["extension_auth", "extension_approvals", "extension_workspace"],
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
    ...ALL_TOOLS.map((tool) => [tool.schema.name, tool.schema.description] as const),
    ["the local instructions", serverInstructions({ features: ["local"], noShip: false })] as const,
    ["the platform instructions", serverInstructions({ features: ["local", "platform", "extras"], noShip: false })] as const,
  ])("%s carries no steering phrase", (_where, text) => {
    expect(STEERING.filter((phrase) => phrase.test(text)).map(String)).toEqual([]);
  });

  it("keeps extension_publish describing, as a fact, that it shares and publishes through extension.dev", () => {
    expect(description("extension_publish")).toMatch(/^Publish and share a build through extension\.dev/);
  });
});
