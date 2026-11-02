import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { localizedMessage, messageKeyOf } from "../lib/publish-localized-name";
import { handler } from "../tools/publish";
import { storedZip } from "./fixtures/stored-zip";

const SHA = "331fbe9";
const PACKAGE = (file: string) => `/api/projects/prj_soccer/builds/${SHA}/artifacts/${file}`;

const platform = vi.hoisted(() => ({
  answer: {} as Record<string, unknown>,
  packages: {} as Record<string, Buffer | number>,
  calls: [] as string[],
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function localized(messages: Record<string, unknown>, manifest: Record<string, unknown> = {}): Buffer {
  return storedZip({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "__MSG_extName__", default_locale: "en", version: "1.0.0", ...manifest }),
    "_locales/en/messages.json": JSON.stringify(messages),
  });
}

function respond(url: string): Response {
  platform.calls.push(url);

  if (url.endsWith("/api/cli/whoami")) return json({ projectId: "prj_soccer" });

  if (url.endsWith("/api/cli/publish")) {
    return json({
      shareUrl: `https://cezaraugusto.extension.dev/soccer-analysis/builds/${SHA}?share=share.tok`,
      visibility: "private",
      buildSha: SHA,
      projectName: "soccer-analysis",
      extensionName: null,
      expiresAt: Math.floor(Date.UTC(2026, 11, 1, 12) / 1000),
      ...platform.answer,
    });
  }

  const pkg = Object.keys(platform.packages).find((file) => url.endsWith(PACKAGE(file)));

  if (pkg) {
    const sent = platform.packages[pkg];
    if (typeof sent === "number") return json({ message: "The registry refused this read." }, sent);

    return new Response(sent, { status: 200, headers: { "content-type": "application/zip", "content-length": String(sent.length) } });
  }

  return json({ message: "Not found" }, 404);
}

describe("extension_publish names a localized extension by its messages, never by its key", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-publish-locale-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_TOKEN = `${Buffer.from(
      JSON.stringify({ u: "cezaraugusto", p: "soccer-analysis", exp: Math.floor(Date.now() / 1000) + 600 }),
    ).toString("base64url")}.sig`;

    platform.answer = {};
    platform.packages = {};
    platform.calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => respond(String(input instanceof Request ? input.url : input))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves __MSG_extName__ from _locales/<default_locale>/messages.json of the served build and tells testers that name", async () => {
    platform.packages["chrome.zip"] = localized({ extName: { message: "Lance" } });

    const out = JSON.parse(await handler({ buildSha: SHA, ttlHours: 720 }));

    expect(out.ok).toBe(true);
    expect(out.value.extensionName).toBe("Lance");
    expect(out.value.extensionNameFrom).toBe("chrome.zip:_locales/en/messages.json");
    expect(out.value.tellThem).toContain("Lance");
    expect(out.value.tellThem).not.toContain("soccer-analysis to try");
    expect(JSON.stringify(out)).not.toContain("__MSG_");
  });

  it("reads the key the platform answered as written and looks it up case blind, the way the browser does", async () => {
    platform.answer = { extensionName: "__MSG_appName__" };
    platform.packages["chrome.zip"] = localized({ AppName: { message: "Lance" } }, { name: "__MSG_appName__" });

    const out = JSON.parse(await handler({ buildSha: SHA }));

    expect(out.value.extensionName).toBe("Lance");
    expect(JSON.stringify(out)).not.toContain("__MSG_");
  });

  it("takes the next package when the build has no Chrome one", async () => {
    platform.packages["edge.zip"] = localized({ extName: { message: "Lance" } });

    const out = JSON.parse(await handler({ buildSha: SHA }));

    expect(out.value.extensionName).toBe("Lance");
    expect(out.value.extensionNameFrom).toBe("edge.zip:_locales/en/messages.json");
  });

  it("drops a key it cannot resolve, names the project instead, and says why", async () => {
    platform.answer = { extensionName: "__MSG_extName__" };
    platform.packages["chrome.zip"] = 502;

    const out = JSON.parse(await handler({ buildSha: SHA }));

    expect(out.value.extensionName).toBeNull();
    expect(out.value.tellThem).toContain("soccer-analysis");
    expect(out.warnings.join(" ")).toContain("localized message that could not be resolved");
    expect(JSON.stringify(out)).not.toContain("__MSG_");
  });

  it("keeps a plain name the platform answered and reads no package", async () => {
    platform.answer = { extensionName: "Lance" };

    const out = JSON.parse(await handler({ buildSha: SHA }));

    expect(out.value.extensionName).toBe("Lance");
    expect(platform.calls.some((url) => url.includes("/artifacts/"))).toBe(false);
  });

  it("says nothing new when the platform named no extension and the package cannot be read", async () => {
    const out = JSON.parse(await handler({ buildSha: SHA }));

    expect(out.value.extensionName).toBeNull();
    expect(out.value.tellThem).toContain("soccer-analysis");
    expect(out.warnings.join(" ")).not.toContain("localized message");
  });
});

describe("the message key reads", () => {
  it("knows a key only in the __MSG_name__ shape and never answers a message that is itself a key", () => {
    expect(messageKeyOf("__MSG_extName__")).toBe("extName");
    expect(messageKeyOf("Lance")).toBeNull();
    expect(messageKeyOf("__MSG_ext Name__")).toBeNull();
    expect(localizedMessage({ extname: { message: " Lance " } }, "extName")).toBe("Lance");
    expect(localizedMessage({ extName: { message: "__MSG_other__" } }, "extName")).toBeNull();
    expect(localizedMessage({ extName: { description: "no message" } }, "extName")).toBeNull();
  });
});
