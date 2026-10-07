import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler } from "../tools/logs";
import { CONTROL_WS_PATH } from "../tools/logs-constants";
import { readyContract } from "./fixtures/engine-answers";

import type net from "node:net";

function writeReady(projectPath: string, browser: string, port: number): void {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ready.json"),
    JSON.stringify(
      readyContract("dev", browser, {
        controlPort: port,
        instanceId: "inst-1",
        runId: "run-1",
        distPath: path.join(projectPath, "dist", browser),
        logsPath: path.join(dir, "logs.ndjson"),
      }),
    ),
  );
}

describe("extension_logs follow: control channel error mid-stream", () => {
  let tmp: string;
  let wss: WebSocketServer;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-logs-follow-"));
    wss = new WebSocketServer({ port: 0, path: CONTROL_WS_PATH });
    await new Promise<void>((resolve) => wss.on("listening", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the collected events with a warning instead of discarding them", async () => {
    const port = (wss.address() as { port: number }).port;
    writeReady(tmp, "chromium", port);
    wss.on("connection", (conn) => {
      conn.send(
        JSON.stringify({
          type: "log",
          event: { context: "background", level: "info", message: "hi", seq: 3 },
        }),
      );

      conn.send(JSON.stringify({ type: "gap", dropped: 2 }));
      setTimeout(() => {
        const raw = (conn as unknown as { _socket: net.Socket })._socket;
        raw.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
      }, 100);
    });

    const started = Date.now();
    const out = JSON.parse(
      await handler({
        projectPath: tmp,
        browser: "chromium",
        follow: true,
        followMs: 6000,
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.value.source).toBe("stream");
    expect(out.value.events).toHaveLength(1);
    expect(out.value.events[0].message).toBe("hi");
    expect(out.value.dropped).toBe(2);
    expect(out.value.nextSince).toBe(3);
    expect(
      out.warnings.some((w: string) => w.includes("partial read")),
    ).toBe(true);

    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);

  it("keeps the hard failure when the channel errors before anything arrives", async () => {
    const port = (wss.address() as { port: number }).port;
    writeReady(tmp, "chromium", port);
    wss.on("connection", (conn) => {
      setTimeout(() => {
        const raw = (conn as unknown as { _socket: net.Socket })._socket;
        raw.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
      }, 50);
    });

    const out = JSON.parse(
      await handler({
        projectPath: tmp,
        browser: "chromium",
        follow: true,
        followMs: 6000,
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_CONTROL_CHANNEL");
  }, 10000);

  /* @invariant a channel that closes mid-window is a partial read, and the broker's ring state is reported. */
  it("says a channel that closed before the window ended is a partial read", async () => {
    const port = (wss.address() as { port: number }).port;
    writeReady(tmp, "chromium", port);
    wss.on("connection", (conn) => {
      conn.send(JSON.stringify({ type: "ready", runId: "run-1", bufferedFrom: 120, evicted: 119 }));
      conn.send(JSON.stringify({ type: "log", event: { context: "background", level: "info", messageParts: ["hi"], seq: 120, timestamp: Date.now() } }));
      setTimeout(() => conn.close(1000, "server restart"), 150);
    });

    const out = JSON.parse(
      await handler({ projectPath: tmp, browser: "chromium", follow: true, followMs: 4000 }),
    );
    expect(out.ok).toBe(true);
    expect(out.value.opened).toBe(true);
    expect(out.value.readySeen).toBe(true);
    expect(out.value.bufferedFrom).toBe(120);
    expect(out.value.evicted).toBe(119);
    const text = out.warnings.join("\n");
    expect(text).toMatch(/closed after \d+ s of the 4 s window/);
    expect(text).toMatch(/evicted 119 older event/);
  }, 10000);

  it("says when the broker never sent its ready frame", async () => {
    const port = (wss.address() as { port: number }).port;
    writeReady(tmp, "chromium", port);
    wss.on("connection", () => {});
    const out = JSON.parse(
      await handler({ projectPath: tmp, browser: "chromium", follow: true, followMs: 1500 }),
    );
    expect(out.value.readySeen).toBe(false);
    expect(out.warnings.join("\n")).toMatch(/never sent its ready frame/);
  }, 10000);
});
