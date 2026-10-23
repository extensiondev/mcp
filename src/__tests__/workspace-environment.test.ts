import { describe, expect, it } from "vitest";

import { approvalVerdict } from "../lib/approval-policy";
import { trackFields } from "../lib/track-url";
import { handler as workspace, schema } from "../tools/workspace";
import { ENVIRONMENT_ACTION, ENVIRONMENT_SCOPES, environmentRows, readEnvironmentChange } from "../tools/workspace-environment";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const ENV = `${PROJECT_ROUTE}/settings/env`;
const APPROVALS = "/api/cli/approvals";
const LEAKED = "hunter2-never-answered";

const STORED = {
  envVars: [
    { key: "API_BASE_URL", value: LEAKED, note: "where the API lives", tier: "plaintext", addedAt: 1760000000000, hasValue: true, scope: "all" },
    { key: "SENTRY_DSN", value: "", note: "", tier: "sensitive", addedAt: null, hasValue: true, scope: "production" },
  ],
};

function workspaceRoutes(platform: ReturnType<typeof useProjectRoutes>) {
  platform.routes["GET /api/workspaces/acme"] = () => ({ body: { slug: "acme", displayName: "Acme", currentUserRole: "owner", currentUserLogin: "octocat", projectCount: 1, memberCount: 1 } });
  platform.routes["GET /api/workspaces/acme/plan"] = () => ({ status: 500, body: { message: "no plan" } });
}

describe("extension_workspace reads environment variables by name and writes plain ones, never a secret", () => {
  const platform = useProjectRoutes("extdev-workspace-environment-");

  it("offers include environment and set-environment with variables and remove, and both acts are plain in the policy table", () => {
    const props = schema.inputSchema.properties as unknown as Record<string, { enum?: string[]; items?: { enum?: string[]; properties?: Record<string, unknown> } }>;

    expect(props.include.items?.enum).toContain("environment");
    expect(props.action.enum).toContain("set-environment");
    expect(Object.keys(props.variables.items?.properties ?? {})).toEqual(["name", "value", "scope", "note", "secret"]);
    expect(props.remove.items?.properties).toHaveProperty("scope");
    expect(ENVIRONMENT_SCOPES).toEqual(["all", "production", "staging"]);
    expect(approvalVerdict(ENVIRONMENT_ACTION)).toBe("plain");
    expect(trackFields("extension_workspace", { args: { action: "set-environment", project: "acme/widget" }, status: "environment-set", value: {} })?.trackUrl).toMatch(/\/acme\/widget\/project-settings\/environment$/);
    expect(trackFields("extension_workspace", { args: { include: ["environment"], project: "acme/widget" }, status: "read", value: {} })?.trackUrl).toMatch(/\/acme\/widget\/project-settings\/environment$/);
  });

  it("copies the name, scope, secret flag and updated time of every row and never a value field", () => {
    const rows = environmentRows(STORED);

    expect(rows).toEqual([
      { name: "API_BASE_URL", scope: "all", note: "where the API lives", secret: false, hasValue: true, updatedAt: "2025-10-09T08:53:20.000Z" },
      { name: "SENTRY_DSN", scope: "production", note: "", secret: true, hasValue: true, updatedAt: null },
    ]);

    expect(JSON.stringify(rows)).not.toContain(LEAKED);
  });

  it("reads the input: names, scopes and notes, and refuses a bad name, an empty value or an unknown scope", () => {
    expect(readEnvironmentChange({ variables: [{ name: "API_BASE_URL", value: "https://api.acme.test", scope: "staging", note: "staging API" }], remove: ["OLD_FLAG", { name: "OLD_KEY", scope: "production" }] })).toEqual({
      set: [{ key: "API_BASE_URL", value: "https://api.acme.test", scope: "staging", note: "staging API" }],
      remove: [
        { key: "OLD_FLAG", scope: "all" },
        { key: "OLD_KEY", scope: "production" },
      ],
    });

    expect(readEnvironmentChange({ variables: [{ name: "api-url", value: "x" }] })).toMatchObject({ problem: expect.stringContaining("not a variable name") });
    expect(readEnvironmentChange({ variables: [{ name: "API_URL", value: "" }] })).toMatchObject({ problem: "API_URL needs a non-empty string value." });
    expect(readEnvironmentChange({ variables: [{ name: "API_URL", value: "x", scope: "preview" }] })).toMatchObject({ problem: expect.stringContaining("scope must be one of") });
    expect(readEnvironmentChange({})).toMatchObject({ problem: expect.stringContaining("needs variables") });
    expect(readEnvironmentChange({ variables: [{ name: "TOKEN", value: "x", secret: true }, { name: "URL", value: "y" }] })).toEqual({ secret: ["TOKEN"] });
  });

  it("include environment adds the rows to the info answer with the console page, and the answer carries no value", async () => {
    if (process.platform === "win32") return;

    platform.login();
    workspaceRoutes(platform);
    platform.routes[`GET ${ENV}`] = () => ({ body: STORED });

    const raw = await workspace({ include: ["environment"], api: API });
    const out = JSON.parse(raw);

    expect(out.ok).toBe(true);
    expect(out.value.environment.variables.map((row: { name: string; secret: boolean }) => [row.name, row.secret])).toEqual([
      ["API_BASE_URL", false],
      ["SENTRY_DSN", true],
    ]);

    expect(out.value.environment.consoleUrl).toMatch(/\/acme\/widget\/project-settings\/environment$/);
    expect(out.hint).toContain("2 environment variables (1 secret)");
    expect(raw).not.toContain(LEAKED);
    expect(out.value.environment.variables.every((row: Record<string, unknown>) => !("value" in row))).toBe(true);
  });

  it("sets and removes plain variables as one plain call, answers the names and never the value, and mints nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const value = "https://api.acme.test/v2-secret-looking";
    platform.routes[`PUT ${ENV}`] = () => ({ body: { ok: true, mode: "secrets+metadata", secretsError: null, changes: ["set API_BASE_URL (all)", "remove OLD_FLAG (all)"] } });
    platform.routes[`GET ${ENV}`] = () => ({ body: STORED });

    const raw = await workspace({ action: "set-environment", variables: [{ name: "API_BASE_URL", value, note: "where the API lives" }], remove: ["OLD_FLAG"], api: API });
    const out = JSON.parse(raw);
    const puts = platform.sent("PUT", ENV);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("environment-set");
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({
      envVars: [{ key: "API_BASE_URL", value, tier: "plaintext", scope: "all", note: "where the API lives" }],
      remove: [{ key: "OLD_FLAG", scope: "all" }],
      reconcile: false,
    });

    expect(out.value.changes).toEqual(["set API_BASE_URL (all)", "remove OLD_FLAG (all)"]);
    expect(out.value.variables.map((row: { name: string }) => row.name)).toEqual(["API_BASE_URL", "SENTRY_DSN"]);
    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/project-settings\/environment$/);
    expect(out.hint).toContain("no approval page was involved");
    expect(raw).not.toContain(value);
    expect(raw).not.toContain(LEAKED);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("refuses a variable flagged secret with the console environment page, making no platform call at all", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const value = "sk_live_do_not_send";

    const raw = await workspace({ action: "set-environment", variables: [{ name: "STRIPE_KEY", value, secret: true }], api: API });
    const out = JSON.parse(raw);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("secret-console-only");
    expect(out.error.code).toBe("E_CONSOLE_ONLY");
    expect(out.error.name).toBe("SecretConsoleOnly");
    expect(out.value.names).toEqual(["STRIPE_KEY"]);
    expect(out.value.consoleUrl).toMatch(/\/acme\/widget\/project-settings\/environment$/);
    expect(out.value.trackUrl).toBe(out.value.consoleUrl);
    expect(out.error.message).toContain("Nothing was sent");
    expect(platform.calls).toHaveLength(0);
    expect(raw).not.toContain(value);
  });

  it("answers the platform's CONSOLE_ONLY refusal of a stored secret under the same console-only answer, with no value in it", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const value = "new-dsn-value";
    platform.routes[`PUT ${ENV}`] = () => ({ status: 403, body: { code: "CONSOLE_ONLY", message: "SENTRY_DSN is a secret; a token never writes it.", names: ["SENTRY_DSN"] } });

    const raw = await workspace({ action: "set-environment", variables: [{ name: "SENTRY_DSN", value, scope: "production" }], api: API });
    const out = JSON.parse(raw);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("secret-console-only");
    expect(out.error.platformCode).toBe("CONSOLE_ONLY");
    expect(out.value.names).toEqual(["SENTRY_DSN"]);
    expect(raw).not.toContain(value);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("is refused OWNER_REQUIRED when the token's minter is not an owner", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${ENV}`] = () => ({ status: 403, body: { code: "OWNER_REQUIRED", message: "This is a workspace owner action." } });

    const out = JSON.parse(await workspace({ action: "set-environment", variables: [{ name: "FLAG", value: "on" }], api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.platformCode).toBe("OWNER_REQUIRED");
  });
});
