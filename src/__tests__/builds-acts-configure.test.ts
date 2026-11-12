import { describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { API, CURRENT, SETTINGS_ROUTE, SUITE, digestOf, login, sha256, world } from "./builds-acts-harness";

describe(SUITE, () => {
  it("configure applies a merged change with an owner's token and no approval id, minting nothing and reading no approval", async () => {
    if (process.platform === "win32") return;

    login();
    const merged = { chrome: CURRENT.chrome, edge: CURRENT.edge, firefox: { ...CURRENT.firefox, enabled: true } };
    world.routes[`PUT ${SETTINGS_ROUTE}`] = () => ({ body: { ok: true } });

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { firefox: { enabled: true } }, api: API }));
    const puts = world.calls.filter((call) => call.method === "PUT");

    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ buildSettings: merged });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("build-configured");
    expect(out.value.buildSettings).toEqual(merged);
    expect(out.value.trackUrl).toContain("/acme/widget/");
    expect(out.hint).toContain("no approval page was involved");
    expect(world.calls.some((call) => call.url.includes("/api/cli/approvals"))).toBe(false);
  });

  it("539: configure names rebuild as the next build and never says a push is needed, since an uploaded project has nothing to push", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`PUT ${SETTINGS_ROUTE}`] = () => ({ body: { ok: true } });

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { firefox: { enabled: true } }, api: API }));

    expect(out.status).toBe("build-configured");
    expect(out.hint).toContain('extension_builds action:"rebuild" (no push needed');
    expect(out.hint).not.toContain("a push, or");
  });

  it("configure is refused OWNER_REQUIRED when the token's minter is not an owner, before any approval is asked", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`PUT ${SETTINGS_ROUTE}`] = () => ({
      status: 403,
      body: { code: "OWNER_REQUIRED", message: "Changing build settings with a token is a workspace owner action, and this token was minted by an account that is not an owner of this workspace." },
    });

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { firefox: { enabled: true } }, api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.platformCode).toBe("OWNER_REQUIRED");
    expect(world.calls.some((call) => call.url.includes("/api/cli/approvals"))).toBe(false);
  });

  it("configure merges a partial change into the current settings and, when the platform asks, requests the approval of the server's diff", async () => {
    if (process.platform === "win32") return;

    login();
    const merged = { chrome: CURRENT.chrome, edge: CURRENT.edge, firefox: { ...CURRENT.firefox, buildCommand: "pnpm build --browser firefox" } };
    const digest = digestOf(merged);
    const approvalRequest = {
      action: "extension_settings.build",
      scope: { settingsDigest: digest },
      fingerprint: sha256(`extension_settings.build\nsettingsDigest=${digest}`),
    };
    world.routes[`PUT ${SETTINGS_ROUTE}`] = () => ({
      body: { code: "APPROVAL_REQUIRED", message: "needs approval", approvalRequest },
      status: 403,
    });

    world.routes["POST /api/cli/approvals"] = () => ({
      status: 201,
      body: {
        approvalId: "apr_1",
        approvalUrl: "http://localhost:3100/approve/apr_1",
        expiresAt: "2026-10-11T20:00:00.000Z",
        description: 'Change the build settings of widget: firefox.buildCommand: "npm run build -- --browser firefox" -> "pnpm build --browser firefox"',
        changes: ['firefox.buildCommand: "npm run build -- --browser firefox" -> "pnpm build --browser firefox"'],
      },
    });

    const out = JSON.parse(
      await builds({ action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build --browser firefox" } }, api: API }),
    );
    const put = world.calls.find((call) => call.method === "PUT");
    const post = world.calls.find((call) => call.method === "POST");

    expect(put?.body).toEqual({ buildSettings: merged });
    expect(post?.body).toMatchObject({ ...approvalRequest, buildSettings: merged });
    expect(typeof post?.body.description).toBe("string");
    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.value).toMatchObject({
      approvalId: "apr_1",
      approvalUrl: "http://localhost:3100/approve/apr_1",
      changes: ['firefox.buildCommand: "npm run build -- --browser firefox" -> "pnpm build --browser firefox"'],
    });

    expect(out.error.message).toContain("approvalId apr_1");
    expect(out.error.message).toContain("the platform asked a workspace owner");
    expect(out.error.message).not.toContain("irreversible");
  });

  it("configure sends safari only when the change names it", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`PUT ${SETTINGS_ROUTE}`] = () => ({ body: { ok: true } });

    await builds({ action: "configure", buildSettings: { safari: { enabled: true } }, api: API });
    const put = world.calls.find((call) => call.method === "PUT");

    expect(Object.keys(put?.body.buildSettings ?? {})).toEqual(["chrome", "edge", "firefox", "safari"]);
    expect(put?.body.buildSettings.safari).toEqual({ ...CURRENT.safari, enabled: true });
  });

  it("configure refuses a browser or field the settings do not have before any write", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { chrome: { buildCmd: "x" } }, api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain("buildCmd");
    expect(world.calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("configure passes on the platform's own validation refusal, before any approval is requested", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`PUT ${SETTINGS_ROUTE}`] = () => ({ body: { message: "chrome.enabled must be a boolean" }, status: 400 });

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { chrome: { enabled: "yes" } }, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("chrome.enabled must be a boolean");
    expect(world.calls.some((call) => call.url.endsWith("/api/cli/approvals"))).toBe(false);
  });

  it("ledger 501: a 5xx on the write reads the settings back, says nothing was saved, and allows one retry after a wait", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`PUT ${SETTINGS_ROUTE}`] = () => ({ status: 500, body: { message: "Internal server error" } });

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build" } }, api: API }));
    const reads = world.calls.filter((call) => call.method === "GET" && call.url.endsWith("/settings/build"));

    expect(reads).toHaveLength(2);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("unavailable");
    expect(out.error.code).toBe("E_PLATFORM");
    expect(out.error.message).toContain("answered 500: Internal server error");
    expect(out.value).toMatchObject({ saved: "no", attempt: 1, retryAfterSeconds: 10 });
    expect(out.value.trackUrl).toContain("/acme/widget/");
    expect(out.hint).toContain("nothing was saved");
    expect(out.hint).toContain("call again with the same arguments, once");
  });

  it("ledger 501: the second 5xx for the same change says to stop, and names the console page and where to report it", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`PUT ${SETTINGS_ROUTE}`] = () => ({ status: 502, body: { message: "Bad gateway" } });

    await builds({ action: "configure", buildSettings: { edge: { enabled: true } }, api: API });
    const out = JSON.parse(await builds({ action: "configure", buildSettings: { edge: { enabled: true } }, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("unavailable");
    expect(out.value).toMatchObject({ saved: "no", attempt: 2 });
    expect(out.value.retryAfterSeconds).toBeUndefined();
    expect(out.hint).toContain("stop retrying");
    expect(out.hint).toContain(out.value.trackUrl);
    expect(out.hint).toContain("https://github.com/extensiondev/mcp/issues");
    expect(out.hint).not.toContain("call again");
  });

  it("ledger 501: a 5xx whose readback shows the change in place answers build-configured and does not ask for a retry", async () => {
    if (process.platform === "win32") return;

    login();
    const merged = { chrome: CURRENT.chrome, edge: CURRENT.edge, firefox: { ...CURRENT.firefox, buildCommand: "pnpm build --browser firefox" } };
    let written = false;

    world.routes[`PUT ${SETTINGS_ROUTE}`] = () => {
      written = true;

      return { status: 500, body: { message: "Internal server error" } };
    };

    world.routes[`GET ${SETTINGS_ROUTE}`] = () => ({ body: { buildSettings: written ? { ...merged, safari: CURRENT.safari } : CURRENT } });

    const out = JSON.parse(
      await builds({ action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build --browser firefox" } }, api: API }),
    );

    expect(out.ok).toBe(true);
    expect(out.status).toBe("build-configured");
    expect(out.value.buildSettings.firefox.buildCommand).toBe("pnpm build --browser firefox");
    expect(out.warnings.join(" ")).toContain("answered 500");
    expect(out.hint).toContain("nothing needs sending again");
    expect(out.hint).not.toContain("call again");
  });

  it("ledger 501: a 5xx whose readback also fails says whether anything was saved is unknown", async () => {
    if (process.platform === "win32") return;

    login();
    let reads = 0;
    world.routes[`PUT ${SETTINGS_ROUTE}`] = () => ({ status: 503, body: { message: "Service unavailable" } });
    world.routes[`GET ${SETTINGS_ROUTE}`] = () => (reads++ === 0 ? { body: { buildSettings: CURRENT } } : { status: 503, body: { message: "Service unavailable" } });

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { chrome: { enabled: false } }, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("unavailable");
    expect(out.value).toMatchObject({ saved: "unknown", attempt: 1 });
    expect(out.hint).toContain("whether anything was saved is unknown");
    expect(out.hint).toContain("once");
  });

  it("configure with an approval that is still pending says to approve and call again, and writes nothing", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes["GET /api/cli/approvals/apr_1"] = () => ({ body: { status: "pending", used: false } });

    const out = JSON.parse(
      await builds({ action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build" } }, approvalId: "apr_1", api: API }),
    );

    expect(out.status).toBe("approval-pending");
    expect(world.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("configure with a used approval says to read the settings first", async () => {
    if (process.platform === "win32") return;

    login();
    const merged = { chrome: CURRENT.chrome, edge: CURRENT.edge, firefox: { ...CURRENT.firefox, buildCommand: "pnpm build" } };
    const fingerprint = sha256(`extension_settings.build\nsettingsDigest=${digestOf(merged)}`);
    world.routes["GET /api/cli/approvals/apr_1"] = () => ({
      body: { status: "approved", used: true, fingerprint, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const out = JSON.parse(
      await builds({ action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build" } }, approvalId: "apr_1", api: API }),
    );

    expect(out.error.name).toBe("ApprovalConsumed");
    expect(out.error.message).toContain("extension_workspace");
    expect(world.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("configure with an approved approval writes the merged settings once", async () => {
    if (process.platform === "win32") return;

    login();
    const merged = { chrome: CURRENT.chrome, edge: CURRENT.edge, firefox: { ...CURRENT.firefox, buildCommand: "pnpm build" } };
    const fingerprint = sha256(`extension_settings.build\nsettingsDigest=${digestOf(merged)}`);
    world.routes["GET /api/cli/approvals/apr_1"] = () => ({
      body: { status: "approved", used: false, fingerprint, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    world.routes[`PUT ${SETTINGS_ROUTE}`] = () => ({ body: { ok: true } });

    const out = JSON.parse(
      await builds({ action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build" } }, approvalId: "apr_1", api: API }),
    );
    const puts = world.calls.filter((call) => call.method === "PUT");

    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ buildSettings: merged, approvalId: "apr_1" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("build-configured");
    expect(out.hint).not.toContain("no approval page was involved");
  });
});
