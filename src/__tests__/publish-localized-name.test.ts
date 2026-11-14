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
