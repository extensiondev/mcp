import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as bridge from "extension-develop/bridge";
import { handler, controlRefusal } from "../tools/logs";
import {
  CLOSE_BAD_HELLO,
  CLOSE_BAD_INSTANCE,
  CLOSE_CONTROL_UNAVAILABLE,
  CLOSE_REFUSAL_FLOOR,
  CLOSE_SLOW_CONSUMER,
  CONTROL_ENVELOPE_VERSION,
  CONTROL_WS_PATH,
  LOG_EVENT_VERSION,
} from "../tools/logs-constants";
import { readyContractPath, logsPath } from "../lib/session-paths";

describe("control-channel constants come from the engine, not from literals", () => {
  it("re-exports the engine's own wire constants by identity", () => {
    expect(CONTROL_WS_PATH).toBe(bridge.CONTROL_WS_PATH);
    expect(CONTROL_ENVELOPE_VERSION).toBe(bridge.CONTROL_ENVELOPE_VERSION);
    expect(LOG_EVENT_VERSION).toBe(bridge.LOG_EVENT_VERSION);
  });

  it("still describes a usable channel", () => {
    expect(CONTROL_WS_PATH.startsWith("/")).toBe(true);
    expect(Number.isInteger(CONTROL_ENVELOPE_VERSION)).toBe(true);
    expect(Number.isInteger(LOG_EVENT_VERSION)).toBe(true);
  });

  /* @invariant A value comparison alone cannot catch a regression here: a re-hardcoded
     "/extjs-control" equals the engine's constant today and the assertion above
     stays green while the coupling is gone. The source is what proves the
     coupling, so this reads it. */
  it("declares them as re-exports, with no literal to drift", () => {
    const source = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "tools",
        "logs-constants.ts",
      ),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const name of [
      "CONTROL_WS_PATH",
      "CONTROL_ENVELOPE_VERSION",
      "LOG_EVENT_VERSION",
      "CLOSE_BAD_INSTANCE",
      "CLOSE_BAD_HELLO",
      "CLOSE_CONTROL_UNAVAILABLE",
      "CLOSE_SLOW_CONSUMER",
    ]) {
      expect(code).not.toMatch(new RegExp(`(const|let|var)\\s+${name}\\s*=`));
    }
    expect(code).toMatch(
      /export\s*\{[^}]*CONTROL_WS_PATH[^}]*\}\s*from\s*["']extension-develop\/bridge["']/s,
    );
    expect(code).toMatch(
      /export\s*\{[^}]*CLOSE_SLOW_CONSUMER[^}]*\}\s*from\s*["']extension-develop\/bridge["']/s,
    );
  });

  /* @invariant This used to assert the pinned bridge WITHHELD the close codes, which was
     the condition that justified carrying them as literals. The pin moved to
     4.0.19, that assertion fired, and the copy became a re-export. What it
     asserts now is the risk that survives the adoption: an import cannot be a
     transposed digit, but it CAN quietly become undefined if a future pin walks
     back the export or renames one, and undefined compares equal to nothing, so
     every refusal would fall through to the generic 4xxx remedy while the four
     tests below still pass on their own literals. Identity against the module
     namespace is what proves the value is the engine's and not a fallback. */
  it("takes the close codes from the engine, by identity", () => {
    const published = bridge as unknown as Record<string, number | undefined>;
    const adopted: Record<string, number> = {
      CLOSE_BAD_INSTANCE,
      CLOSE_BAD_HELLO,
      CLOSE_CONTROL_UNAVAILABLE,
      CLOSE_SLOW_CONSUMER,
    };
    for (const [name, value] of Object.entries(adopted)) {
      expect(
        published[name],
        `extension-develop/bridge no longer exports ${name}: every refusal would read as an unrecognised close`,
      ).toBeTypeOf("number");
      expect(value, `${name} is not the engine's own value`).toBe(
        published[name],
      );
    }
  });

  /* @invariant The numbers the four remedies in tools/logs.ts were written against, kept
     as literals HERE precisely because logs-constants no longer has any. An
     engine that renumbers a close code under a compatible-looking version bump
     would keep every identity assertion above green while handing a
     slow-consumer drop the version-mismatch remedy, and this is the only place
     that would notice. Read off the engine's own contracts.ts. */
  it("uses the broker's numbers, not numbers of its own", () => {
    expect(CLOSE_BAD_INSTANCE).toBe(4001);
    expect(CLOSE_BAD_HELLO).toBe(4002);
    expect(CLOSE_CONTROL_UNAVAILABLE).toBe(4003);
    expect(CLOSE_SLOW_CONSUMER).toBe(4008);
  });

  /* @invariant The floor is deliberately NOT adopted: the engine publishes no such
     constant, and 4000 here is this package's reading rule for a code it does
     not recognise, not a number the broker sends. It still has to sit below
     every code it is meant to admit, or a real refusal would be read as an
     ordinary transport close and reported as an empty log. */
  it("keeps the refusal floor local and below every code it admits", () => {
    expect(
      (bridge as unknown as Record<string, unknown>).CLOSE_REFUSAL_FLOOR,
    ).toBeUndefined();
    for (const code of [
      CLOSE_BAD_INSTANCE,
      CLOSE_BAD_HELLO,
      CLOSE_CONTROL_UNAVAILABLE,
      CLOSE_SLOW_CONSUMER,
    ]) {
      expect(code).toBeGreaterThanOrEqual(CLOSE_REFUSAL_FLOOR);
      expect(controlRefusal(code, "", "ws://x", 1)).toBeDefined();
    }
    expect(controlRefusal(CLOSE_REFUSAL_FLOOR - 1, "", "ws://x", 1)).toBeUndefined();
  });
});

/* @invariant Version skew: this MCP drives whatever engine the project has installed,
   which can be OLDER than the one this package pins. These are the two shapes
   that failure takes, and both must produce a sentence a caller can act on
   rather than an answer that looks correct. */
describe("older engine, different session layout", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-skew-layout-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("names the path it read when a session wrote its logs somewhere else", async () => {
    const legacy = path.join(tmp, "dist", "extension-js-legacy", "chromium");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(
      path.join(legacy, "logs.ndjson"),
      `${JSON.stringify({ context: "background", level: "error", seq: 1 })}\n`,
    );

    const out = JSON.parse(
      await handler({ projectPath: tmp, browser: "chromium" }),
    );

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_LOGS_MISSING");
    expect(out.error.message).toContain(logsPath(tmp, "chromium"));
    expect(out.hint).toContain(logsPath(tmp, "chromium"));
    expect(out.hint).toMatch(/older Extension\.js/);
  });

  it("names the contract path when a matching log file exists but no contract does", async () => {
    const file = logsPath(tmp, "chromium");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ type: "header", runId: "r" })}\n`);

    const out = JSON.parse(
      await handler({ projectPath: tmp, browser: "chromium" }),
    );

    expect(out.ok).toBe(true);
    expect(out.value.matched).toBe(0);
    const warning = (out.warnings as string[]).find((w) =>
      w.includes("No ready.json"),
    );
    expect(warning).toBeDefined();
    expect(warning).toContain(readyContractPath(tmp, "chromium"));
  });
});

describe("older engine, different control envelope", () => {
  it("says nothing about a refusal for an ordinary socket close", () => {
    expect(controlRefusal(1000, "", "ws://x", 1)).toBeUndefined();
    expect(controlRefusal(1006, "abnormal", "ws://x", 1)).toBeUndefined();
    expect(controlRefusal(3999, "", "ws://x", 1)).toBeUndefined();
  });

  it("names the code, the broker's reason and the version it dialed with", () => {
    const refusal = controlRefusal(
      CLOSE_BAD_HELLO,
      "unsupported envelope version",
      "ws://127.0.0.1:9/extjs-control",
      7,
    );
    expect(refusal?.message).toContain("4002");
    expect(refusal?.message).toContain("unsupported envelope version");
    expect(refusal?.message).toContain("ws://127.0.0.1:9/extjs-control");
    expect(refusal?.message).toContain("version 7");
    expect(refusal?.message).toMatch(/older/);
  });

  /* @invariant The whole point of naming the codes: four refusals, four remedies. Each
     assertion below pins the ONE action that fixes that close and, where the
     confusion would be expensive, pins that the wrong action is not suggested. */
  describe("each refusal names its own remedy", () => {
    const url = "ws://127.0.0.1:9/extjs-control";

    it("reads 4002 as version skew and sends the caller to the engine", () => {
      const refusal = controlRefusal(CLOSE_BAD_HELLO, "bad hello", url, 1);
      expect(refusal?.code).toBe("E_CONTROL_ENVELOPE");
      expect(refusal?.status).toBe("control-channel-refused");
      expect(refusal?.hint).toMatch(/Update the project's Extension\.js/);
    });

    it("reads 4001 as a stale contract, not as an engine to upgrade", () => {
      const refusal = controlRefusal(
        CLOSE_BAD_INSTANCE,
        "instanceId mismatch",
        url,
        1,
      );
      expect(refusal?.code).toBe("E_STALE_CONTRACT");
      expect(refusal?.status).toBe("control-channel-stale");
      expect(refusal?.message).toMatch(/PREVIOUS dev session/);
      expect(refusal?.hint).toMatch(/extension_wait/);
      expect(refusal?.hint).not.toMatch(/Update the project's Extension\.js/);
    });

    it("reads 4003 as a session started without allowControl", () => {
      const refusal = controlRefusal(
        CLOSE_CONTROL_UNAVAILABLE,
        "control channel not available",
        url,
        1,
      );
      expect(refusal?.code).toBe("E_NO_CONTROL_CHANNEL");
      expect(refusal?.status).toBe("control-channel-unavailable");
      expect(refusal?.hint).toMatch(/allowControl: true/);
      expect(refusal?.hint).not.toMatch(/Update the project's Extension\.js/);
    });

    it("reads 4008 as this reader falling behind, with the session blameless", () => {
      const refusal = controlRefusal(CLOSE_SLOW_CONSUMER, "slow consumer", url, 1);
      expect(refusal?.code).toBe("E_CONTROL_CHANNEL");
      expect(refusal?.status).toBe("control-channel-dropped");
      expect(refusal?.message).toMatch(/fell far enough behind/);
      expect(refusal?.hint).toMatch(/Narrow the query/);
      expect(refusal?.hint).not.toMatch(/Update the project's Extension\.js/);
    });

    it("keeps an unknown 4xxx generic instead of guessing a remedy", () => {
      const refusal = controlRefusal(4099, "something new", url, 1);
      expect(refusal?.code).toBe("E_CONTROL_CHANNEL");
      expect(refusal?.message).toMatch(/does not recognise/);
      expect(refusal?.message).toContain("something new");
    });

    it("gives no two of them the same status", () => {
      const statuses = [
        CLOSE_BAD_INSTANCE,
        CLOSE_BAD_HELLO,
        CLOSE_CONTROL_UNAVAILABLE,
        CLOSE_SLOW_CONSUMER,
      ].map((code) => controlRefusal(code, "", url, 1)?.status);
      expect(new Set(statuses).size).toBe(statuses.length);
    });
  });

  describe("end to end against a broker that rejects the hello", () => {
    let tmp: string;
    let wss: WebSocketServer;

    beforeEach(async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-skew-envelope-"));
      wss = new WebSocketServer({ port: 0, path: CONTROL_WS_PATH });
      await new Promise<void>((resolve) => wss.on("listening", resolve));
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    function writeReady(browser: string, port: number): void {
      const file = readyContractPath(tmp, browser);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          status: "ready",
          controlPort: port,
          instanceId: "inst-1",
          runId: "run-1",
        }),
      );
    }

    it("reports the refusal instead of an empty read", async () => {
      const port = (wss.address() as { port: number }).port;
      writeReady("chromium", port);
      let sawVersion: unknown;
      wss.on("connection", (conn) => {
        conn.on("message", (data) => {
          sawVersion = JSON.parse(data.toString()).v;
          conn.close(4002, "unsupported envelope version");
        });
      });

      const out = JSON.parse(
        await handler({
          projectPath: tmp,
          browser: "chromium",
          follow: true,
          followMs: 6000,
        }),
      );

      expect(sawVersion).toBe(CONTROL_ENVELOPE_VERSION);
      expect(out.ok).toBe(false);
      expect(out.status).toBe("control-channel-refused");
      expect(out.error.code).toBe("E_CONTROL_ENVELOPE");
      expect(out.error.message).toContain("4002");
      expect(out.error.message).toContain("unsupported envelope version");
      expect(out.hint).toContain("without follow");
    }, 15000);

    it("carries the stale-contract diagnosis out through the envelope", async () => {
      const port = (wss.address() as { port: number }).port;
      writeReady("chromium", port);
      wss.on("connection", (conn) => {
        conn.on("message", () =>
          conn.close(CLOSE_BAD_INSTANCE, "instanceId mismatch"),
        );
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
      expect(out.status).toBe("control-channel-stale");
      expect(out.error.code).toBe("E_STALE_CONTRACT");
      expect(out.error.message).toContain("4001");
      expect(out.hint).toMatch(/extension_wait/);
    }, 15000);

    it("carries the slow-consumer diagnosis out through the envelope", async () => {
      const port = (wss.address() as { port: number }).port;
      writeReady("chromium", port);
      wss.on("connection", (conn) => {
        conn.on("message", () =>
          conn.close(CLOSE_SLOW_CONSUMER, "slow consumer"),
        );
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
      expect(out.status).toBe("control-channel-dropped");
      expect(out.error.code).toBe("E_CONTROL_CHANNEL");
      expect(out.hint).toMatch(/Narrow the query/);
    }, 15000);

    it("keeps a clean close resolving as an ordinary empty read", async () => {
      const port = (wss.address() as { port: number }).port;
      writeReady("chromium", port);
      wss.on("connection", (conn) => {
        conn.on("message", () => conn.close(1000, "bye"));
      });

      const out = JSON.parse(
        await handler({
          projectPath: tmp,
          browser: "chromium",
          follow: true,
          followMs: 6000,
        }),
      );

      expect(out.ok).toBe(true);
      expect(out.value.matched).toBe(0);
    }, 15000);

    it("still surfaces the refusal as a warning when frames already arrived", async () => {
      const port = (wss.address() as { port: number }).port;
      writeReady("chromium", port);
      wss.on("connection", (conn) => {
        conn.on("message", () => {
          conn.send(
            JSON.stringify({
              type: "log",
              event: { context: "background", level: "info", seq: 4 },
            }),
          );
          setTimeout(() => conn.close(4002, "unsupported envelope version"), 50);
        });
      });

      const out = JSON.parse(
        await handler({
          projectPath: tmp,
          browser: "chromium",
          follow: true,
          followMs: 6000,
        }),
      );

      expect(out.ok).toBe(true);
      expect(out.value.events).toHaveLength(1);
      expect(
        (out.warnings as string[]).some((w) => w.includes("4002")),
      ).toBe(true);
    }, 15000);
  });
});
