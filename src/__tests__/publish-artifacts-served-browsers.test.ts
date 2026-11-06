import { describe, expect, it } from "vitest";

import { browserHealthOf, servedOnlyReason, summarizeBuildHealth, withServedBrowsers } from "../lib/build-health";
import { applyArtifactHealth } from "../lib/publish-artifacts";

const passed = { ok: true as const, json: { ok: true, checkedAt: "2026-11-06T00:00:00Z" } };

function threeChecked() {
  return summarizeBuildHealth(
    "f25f2b53548b6510836de8fa675094f92e33f5fb",
    ["chrome", "edge", "firefox"].map((browser) => browserHealthOf(browser, "success", passed)),
    { status: "success", runId: "1", startedAt: null, completedAt: null },
    27,
  );
}

const COMMANDS = {
  chrome: "npx -y extension@latest preview https://a.extension.dev/leon/builds/f25f2b5/chrome.zip",
  edge: "npx -y extension@latest preview https://a.extension.dev/leon/builds/f25f2b5/edge.zip",
  firefox: "npx -y extension@latest preview https://a.extension.dev/leon/builds/f25f2b5/firefox.zip",
  safari: "npx -y extension@latest preview https://a.extension.dev/leon/builds/f25f2b5/safari.zip",
};

describe("431: every browser a publish serves appears once in the artifacts verdict", () => {
  it("lists a served browser the record and the artifact list never named as unchecked, with its reason", () => {
    const data: Record<string, unknown> = { previewCommands: { ...COMMANDS }, tellThem: "Here it is." };

    const { note, failed } = applyArtifactHealth(data, threeChecked());
    const artifacts = data.artifacts as { good: string[]; failed: string[]; unchecked: string[]; browsers: Record<string, Record<string, unknown>> };

    expect(artifacts.good).toEqual(["chrome", "edge", "firefox"]);
    expect(artifacts.failed).toEqual([]);
    expect(artifacts.unchecked).toEqual(["safari"]);
    expect(artifacts.browsers.safari).toMatchObject({ integrity: "unread", recorded: false, servedOnly: true, reason: servedOnlyReason("safari") });
    expect(Object.keys(artifacts.browsers).sort()).toEqual(Object.keys(COMMANDS).sort());
    expect(failed.size).toBe(0);
    expect(note).toBe(
      "Integrity was not checked for Safari: the platform's record of this build has no safari row and its artifact list no safari package, so safari was never checked, and the safari run command in value.previewCommands hands over an unchecked file.",
    );

    expect((data.previewCommands as Record<string, string>).safari).toBe(COMMANDS.safari);
  });

  it("changes nothing when the verdict already covers every served browser", () => {
    const data: Record<string, unknown> = { previewCommands: { chrome: COMMANDS.chrome, edge: COMMANDS.edge, firefox: COMMANDS.firefox }, tellThem: "Here it is." };

    const { note } = applyArtifactHealth(data, threeChecked());

    expect(note).toBeNull();
    expect((data.artifacts as { unchecked: string[] }).unchecked).toEqual([]);
  });

  it("keeps a served browser out of the good list even when another browser failed", () => {
    const health = summarizeBuildHealth(
      "f25f2b53548b6510836de8fa675094f92e33f5fb",
      [browserHealthOf("chrome", "success", passed), browserHealthOf("edge", "failed", { ok: false, status: 404, body: null })],
      undefined,
      null,
    );
    const data: Record<string, unknown> = { previewCommands: { ...COMMANDS }, tellThem: "Here it is." };

    applyArtifactHealth(data, health);

    const artifacts = data.artifacts as { good: string[]; failed: string[]; unchecked: string[] };
    expect(artifacts.failed).toEqual(["edge"]);
    expect(artifacts.unchecked.sort()).toEqual(["firefox", "safari"]);
    expect(String(data.tellThem)).toContain("Use it for Chrome, Firefox and Safari only");
  });

  it("withServedBrowsers adds no row for a browser already read, for the source archive, or twice", () => {
    const health = withServedBrowsers(threeChecked(), ["Chrome", "safari", "safari", ""]);

    expect(health.checked && health.browsers.map((b) => b.browser)).toEqual(["chrome", "edge", "firefox", "safari"]);
  });
});
