import { describe, expect, it, vi } from "vitest";

import * as browsers from "../tools/browsers";
import * as auth from "../tools/auth";
import * as templates from "../tools/templates";
import * as releaseStatus from "../tools/release-status";
import { tools as ALL_TOOLS } from "../index";

const MERGED_AWAY = [
  "extension_detect_browsers",
  "extension_list_browsers",
  "extension_install_browser",
  "extension_uninstall_browser",
  "extension_login",
  "extension_logout",
  "extension_whoami",
  "extension_list_templates",
  "extension_get_template_source",
  "extension_release_list",
  "extension_store_status",
  "extension_preview",
];

describe("v9 tool surface", () => {
  it("registers the merged tools and no longer registers what they replaced", () => {
    const names = ALL_TOOLS.map((t) => t.schema.name);
    for (const name of [
      "extension_browsers",
      "extension_auth",
      "extension_templates",
      "extension_release_status",
      "extension_start",
    ]) {
      expect(names).toContain(name);
    }
    for (const gone of MERGED_AWAY) {
      expect(names).not.toContain(gone);
    }
  });

  it("keeps every action enum reachable from the tool that owns it", () => {
    const actions = (name: string) => {
      const tool = ALL_TOOLS.find((t) => t.schema.name === name)!;
      const props = tool.schema.inputSchema.properties as Record<
        string,
        { enum?: string[] }
      >;
      return props.action?.enum ?? [];
    };
    expect(actions("extension_browsers")).toEqual([
      "detect",
      "list",
      "install",
      "uninstall",
    ]);
    expect(actions("extension_auth")).toEqual(["status", "login", "logout"]);
    expect(actions("extension_templates")).toEqual(["list", "source"]);
  });
});

describe("extension_browsers dispatch", () => {
  it("refuses install without a browser and names the valid ones", async () => {
    const out = JSON.parse(await browsers.handler({ action: "install" }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain("chrome");
    expect(out.error.message).toContain("firefox");
  });

  it("refuses uninstall with neither a browser nor all", async () => {
    const out = JSON.parse(await browsers.handler({ action: "uninstall" }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
  });

  it("defaults to the detect scan", async () => {
    const out = JSON.parse(await browsers.handler({ browsers: ["chrome"] }));
    expect(Array.isArray(out.value.detected)).toBe(true);
    expect(out.value.detected).toHaveLength(1);
    expect(out.value.detected[0].browser).toBe("chrome");
  });
});

describe("extension_auth dispatch", () => {
  it("reports logged-out status by default with no credentials", async () => {
    const out = JSON.parse(await auth.handler({}));
    expect(["logged-out", "logged-in", "expired"]).toContain(out.status);
  });

  it("rejects a login without a workspace/project pair", async () => {
    const out = JSON.parse(
      await auth.handler({ action: "login", project: "nope" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("BadRequest");
  });
});

describe("extension_templates dispatch", () => {
  it("refuses source without a slug and points at the list action", async () => {
    const out = JSON.parse(await templates.handler({ action: "source" }));
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("extension_templates");
  });
});

describe("extension_release_status sections", () => {
  it("nests only the requested section", async () => {
    const prevFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => "{}",
    })) as unknown as typeof fetch;
    try {
      const out = JSON.parse(
        await releaseStatus.handler({
          include: ["stores"],
          workspace: "acme",
          project: "widget",
        }),
      );
      expect(out.value.stores).toBeDefined();
      expect(out.value.releases).toBeUndefined();
    } finally {
      global.fetch = prevFetch;
    }
  });
});
