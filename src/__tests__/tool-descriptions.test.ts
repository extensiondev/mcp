import { describe, expect, it } from "vitest";

import { serverInstructions, tools as ALL_TOOLS } from "../index";

const IMPERATIVE_VERBS = [
  "Analyze",
  "Browse",
  "Build",
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
  "Reload",
  "Run",
  "Sign",
  "Stop",
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
  "MB",
  "MV2",
  "MV3",
  "PR",
  "RDP",
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
    "%s shouts at most once, only on the word that separates it from the neighbour it is confused with",
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
    const description = ALL_TOOLS.find((t) => t.schema.name === "extension_submit")?.schema.description ?? "";
    const submissionSentences = description
      .replace("its trusted testers live in the Chrome Web Store dashboard", "")
      .split(/(?<=\.)\s+/)
      .filter((sentence) => /chrome|submissions default/i.test(sentence));

    expect(submissionSentences.filter((sentence) => /testers/i.test(sentence))).toEqual([]);
    expect(description).toContain("Submissions default to the least public outcome each store's API offers, unless the project's store settings say otherwise.");
    expect(description).toMatch(/Chrome and Edge upload a draft that is not published and does not enter review/);
    expect(description).toMatch(/recorded as "Uploaded, not public", never as live/);
  });
});

describe("the link tools speak of a build link and a channel link, so an agent can name what it sends", () => {
  const description = (name: string) => ALL_TOOLS.find((t) => t.schema.name === name)?.schema.description ?? "";
  const instructions = serverInstructions({ features: ["local", "platform"], noShip: false });

  it.each([
    ["extension_publish", description("extension_publish")],
    ["extension_release_promote", description("extension_release_promote")],
    ["extension_release_status", description("extension_release_status")],
    ["extension_shares", description("extension_shares")],
    ["the server instructions", instructions],
  ])("%s names both nouns", (_where, text) => {
    expect(text).toContain("build link");
    expect(text).toContain("channel link");
  });

  it.each([
    ["extension_publish", description("extension_publish")],
    ["extension_release_promote", description("extension_release_promote")],
    ["extension_release_status", description("extension_release_status")],
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
