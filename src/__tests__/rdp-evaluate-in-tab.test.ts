import net from "node:net";
import vm from "node:vm";

import { describe, it, expect, afterEach } from "vitest";

import {
  encodeRdpPacket,
  RdpPacketDecoder,
  rdpEvaluateInTab,
  rdpPollExpression,
  rdpStartExpression,
  readRdpEvalSlot,
} from "../lib/rdp";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function roundTrip(expression: string, globals: Record<string, unknown> = {}) {
  const context = vm.createContext({ ...globals });
  expect(vm.runInContext(rdpStartExpression(expression, "t1"), context)).toBe("started");
  await settle();

  return readRdpEvalSlot(vm.runInContext(rdpPollExpression("t1"), context));
}

describe("the expression a console actor is handed", () => {
  it("embeds the expression as source and never calls eval, which the document's policy refuses", () => {
    const text = rdpStartExpression("document.title", "t1");

    expect(text).toContain("document.title");
    expect(text).not.toMatch(/\beval\s*\(/);
    expect(rdpPollExpression("t1")).not.toMatch(/\beval\s*\(/);
  });

  it("hands a value back as JSON", async () => {
    expect(await roundTrip("({ a: [1, 'two'] })")).toEqual({
      ok: true,
      value: { a: [1, "two"] },
    });
  });

  it("settles a promise inside the document before it answers", async () => {
    expect(await roundTrip("Promise.resolve(41).then((n) => n + 1)")).toEqual({
      ok: true,
      value: 42,
    });
  });

  it("answers pending while the promise is still open, and keeps the slot", () => {
    const context = vm.createContext({});
    vm.runInContext(rdpStartExpression("new Promise(() => {})", "t1"), context);

    expect(readRdpEvalSlot(vm.runInContext(rdpPollExpression("t1"), context))).toBe("pending");
    expect(readRdpEvalSlot(vm.runInContext(rdpPollExpression("t1"), context))).toBe("pending");
  });

  it("reports a throw and a rejection with the error's own name", async () => {
    expect(await roundTrip("nope.nope")).toEqual({
      ok: false,
      name: "ReferenceError",
      message: "nope is not defined",
    });

    expect(await roundTrip("Promise.reject(new TypeError('late'))")).toEqual({
      ok: false,
      name: "TypeError",
      message: "late",
    });
  });

  it("reads undefined as null and a value JSON cannot carry as its string form", async () => {
    expect(await roundTrip("undefined")).toEqual({ ok: true, value: null });
    expect(await roundTrip("(function named() {})")).toEqual({
      ok: true,
      value: "function named() {}",
    });
  });

  it("clears its slot once read, so a second read says the result is gone", async () => {
    const context = vm.createContext({});
    vm.runInContext(rdpStartExpression("1", "t1"), context);
    await settle();
    vm.runInContext(rdpPollExpression("t1"), context);

    expect(readRdpEvalSlot(vm.runInContext(rdpPollExpression("t1"), context))).toBe("lost");
    expect(vm.runInContext("typeof globalThis.__extensionDevRdpEval", context)).toBe("undefined");
  });

  it("keeps a trailing line comment from swallowing the wrapper", async () => {
    expect(await roundTrip("1 + 1 // sum")).toEqual({ ok: true, value: 2 });
  });
});

type Packet = Record<string, unknown>;
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

function firefox(options: {
  tabs: Packet[];
  globals?: Record<string, unknown>;
  longStringOver?: number;
  syntaxError?: boolean;
}): Promise<{ port: number; requests: Packet[] }> {
  const requests: Packet[] = [];
  const context = vm.createContext({ ...(options.globals ?? {}) });
  const longStrings = new Map<string, string>();
  let nextResult = 0;
  const server = net.createServer((socket) => {
    const decoder = new RdpPacketDecoder();
    const send = (packet: Packet) => socket.write(encodeRdpPacket(packet));
    send({ from: "root", applicationType: "browser" });
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const packet of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        requests.push(packet);

        if (packet.type === "listTabs") send({ from: "root", tabs: options.tabs });
        else if (packet.type === "getWatcher") send({ from: packet.to, actor: "watcher1" });
        else if (packet.type === "watchTargets") {
          send({
            from: "watcher1",
            type: "target-available-form",
            target: { actor: "frame1", consoleActor: "console1", isTopLevelTarget: true },
          });

          send({ from: "watcher1" });
        } else if (packet.type === "evaluateJSAsync") {
          const resultID = `r${nextResult++}`;
          send({ from: "console1", resultID });

          if (options.syntaxError) {
            send({
              from: "console1",
              type: "evaluationResult",
              resultID,
              hasException: true,
              exceptionMessage: "SyntaxError: expected expression, got keyword 'var'",
            });

            continue;
          }

          const value = vm.runInContext(String(packet.text), context) as unknown;
          setTimeout(() => {
            let result: unknown = value;

            if (
              typeof value === "string" &&
              options.longStringOver !== undefined &&
              value.length > options.longStringOver
            ) {
              const actor = `long${longStrings.size}`;
              longStrings.set(actor, value);
              result = {
                type: "longString",
                actor,
                length: value.length,
                initial: value.slice(0, options.longStringOver),
              };
            }

            send({ from: "console1", type: "evaluationResult", resultID, result });
          }, 0);
        } else if (packet.type === "substring") {
          const whole = longStrings.get(String(packet.to)) ?? "";
          send({
            from: packet.to,
            substring: whole.slice(Number(packet.start), Number(packet.end)),
          });
        }
      }
    });
  });
  servers.push(server);

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as net.AddressInfo).port, requests });
    });
  });
}

const PANEL = "moz-extension://uuid/pages/panel.html";
const TABS = [
  { actor: "tab1", url: "https://example.com/", title: "Example" },
  { actor: "tab2", url: PANEL, title: "panel", selected: true },
];

describe("rdpEvaluateInTab", () => {
  it("evaluates in the tab the caller picks, through that tab's watcher and console actor", async () => {
    const { port, requests } = await firefox({ tabs: TABS, globals: { marker: "from-panel" } });

    const outcome = await rdpEvaluateInTab(port, {
      select: (tabs) => tabs.find((tab) => tab.url === PANEL),
      expression: "marker",
      timeoutMs: 2_000,
    });

    expect(outcome).toEqual({
      ok: true,
      value: "from-panel",
      tab: { url: PANEL, title: "panel" },
    });

    expect(requests.find((r) => r.type === "getWatcher")?.to).toBe("tab2");
    expect(requests.find((r) => r.type === "evaluateJSAsync")?.to).toBe("console1");
  });

  it("waits for a promise the expression returns", async () => {
    const { port } = await firefox({ tabs: TABS, globals: { setTimeout } });

    const outcome = await rdpEvaluateInTab(port, {
      select: (tabs) => tabs[1],
      expression: "new Promise((resolve) => setTimeout(() => resolve({ late: true }), 150))",
      timeoutMs: 2_000,
    });

    expect(outcome).toMatchObject({ ok: true, value: { late: true } });
  });

  it("reads a long string through the grip instead of stopping at its first part", async () => {
    const { port, requests } = await firefox({ tabs: TABS, longStringOver: 64 });

    const outcome = await rdpEvaluateInTab(port, {
      select: (tabs) => tabs[1],
      expression: "'x'.repeat(5000)",
      timeoutMs: 2_000,
    });

    expect(outcome).toMatchObject({ ok: true, value: "x".repeat(5000) });
    expect(requests.some((r) => r.type === "substring")).toBe(true);
  });

  it("hands back the expression's own error", async () => {
    const { port } = await firefox({ tabs: TABS });

    await expect(
      rdpEvaluateInTab(port, { select: (tabs) => tabs[1], expression: "nope.nope", timeoutMs: 2_000 }),
    ).resolves.toEqual({ ok: false, name: "ReferenceError", message: "nope is not defined" });
  });

  it("reports text the document could not parse instead of polling for a result that never started", async () => {
    const { port, requests } = await firefox({ tabs: TABS, syntaxError: true });

    const outcome = await rdpEvaluateInTab(port, {
      select: (tabs) => tabs[1],
      expression: "var a = 1; a",
      timeoutMs: 2_000,
    });

    expect(outcome).toEqual({
      ok: false,
      name: "EvalError",
      message: "SyntaxError: expected expression, got keyword 'var'",
    });

    expect(requests.filter((r) => r.type === "evaluateJSAsync")).toHaveLength(1);
  });

  it("says no tab matches without opening a watcher", async () => {
    const { port, requests } = await firefox({ tabs: TABS });

    const outcome = await rdpEvaluateInTab(port, {
      select: () => undefined,
      expression: "1",
      timeoutMs: 2_000,
    });

    expect(outcome).toMatchObject({ ok: false, name: "TargetNotFound" });
    expect(requests.some((r) => r.type === "getWatcher")).toBe(false);
  });

  it("gives up on a promise that outlives the timeout", async () => {
    const { port } = await firefox({ tabs: TABS });

    const outcome = await rdpEvaluateInTab(port, {
      select: (tabs) => tabs[1],
      expression: "new Promise(() => {})",
      timeoutMs: 300,
    });

    expect(outcome).toMatchObject({ ok: false, name: "Timeout" });
  });
});
