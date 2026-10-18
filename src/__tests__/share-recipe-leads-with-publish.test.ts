// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  fs.readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

describe("the shipped Claude commands send a share ask to extension.dev first", () => {
  it("the extension command has a share action that publishes before it offers a quick link", () => {
    const doc = read("claude/commands/extension.md");
    const start = doc.indexOf('### "share"');
    const action = doc.slice(start, doc.indexOf("\n### ", start + 1));

    expect(start).toBeGreaterThan(-1);
    expect(action).toMatch(/"publish", "deploy" or "send to testers"/);

    const order = ["extension_auth", "extension_project_create", "extension_publish", "extension_preview_web", "extension_submit"].map(
      (name) => action.indexOf(`\`${name}\``),
    );

    expect(order.every((at) => at > -1), order.join(",")).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(action).toContain("`extension_shares`");
    expect(action).not.toMatch(/GitHub Release|email|Load unpacked/i);
  });

  it("the store command offers extension.dev when its tools are missing and keeps zips as checklist attachments", () => {
    const doc = read("claude/commands/extension-publish.md");

    expect(doc).toMatch(/--features=local,platform`, and offer to show how/);
    expect(doc).toMatch(/only the attachments of that store checklist/);
    expect(doc).not.toMatch(/hand the user the zips/);
  });

  it("the rules call the zip a store upload and never hand the person a shell command to run", () => {
    const rules = read("claude/CLAUDE.md");
    const command = read("claude/commands/extension.md");

    expect(rules).toContain("# Zip for store upload (to share a build, use extension_publish)");
    expect(rules).not.toContain("# Zip for distribution");
    expect(rules).toMatch(/never hand one to the person as their next step/);
    expect(command).toMatch(/`npm run dev` \(or `npx extension dev`\) yourself/);
    expect(rules).not.toMatch(/`npm run dev` without it/);
  });

  it.each(["claude/commands/extension.md", "claude/commands/extension-publish.md", "claude/CLAUDE.md"])(
    "%s names the build link and the channel link and never calls a link a public page",
    (rel) => {
      const doc = read(rel);

      expect(doc).toContain("build link");
      expect(doc).toContain("channel link");
      expect(doc).not.toMatch(/public (build[- ])?page/i);
    },
  );

  it("the share action says a private project's build link expires and where visibility is set", () => {
    const doc = read("claude/commands/extension.md");

    expect(doc).toMatch(/On a public project, or a public channel, send/);
    expect(doc).toContain("extension.dev project settings");
    expect(doc).not.toMatch(/visibility[^.]*repositor/i);
  });
});
