import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCredential } from "../lib/credential-source";
import {
  credentialsPath,
  listCredentials,
  readCredentials,
  writeCredentialBatch,
  writeCredentials,
  type StoredCredentials,
} from "../lib/credentials";
import { persistTokenResponse } from "../lib/login-flow";
import { clearLocalCredentials } from "../tools/logout";
import * as auth from "../tools/auth";

const LOCAL = "http://localhost:3100";
const PROD = "https://www.extension.dev";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function login(projectSlug: string, api: string, token = `${api}-${projectSlug}`): StoredCredentials {
  return {
    version: 1,
    token,
    workspaceSlug: "open-source-demo",
    projectSlug,
    expiresAt: FUTURE,
    api,
    provider: "extensiondev",
  };
}

const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const saved: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-per-server-"));
  process.env.XDG_CONFIG_HOME = tmp;
  delete process.env.EXTENSION_DEV_API_URL;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("per-server login tests never reach the network");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("stored logins are keyed by server and project", () => {
  it("keeps a production login when a local server login for the same project is stored", () => {
    writeCredentials(login("vue-devtools", PROD));
    persistTokenResponse({
      apiBase: LOCAL,
      project: "open-source-demo/vue-devtools",
      data: { token: "local-token", workspaceSlug: "open-source-demo", projectSlug: "vue-devtools" },
    });

    expect(listCredentials()).toHaveLength(2);
    expect(readCredentials({ project: "open-source-demo/vue-devtools" })?.token).toBe(`${PROD}-vue-devtools`);
    expect(readCredentials({ project: "open-source-demo/vue-devtools", api: LOCAL })?.token).toBe("local-token");
  });

  it("keeps every production login when a batch of local logins with the same names is stored", () => {
    const names = ["alpha", "beta", "gamma"];
    for (const name of names) writeCredentials(login(name, PROD));
    writeCredentialBatch(names.map((name) => login(name, LOCAL)));

    for (const name of names) {
      expect(readCredentials({ project: `open-source-demo/${name}` })?.token).toBe(`${PROD}-${name}`);
      expect(readCredentials({ project: `open-source-demo/${name}`, api: LOCAL })?.token).toBe(`${LOCAL}-${name}`);
    }
  });

  it("keeps a local login when a production login for the same project is stored after it", () => {
    writeCredentials(login("widget", LOCAL));
    writeCredentials(login("widget", PROD));

    expect(readCredentials({ project: "open-source-demo/widget", api: `${LOCAL}/` })?.token).toBe(`${LOCAL}-widget`);
  });

  it("resolves the login for the server a call targets: api input, then EXTENSION_DEV_API_URL, then production", () => {
    writeCredentials(login("widget", PROD));
    writeCredentials(login("widget", LOCAL));

    expect(resolveCredential({ project: "open-source-demo/widget" }).token).toBe(`${PROD}-widget`);
    expect(resolveCredential({}).token).toBe(`${PROD}-widget`);
    expect(resolveCredential({ project: "open-source-demo/widget", api: LOCAL }).token).toBe(`${LOCAL}-widget`);

    process.env.EXTENSION_DEV_API_URL = LOCAL;
    expect(resolveCredential({}).token).toBe(`${LOCAL}-widget`);
    expect(resolveCredential({ api: PROD }).token).toBe(`${PROD}-widget`);
  });

  it("never sends a local server login to production", () => {
    writeCredentials(login("widget", LOCAL));

    expect(resolveCredential({ project: "open-source-demo/widget" }).token).toBe("");
    expect(resolveCredential({}).token).toBe("");
  });

  it("reads a login written before logins carried a server as a production login", () => {
    const file = credentialsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacy = { ...login("widget", PROD), api: undefined };
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 2, active: "open-source-demo/widget", entries: { "open-source-demo/widget": legacy } }),
    );

    expect(readCredentials({ project: "open-source-demo/widget" })?.token).toBe(`${PROD}-widget`);
    expect(readCredentials({ project: "open-source-demo/widget", api: LOCAL })).toBeNull();

    writeCredentials(login("widget", LOCAL));
    expect(readCredentials({ project: "open-source-demo/widget" })?.token).toBe(`${PROD}-widget`);
  });

  it("files a local login an older client stored under the bare project name under its own server", () => {
    const file = credentialsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 2, active: "open-source-demo/widget", entries: { "open-source-demo/widget": login("widget", LOCAL) } }),
    );

    expect(readCredentials({ project: "open-source-demo/widget" })).toBeNull();

    writeCredentials(login("widget", PROD));

    expect(readCredentials({ project: "open-source-demo/widget" })?.token).toBe(`${PROD}-widget`);
    expect(readCredentials({ project: "open-source-demo/widget", api: LOCAL })?.token).toBe(`${LOCAL}-widget`);
  });
});

describe("logout and status act on the server a call targets", () => {
  it("removes only the targeted server's login for a named project", async () => {
    writeCredentials(login("widget", PROD));
    writeCredentials(login("widget", LOCAL));

    const out = JSON.parse(await clearLocalCredentials("open-source-demo/widget", LOCAL));

    expect(out.status).toBe("logged-out");
    expect(readCredentials({ project: "open-source-demo/widget" })?.token).toBe(`${PROD}-widget`);
    expect(readCredentials({ project: "open-source-demo/widget", api: LOCAL })).toBeNull();
  });

  it("an unnamed logout against a local server leaves the production logins", async () => {
    writeCredentials(login("widget", PROD));
    writeCredentials(login("widget", LOCAL));
    writeCredentials(login("gadget", LOCAL));

    const out = JSON.parse(await auth.handler({ action: "logout", api: LOCAL }));

    expect(out.status).toBe("logged-out");
    expect(out.value.removed).toHaveLength(2);
    expect(listCredentials().map((entry) => entry.token)).toEqual([`${PROD}-widget`]);
  });

  it("an unnamed logout against production leaves the local logins", async () => {
    writeCredentials(login("widget", PROD));
    writeCredentials(login("widget", LOCAL));

    await auth.handler({ action: "logout" });

    expect(fs.existsSync(credentialsPath())).toBe(true);
    expect(listCredentials().map((entry) => entry.token)).toEqual([`${LOCAL}-widget`]);
  });

  it("status reports the login of the server it targets", async () => {
    writeCredentials(login("widget", PROD, "prod-token"));
    writeCredentials(login("gadget", LOCAL, "local-token"));

    const local = JSON.parse(await auth.handler({ action: "status", api: LOCAL }));
    const production = JSON.parse(await auth.handler({ action: "status" }));

    expect(local.value.projectSlug).toBe("gadget");
    expect(production.value.projectSlug).toBe("widget");
    expect(production.value.logins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project: "open-source-demo/gadget", server: LOCAL, active: false }),
        expect.objectContaining({ project: "open-source-demo/widget", server: PROD }),
      ]),
    );
  });
});
