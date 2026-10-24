import { describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const SETTINGS = `${PROJECT_ROUTE}/settings/build`;

const NPM = (browser: string, enabled: boolean) => ({
  enabled,
  installCommand: "npm install",
  buildCommand: `npm run build -- --browser ${browser}`,
  outputDirectory: `dist/${browser}`,
});
const EMPTY_SAFARI = { enabled: false, installCommand: "", buildCommand: "", outputDirectory: "" };
const CURRENT = { chrome: NPM("chrome", true), edge: NPM("edge", false), firefox: NPM("firefox", true), safari: EMPTY_SAFARI };
const NOTE =
  "Beyond these fields, a Safari platform build runs on a macOS runner with Xcode and signs the app with the signing assets from the Signing group of the Safari store settings.";

describe("extension_builds configure answers what the platform stored when it fills a browser's empty settings", () => {
  const platform = useProjectRoutes("extdev-builds-defaults-");

  it("answers the stored settings, marks each field the platform filled as defaulted and passes the Safari sentence through", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const stored = { ...CURRENT, safari: NPM("safari", true) };
    platform.routes[`GET ${SETTINGS}`] = () => ({ body: { buildSettings: CURRENT } });
    platform.routes[`PUT ${SETTINGS}`] = () => ({
      body: {
        ok: true,
        buildSettings: stored,
        changes: [
          "safari: enable",
          'safari.installCommand: "" -> "npm install" (defaulted)',
          'safari.buildCommand: "" -> "npm run build -- --browser safari" (defaulted)',
          'safari.outputDirectory: "" -> "dist/safari" (defaulted)',
        ],
        defaulted: ["safari.installCommand", "safari.buildCommand", "safari.outputDirectory"],
        notes: { safari: NOTE },
      },
    });

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { safari: { enabled: true } }, api: API }));
    const [put] = platform.sent("PUT", SETTINGS);

    expect(put.body.buildSettings.safari).toEqual({ ...EMPTY_SAFARI, enabled: true });
    expect(out.status).toBe("build-configured");
    expect(out.value.buildSettings).toEqual(stored);
    expect(out.value.changes).toContain('safari.buildCommand: "" -> "npm run build -- --browser safari" (defaulted)');
    expect(out.value.defaulted).toEqual(["safari.installCommand", "safari.buildCommand", "safari.outputDirectory"]);
    expect(out.value.notes).toEqual({ safari: NOTE });
    expect(out.value.trackUrl).toContain("/acme/widget/");
    expect(out.hint).toContain("The platform filled safari.installCommand, safari.buildCommand, safari.outputDirectory from the project's own pattern");
    expect(out.hint).toContain(NOTE);
  });

  it("keeps the merged settings and names no defaults when an older platform answers only ok", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${SETTINGS}`] = () => ({ body: { buildSettings: CURRENT } });
    platform.routes[`PUT ${SETTINGS}`] = () => ({ body: { ok: true } });

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { edge: { enabled: true } }, api: API }));

    expect(out.value.buildSettings.edge).toEqual(NPM("edge", true));
    expect(out.value.changes).toBeUndefined();
    expect(out.value.defaulted).toBeUndefined();
    expect(out.value.notes).toBeUndefined();
    expect(out.hint).not.toContain("defaulted");
  });
});
