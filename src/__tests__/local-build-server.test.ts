import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_BUILD_CONTRACT,
  LOCAL_BUILD_LIMITS,
  LOCAL_BUILD_ORIGIN,
  startLocalBuildServer,
  type LocalBuildServer,
} from "../lib/local-build-server";

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function rawAsk(port: number, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let text = "";

    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
    });

    socket.on("end", () => resolve(text));
    socket.on("error", reject);
    socket.write(`${lines.join("\r\n")}\r\nconnection: close\r\n\r\n`);
  });
}

function ask(port: number, target: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, origin: LOCAL_BUILD_ORIGIN, ...options.headers };

    for (const [name, value] of Object.entries(headers)) if (value === "") delete headers[name];

    const req = http.request({ host: "127.0.0.1", port, path: target, method: options.method ?? "GET", headers, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];

      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });

    req.on("error", reject);
    req.end();
  });
}

function corsHeaders(headers: http.IncomingHttpHeaders): string[] {
  return Object.keys(headers).filter((name) => name.startsWith("access-control-"));
}

function keyOf(server: LocalBuildServer): string {
  return server.fragment().slice(2);
}

async function mint(server: LocalBuildServer): Promise<{ token: string; files: Array<{ path: string; size: number }> }> {
  const answer = await ask(server.port, "/v1/build", { headers: { "x-extension-dev-local-key": keyOf(server) } });

  expect(answer.status).toBe(200);

  return JSON.parse(answer.body.toString("utf8"));
}

describe("local build server", () => {
  let root: string;
  let dist: string;
  let outside: string;
  let server: LocalBuildServer | null = null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "local-build-"));
    dist = path.join(root, "dist");
    outside = path.join(root, "outside");
    fs.mkdirSync(path.join(dist, "pages"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Local", version: "1.0.0" }));
    fs.writeFileSync(path.join(dist, "pages", "popup.html"), "<p>popup</p>");
    fs.writeFileSync(path.join(dist, ".env"), "API_KEY=held-back");
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside the build");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dist, "linked.txt"));
    fs.symlinkSync(outside, path.join(dist, "linked-dir"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await server?.close();
    server = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function start(): Promise<LocalBuildServer> {
    const started = await startLocalBuildServer({ distDir: dist, name: "Local" });

    if (!started.ok) throw new Error(`did not start: ${JSON.stringify(started)}`);

    server = started.server;

    return server;
  }

  it("binds 127.0.0.1 only, lists the exact walk, and serves listed bytes to the token", async () => {
    const live = await start();

    expect(live.address).toBe(`http://127.0.0.1:${live.port}/`);
    expect(keyOf(live)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const listing = await mint(live);

    expect(listing).toMatchObject({ contract: LOCAL_BUILD_CONTRACT, name: "Local" });
    expect(listing.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(listing.token).not.toBe(keyOf(live));
    expect(listing.files.map((file) => file.path)).toEqual(["manifest.json", "pages/popup.html"]);
    expect(live.leftOut).toEqual([".env"]);

    const file = await ask(live.port, "/v1/files/pages/popup.html", { headers: { "x-extension-dev-local-token": listing.token } });

    expect(file.status).toBe(200);
    expect(file.body.toString("utf8")).toBe("<p>popup</p>");
    expect(file.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "access-control-allow-origin": LOCAL_BUILD_ORIGIN,
    });

    expect(file.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("does not bind a wildcard or IPv6 address", async () => {
    const live = await start();
    const onSix = new Promise<string>((resolve) => {
      const req = http.request({ host: "::1", family: 6, port: live.port, path: "/v1/build", headers: { origin: LOCAL_BUILD_ORIGIN, host: `localhost:${live.port}` } }, () => resolve("answered"));

      req.on("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "error"));
      req.end();
    });

    expect(await onSix).not.toBe("answered");
  });

  it.each([
    { name: "a rebinding Host", headers: { host: "attacker.example" } },
    { name: "a Host on another port", headers: { host: "127.0.0.1:1" } },
    { name: "a foreign Origin", headers: { origin: "https://evil.example" } },
    { name: "a look-alike Origin", headers: { origin: "https://preview.extension.dev.evil.example" } },
    { name: "the http Origin", headers: { origin: "http://preview.extension.dev" } },
    { name: "a null Origin", headers: { origin: "null" } },
    { name: "no Origin", headers: { origin: "" } },
  ] as Array<{ name: string; headers: Record<string, string> }>)("refuses $name with 403 and no CORS header, before the key is read", async ({ headers }) => {
    const live = await start();

    for (const method of ["GET", "OPTIONS"]) {
      const answer = await ask(live.port, "/v1/build", { method, headers: { "x-extension-dev-local-key": keyOf(live), "access-control-request-private-network": "true", ...headers } });

      expect(answer.status).toBe(403);
      expect(corsHeaders(answer.headers)).toEqual([]);
      expect(answer.headers.vary).toBeUndefined();
    }

    await mint(live);
  });

  it("refuses two Host headers even when the first is right", async () => {
    const live = await start();
    const answer = await rawAsk(live.port, [
      "GET /v1/build HTTP/1.1",
      `host: 127.0.0.1:${live.port}`,
      "host: attacker.example",
      `origin: ${LOCAL_BUILD_ORIGIN}`,
      `x-extension-dev-local-key: ${keyOf(live)}`,
    ]);

    expect(answer).toMatch(/^HTTP\/1\.1 403 /);
    expect(answer.toLowerCase()).not.toContain("access-control-");

    await mint(live);
  });

  it("accepts the localhost Host on its own port", async () => {
    const live = await start();
    const answer = await ask(live.port, "/v1/build", { headers: { host: `localhost:${live.port}`, "x-extension-dev-local-key": keyOf(live) } });

    expect(answer.status).toBe(200);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])("answers %s with 405 and no CORS header", async (method) => {
    const live = await start();
    const answer = await ask(live.port, "/v1/build", { method, headers: { "x-extension-dev-local-key": keyOf(live) } });

    expect(answer.status).toBe(405);
    expect(corsHeaders(answer.headers)).toEqual([]);

    await mint(live);
  });

  it("answers the preflight, and grants the private network header only when asked", async () => {
    const live = await start();
    const plain = await ask(live.port, "/v1/build", { method: "OPTIONS", headers: { "access-control-request-method": "GET" } });
    const asked = await ask(live.port, "/v1/build", { method: "OPTIONS", headers: { "access-control-request-method": "GET", "access-control-request-private-network": "true" } });
    const wrongMethod = await ask(live.port, "/v1/build", { method: "OPTIONS", headers: { "access-control-request-method": "POST" } });

    expect(plain.status).toBe(204);
    expect(plain.headers).toMatchObject({
      "access-control-allow-origin": LOCAL_BUILD_ORIGIN,
      "access-control-allow-methods": "GET",
      "access-control-allow-headers": "x-extension-dev-local-key, x-extension-dev-local-token",
      "access-control-max-age": "60",
      vary: "Origin, Access-Control-Request-Private-Network, Access-Control-Request-Headers",
    });

    expect(plain.headers["access-control-allow-private-network"]).toBeUndefined();
    expect(asked.headers["access-control-allow-private-network"]).toBe("true");
    expect(asked.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(wrongMethod.status).toBe(405);
    expect(corsHeaders(wrongMethod.headers)).toEqual([]);
  });

  it("spends the key on five wrong keys, so the right key then answers 410", async () => {
    const live = await start();
    const right = keyOf(live);
    const wrong = `${right.slice(0, -1)}${right.endsWith("A") ? "B" : "A"}`;

    for (const attempt of [wrong, "", right.slice(0, 10), `${right}x`, wrong]) {
      const answer = await ask(live.port, "/v1/build", { headers: { "x-extension-dev-local-key": attempt } });

      expect(answer.status).toBe(401);
    }

    expect((await ask(live.port, "/v1/build", { headers: { "x-extension-dev-local-key": right } })).status).toBe(410);
  });

  it("opens once: a replayed key answers 410", async () => {
    const live = await start();

    await mint(live);

    const replay = await ask(live.port, "/v1/build", { headers: { "x-extension-dev-local-key": keyOf(live) } });

    expect(replay.status).toBe(410);
    expect(replay.body.length).toBe(0);
  });

  it("expires an unused key at ten minutes and a token at fifteen", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

    const live = await start();

    vi.setSystemTime(Date.now() + LOCAL_BUILD_LIMITS.keyMs);
    expect((await ask(live.port, "/v1/build", { headers: { "x-extension-dev-local-key": keyOf(live) } })).status).toBe(410);

    await live.close();

    const second = await start();
    const listing = await mint(second);
    const read = () => ask(second.port, "/v1/files/manifest.json", { headers: { "x-extension-dev-local-token": listing.token } });

    vi.setSystemTime(Date.now() + LOCAL_BUILD_LIMITS.tokenMs - 60_000);
    expect((await read()).status).toBe(200);
    vi.setSystemTime(Date.now() + 60_000);
    expect((await read()).status).toBe(410);
  });

  it("closes itself twenty minutes after it starts, and five minutes idle after the token", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

    const unused = await start();
    let closed = false;

    void unused.closed.then(() => {
      closed = true;
    });

    vi.advanceTimersByTime(LOCAL_BUILD_LIMITS.lifeMs - 1);
    await Promise.resolve();
    expect(closed).toBe(false);
    vi.advanceTimersByTime(1);
    await unused.closed;

    const idle = await start();
    const listing = await mint(idle);
    let idleClosed = false;

    void idle.closed.then(() => {
      idleClosed = true;
    });

    vi.advanceTimersByTime(LOCAL_BUILD_LIMITS.idleMs - 1000);
    expect((await ask(idle.port, "/v1/files/manifest.json", { headers: { "x-extension-dev-local-token": listing.token } })).status).toBe(200);
    vi.advanceTimersByTime(LOCAL_BUILD_LIMITS.idleMs - 1000);
    await Promise.resolve();
    expect(idleClosed).toBe(false);
    vi.advanceTimersByTime(1000);
    await idle.closed;

    await expect(ask(idle.port, "/v1/build")).rejects.toThrow();
  });

  it("serves only listed paths to the right token, refusing traversal, encoded traversal and symlinks", async () => {
    const live = await start();
    const listing = await mint(live);
    const read = (target: string, token = listing.token) => ask(live.port, target, { headers: { "x-extension-dev-local-token": token } });

    expect((await read("/v1/files/manifest.json", "")).status).toBe(401);
    expect((await read("/v1/files/manifest.json", keyOf(live))).status).toBe(401);

    for (const target of [
      "/v1/files/../outside/secret.txt",
      "/v1/files/pages/../manifest.json",
      "/v1/files/%2e%2e/outside/secret.txt",
      "/v1/files/..%2Foutside%2Fsecret.txt",
      "/v1/files/pages%2Fpopup.html",
      "/v1/files/%252e%252e/outside/secret.txt",
      "/v1/files/pages%5Cpopup.html",
      "/v1/files//manifest.json",
      "/v1/files/./manifest.json",
      "/v1/files/%00manifest.json",
      "/v1/files/%E0%A4%A",
      "/v1/files/linked.txt",
      "/v1/files/linked-dir/secret.txt",
      "/v1/files/.env",
      "/v1/files/missing.js",
      "/v1/files/manifest.json?x=1",
      "/v1/files/",
      "/v1/files",
      "/v1/build/../files/manifest.json",
    ]) {
      const answer = await read(target);

      expect([target, answer.status]).toEqual([target, 404]);
      expect(answer.body.toString("utf8")).not.toContain("outside the build");
    }
  });

  it("refuses a listed file swapped for a symlink after the mint", async () => {
    const live = await start();
    const listing = await mint(live);

    fs.writeFileSync(path.join(outside, "same-size.txt"), "SECRETSECRET");
    fs.rmSync(path.join(dist, "pages", "popup.html"));
    fs.symlinkSync(path.join(outside, "same-size.txt"), path.join(dist, "pages", "popup.html"));

    const answer = await ask(live.port, "/v1/files/pages/popup.html", { headers: { "x-extension-dev-local-token": listing.token } });

    expect(answer.status).not.toBe(200);
    expect(answer.body.toString("utf8")).not.toContain("SECRET");
  });

  it.each([
    { name: "more than 500 files", fill: (dir: string) => { for (let index = 0; index < LOCAL_BUILD_LIMITS.files; index += 1) fs.writeFileSync(path.join(dir, `f${index}.js`), ""); }, reason: "too-many-files" },
    { name: "more than 25 MB", fill: (dir: string) => fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(LOCAL_BUILD_LIMITS.bytes)), reason: "too-large" },
  ])("will not start on a build with $name", async ({ fill, reason }) => {
    fill(dist);

    const started = await startLocalBuildServer({ distDir: dist, name: "Local" });

    expect(started).toMatchObject({ ok: false, stage: "list", reason });
  });

  it("answers the bind failure by its code alone", async () => {
    vi.spyOn(http.Server.prototype, "listen").mockImplementation(function failing(this: http.Server) {
      process.nextTick(() => this.emit("error", Object.assign(new Error("listen EACCES"), { code: "EACCES" })));

      return this;
    });

    expect(await startLocalBuildServer({ distDir: dist, name: "Local" })).toEqual({ ok: false, stage: "bind", code: "EACCES" });
  });
});
