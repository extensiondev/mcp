// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { envelope } from "../lib/envelope";
import { scrubRunAnswer } from "../lib/run-privacy";
import { WORLD_API, WORLD_PROJECT_ID, usePlatformWorld, type World } from "./fixtures/platform-world";

const PREFLIGHT = new RegExp(`^POST /api/projects/${WORLD_PROJECT_ID}/stores/chrome/submissions/preflight$`);
const SUBMIT = /^POST \/api\/cli\/stores\/submit$/;
const HEALTH = /^GET \/api\/local-registry\/acme\/widget\/_extension-dev\/stores\/health\.json$/;
const ITEM_ID = "abcdefghijklmnopabcdefghijklmnop";
const ITEM_URL = `https://chrome.google.com/webstore/devconsole/pub-1/${ITEM_ID}/edit`;
const PROD_HEALTH = "https://registry.extension.land/cezaraugusto/pii-shield/_extension-dev/stores/health.json";
const INFRA = /registry\.extension\.land|\/api\/(?:local-)?registry\/|_extension-dev(?:-system)?\/|\.github\/workflows\/|\.yml\b/;
const DRY_RUN = { action: "submit", browsers: ["chrome"], buildSha: "b4187328", channel: "preview", dryRun: true, api: WORLD_API };

function linkedChrome(world: World): void {
  world.routes.push([
    PREFLIGHT,
    () => ({
      body: {
        store: "chrome",
        summary: { pass: 9, warn: 0, fail: 0, canSubmit: true },
        checks: [],
        connection: { kind: "oauth", connectedAs: "cezar@example.com", healthy: true, itemId: ITEM_ID, itemLinked: true, publisherId: "pub-1" },
      },
    }),
  ]);
}

function platformDryRun(world: World, extra: Record<string, unknown> = {}): void {
  world.routes.push([
    SUBMIT,
    () => ({
      body: {
        ok: true,
        dryRun: true,
        buildId: "b4187328",
        channel: "preview",
        workflow: ".github/workflows/store.yml",
        message: `Preflight OK. ${PROD_HEALTH} returned 404; the store workflow .github/workflows/store.yml is present.`,
        ...extra,
      },
    }),
  ]);
}

function missingHealth(world: World): void {
  world.routes.push([HEALTH, () => ({ status: 404, body: { message: "not found" } })]);
}

describe("a dry-run submit reads the store connection the preflight reads", () => {
  const world = usePlatformWorld("extdev-dry-run-connection-");

  it("answers ready for a connected, healthy, linked Chrome store right after a green preflight", async () => {
    if (process.platform === "win32") return;

    world.login();
    linkedChrome(world);
    platformDryRun(world);
    missingHealth(world);

    const preflight = await world.call("extension_submit", { action: "preflight", browsers: ["chrome"], api: WORLD_API });
    const out = await world.call("extension_submit", DRY_RUN);
    const said = JSON.stringify(out);

    expect(preflight.status).toBe("preflight-read");
    expect(preflight.value.nextStep.kind).toBe("submit");
    expect(out.ok, said).toBe(true);
    expect(out.value.verdict).toBe("ready");
    expect(out.value.preflight[0]).toMatchObject({ browser: "chrome", ok: true, configured: true, healthy: true, itemLinked: true, source: "connection", itemUrl: ITEM_URL });
    expect(out.value.nextStep.kind).toBe("submit");
    expect(out.value.nextStep.say).toBe(preflight.value.nextStep.say);
    expect(out.value.trackUrl).toMatch(/^http:\/\/console\.extension\.localhost\/acme\/widget\//);
    expect(out.value.itemUrl).toBe(ITEM_URL);
    expect(out.hint).toMatch(/^Ready: /);
    expect(said).not.toMatch(/unknown/i);
    expect(said).not.toContain("submissions/new");
    expect(said).not.toContain("advisory only");
    expect(said).not.toMatch(INFRA);
    expect(world.calls.some((call) => HEALTH.test(`${call.method} ${call.path}`))).toBe(false);
  });

  it("says not checked, never unknown, when there is no connection record and the health file is missing", async () => {
    if (process.platform === "win32") return;

    world.login();
    platformDryRun(world);
    missingHealth(world);

    const out = await world.call("extension_submit", DRY_RUN);
    const said = JSON.stringify(out);

    expect(out.value.verdict).toBe("not-checked");
    expect(out.value.preflight[0]).toMatchObject({ browser: "chrome", configured: "not checked", healthy: "not checked", source: "none" });
    expect(out.value.preflight[0].reason).toContain("not checked");
    expect(out.value.nextStep.kind).toBe("submit");
    expect(out.value.trackUrl).toMatch(/^http:\/\/console\.extension\.localhost\//);
    expect(out.hint).toContain("not checked here");
    expect(said).not.toMatch(/unknown/i);
    expect(said).not.toMatch(INFRA);
  });

  it("scrubs a registry link and a workflow path from a platform answer before it reaches the person", async () => {
    if (process.platform === "win32") return;

    world.login();
    linkedChrome(world);
    platformDryRun(world, { registryUrl: PROD_HEALTH, build: { indexUrl: `${WORLD_API}/api/registry/acme/widget/_extension-dev/builds/b4187328/index.json` } });

    const out = await world.call("extension_submit", DRY_RUN);

    expect(JSON.stringify(out)).not.toMatch(INFRA);
    expect(out.value.workflow).toBeUndefined();
    expect(out.value.registryUrl).toBe("http://console.extension.localhost/cezaraugusto/pii-shield/submissions");
    expect(out.value.build.indexUrl).toBe("http://console.extension.localhost/acme/widget/builds/b4187328");
    expect(out.value.platformMessage).toContain("http://console.extension.localhost/cezaraugusto/pii-shield/submissions returned 404");
  });
});

describe("the shared answer guard strips registry and workflow internals", () => {
  it("replaces a registry object link with its console page and drops a bare workflow path", () => {
    const answer = envelope({
      ok: false,
      command: "extension_release_status",
      status: "read",
      value: {
        statusUrl: "https://registry.extension.land/acme/widget/_extension-dev-system/stores/status.json",
        channelsUrl: "https://registry.extension.land/acme/widget/_extension-dev/channels.json",
        workflowFile: "store.yml",
        note: "Read from registry.extension.land by .github/workflows/release.yml.",
      },
      hint: `The record ${PROD_HEALTH} is missing; the store.yml run has not reported.`,
    });

    const out = JSON.parse(scrubRunAnswer(answer));

    expect(JSON.stringify(out)).not.toMatch(INFRA);
    expect(out.value.statusUrl).toBe("https://console.extension.dev/acme/widget/submissions");
    expect(out.value.channelsUrl).toBe("https://console.extension.dev/acme/widget/releases");
    expect(out.value.workflowFile).toBeUndefined();
    expect(out.hint).toBe("The record https://console.extension.dev/cezaraugusto/pii-shield/submissions is missing; the store run has not reported.");
  });

  it("keeps a build download link a run command needs", () => {
    const command = "npx -y extension@latest preview https://registry.extension.land/acme/widget/builds/b4187328/chrome.zip?t=share.tok --browser=chrome";
    const answer = envelope({
      ok: true,
      command: "extension_publish",
      status: "platform-held",
      value: { previewCommands: { chrome: command }, downloadUrl: "https://registry.extension.land/acme/widget/builds/b4187328/firefox.xpi" },
      hint: `Run ${command}. The index is at https://registry.extension.land/acme/widget/_extension-dev/builds/index.json.`,
    });

    const out = JSON.parse(scrubRunAnswer(answer));

    expect(out.value.previewCommands.chrome).toBe(command);
    expect(out.value.downloadUrl).toBe("https://registry.extension.land/acme/widget/builds/b4187328/firefox.xpi");
    expect(out.hint).toBe(`Run ${command}. The index is at https://console.extension.dev/acme/widget/builds.`);
  });

  it("keeps a build's metadata and integrity file links and sends its run record to the build page", () => {
    const build = "https://registry.extension.land/acme/widget/builds/b4187328";
    const answer = envelope({
      ok: true,
      command: "extension_builds",
      status: "read",
      value: {
        build: { buildId: "b4187328", runUrl: `${build}/deployment.json` },
        browsers: [{ name: "chrome", integrityUrl: `${build}/artifact-integrity/chrome.json` }],
        artifacts: [
          { name: "chrome.json", downloadUrl: `${build}/chrome.json` },
          { name: "chrome.integrity.json", downloadUrl: `${build}/artifact-integrity/chrome.json` },
          { name: "chrome.manifest.json", downloadUrl: `${build}/artifact-manifest/chrome.json` },
        ],
      },
      hint: `The log is at ${build}/build-logs.json.`,
    });

    const out = JSON.parse(scrubRunAnswer(answer));

    expect(out.value.artifacts.map((row: { downloadUrl: string }) => row.downloadUrl)).toEqual([
      `${build}/chrome.json`,
      `${build}/artifact-integrity/chrome.json`,
      `${build}/artifact-manifest/chrome.json`,
    ]);

    expect(out.value.browsers[0].integrityUrl).toBe(`${build}/artifact-integrity/chrome.json`);
    expect(out.value.build.runUrl).toBe("https://console.extension.dev/acme/widget/builds/b4187328");
    expect(out.hint).toBe("The log is at https://console.extension.dev/acme/widget/builds/b4187328.");
  });
});
