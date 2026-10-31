// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeCredentials } from "../lib/credentials";
import {
  UPDATE_URL_UNKNOWN_CHANNEL,
  channelAwareBuildWarnings,
  isUpdateUrlLintLine,
  readAmoChannel,
  storeMdFirefoxChannel,
  updateUrlLineFor,
} from "../lib/amo-update-url";
import { browserFromCliArgs, buildFrame, buildNarration, buildSummary, writeEngineDist } from "./fixtures/engine-answers";

import type * as ExecModule from "../lib/exec";

const AMO_LINE = 'AMO error MANIFEST_UPDATE_URL: "update_url" is not allowed. (manifest.json)';
const INNER_HTML = "AMO warning UNSAFE_VAR_ASSIGNMENT: Unsafe assignment to innerHTML (chunks/react-dom.js)";
const PROD = "https://www.extension.dev";
const PROJECT_ID = "prj_hands_free";

let engineWarnings: string[] = [];

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      const browser = browserFromCliArgs(args);
      if (args[0] === "build") writeEngineDist(args[1]!, browser);

      const frame = buildFrame(args[1]!, [browser]);
      const value = frame.value as { summaries: Array<Record<string, unknown>> };
      value.summaries = [buildSummary(browser, { ...value.summaries[0], warnings: engineWarnings, warnings_count: engineWarnings.length })];

      return { code: 0, stdout: `${JSON.stringify(frame)}\n`, stderr: buildNarration(browser) };
    },
  };
});

const build = await import("../tools/build");

const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_APPROVAL_GATE", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_REGISTRY_URL"];

function storeMd(firefoxLines: string[], extra = ""): string {
  return ["# Hands-free", "", "## Listing", "", "- Name: Hands-free", "", "## Chrome Web Store", "", "- Visibility: unlisted", "", "## Firefox Add-ons", "", ...firefoxLines, "", extra].join("\n");
}

describe("the Firefox channel is read from STORE.md's own section", () => {
  it("reads `- Channel: unlisted` and `- Channel: listed` under ## Firefox Add-ons, a trailing note allowed", () => {
    expect(storeMdFirefoxChannel(storeMd(["- Channel: unlisted"]))).toBe("unlisted");
    expect(storeMdFirefoxChannel(storeMd(["- Channel: Listed (since 2026-10)"]))).toBe("listed");
    expect(storeMdFirefoxChannel(storeMd(["### Distribution", "", "- Release channel: unlisted"]))).toBe("unlisted");
  });

  it("answers null when the section has no channel line, names another word, or the line sits under another store", () => {
    expect(storeMdFirefoxChannel(storeMd(["- Category: Other"]))).toBeNull();
    expect(storeMdFirefoxChannel(storeMd(["- Channel: stable"]))).toBeNull();
    expect(storeMdFirefoxChannel(storeMd([], "## Edge Add-ons\n\n- Channel: unlisted\n"))).toBeNull();
    expect(storeMdFirefoxChannel("# No stores\n\n- Channel: unlisted\n")).toBeNull();
  });
});

describe("the MANIFEST_UPDATE_URL line is said with the channel", () => {
  it("recognizes the engine's AMO error line, colored or not, and nothing else", () => {
    expect(isUpdateUrlLintLine(AMO_LINE)).toBe(true);
    expect(isUpdateUrlLintLine(`\u001b[33mAMO error \u001b[0mMANIFEST_UPDATE_URL: "update_url" is not allowed.`)).toBe(true);
    expect(isUpdateUrlLintLine(INNER_HTML)).toBe(false);
  });

  it("demotes the line to a note for an unlisted add-on, with no word that reads as a refusal", () => {
    const line = updateUrlLineFor({ channel: "unlisted", source: "store-md" });

    expect(line).toMatch(/^update_url is fine for an unlisted \(self-distributed\) add-on; remove it before a listed submission\./);
    expect(line).toContain("STORE.md `## Firefox Add-ons` says `- Channel: unlisted`");
    expect(line).not.toMatch(/\berror\b/);
    expect(line).not.toMatch(/\brefuse/);
  });

  it("keeps it as the one line to remove for a listed add-on, saying the upload would be refused", () => {
    const line = updateUrlLineFor({ channel: "listed", source: "platform" });

    expect(line).toMatch(/^Remove browser_specific_settings\.gecko\.update_url before the listed submission: AMO refuses update_url on a listed submission/);
    expect(line).toContain("the upload would be refused");
    expect(line).toContain("the project's Firefox store setting on extension.dev says listed");
    expect(line).toContain("update_url is fine only for an unlisted (self-distributed) add-on");
  });

  it("says which channel decides when none is known", () => {
    const line = updateUrlLineFor({ channel: null, source: null });

    expect(line).toBe(UPDATE_URL_UNKNOWN_CHANNEL);
    expect(line).toMatch(/^AMO refuses update_url on a listed submission; it is fine unlisted \(STORE\.md `- Channel:` decides\)\./);
    expect(line).not.toMatch(/\berror\b/);
  });
});

describe("channelAwareBuildWarnings reads STORE.md first, then the platform, else unknown, and never reaches the network without need", () => {
  let tmp: string;
  let project: string;
  const saved: Record<string, string | undefined> = {};
  const fetchSpy = vi.fn();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-amo-channel-"));
    project = path.join(tmp, "project");
    fs.mkdirSync(project);
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];

    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_API_URL = PROD;
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("leaves the warnings alone for a browser that is not Firefox, and when no update_url line is present", async () => {
    fs.writeFileSync(path.join(project, "STORE.md"), storeMd(["- Channel: unlisted"]));

    expect(await channelAwareBuildWarnings([AMO_LINE], "chrome", project)).toEqual([AMO_LINE]);
    expect(await channelAwareBuildWarnings([INNER_HTML], "firefox", project)).toEqual([INNER_HTML]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rewrites only the update_url line from STORE.md's channel and asks the platform nothing", async () => {
    fs.writeFileSync(path.join(project, "STORE.md"), storeMd(["- Channel: unlisted"]));
    writeCredentials({ version: 1, token: "claims.sig", workspaceSlug: "acme", projectSlug: "hands-free", expiresAt: Math.floor(Date.now() / 1000) + 3600, api: PROD });

    const out = await channelAwareBuildWarnings([INNER_HTML, AMO_LINE], "firefox", project);

    expect(out[0]).toBe(INNER_HTML);
    expect(out[1]).toMatch(/^update_url is fine for an unlisted/);
    expect(out[1]).toContain("`- Channel: unlisted`");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers unknown with no STORE.md channel and no login, without a network call", async () => {
    fs.writeFileSync(path.join(project, "STORE.md"), storeMd(["- Category: Other"]));

    expect(await readAmoChannel(project)).toEqual({ channel: null, source: null });
    expect(await channelAwareBuildWarnings([AMO_LINE], "firefox", project)).toEqual([UPDATE_URL_UNKNOWN_CHANNEL]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads the project's Firefox store setting when a login exists and STORE.md says nothing", async () => {
    writeCredentials({ version: 1, token: "claims.sig", workspaceSlug: "acme", projectSlug: "hands-free", expiresAt: Math.floor(Date.now() / 1000) + 3600, api: PROD });
    const routes: Record<string, unknown> = {
      "GET /api/cli/whoami": { login: "acme/hands-free", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "hands-free" },
      [`GET /api/projects/${PROJECT_ID}/stores/config`]: { firefox: { enabled: true, configured: true, credentialsConfigured: true, releaseChannel: "listed" } },
    };
    fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const body = routes[`${String(init?.method ?? "GET").toUpperCase()} ${url.pathname}`];

      return new Response(JSON.stringify(body ?? { message: "not found" }), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
    });

    const paths = () => fetchSpy.mock.calls.map(([input]) => new URL(String(input)).pathname);

    expect(await readAmoChannel(project)).toEqual({ channel: "listed", source: "platform" });
    expect(paths()).toEqual(["/api/cli/whoami", `/api/projects/${PROJECT_ID}/stores/config`]);

    const [line] = await channelAwareBuildWarnings([AMO_LINE], "firefox", project);

    expect(line).toMatch(/^Remove browser_specific_settings\.gecko\.update_url before the listed submission/);
    expect(line).toContain("the project's Firefox store setting on extension.dev says listed");
    expect(new Set(paths())).toEqual(new Set(["/api/cli/whoami", `/api/projects/${PROJECT_ID}/stores/config`]));
  });

  it("the build tool answers the note in place of the AMO error line for an unlisted project", async () => {
    fs.mkdirSync(path.join(project, "src"));
    fs.writeFileSync(path.join(project, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Hands-free", version: "0.1.0" }));
    fs.writeFileSync(path.join(project, "STORE.md"), storeMd(["- Channel: unlisted"]));
    engineWarnings = [INNER_HTML, AMO_LINE];

    const out = JSON.parse(await build.handler({ projectPath: project, browser: "firefox", skipValidation: true }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("built");
    expect(out.warnings).toContain(INNER_HTML);
    expect(out.warnings.some((line: string) => /^update_url is fine for an unlisted \(self-distributed\) add-on/.test(line))).toBe(true);
    expect(out.warnings.some((line: string) => /AMO error/.test(line))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
