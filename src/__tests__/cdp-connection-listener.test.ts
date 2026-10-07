import { afterEach, describe, expect, it, vi } from "vitest";

import { CDPConnection } from "../lib/cdp-connection";

type Probe = {
  handleMessage(data: string): void;
  eventListeners: Set<(msg: Record<string, unknown>) => void>;
  consoleMessages: unknown[];
};

const event = JSON.stringify({
  method: "Runtime.consoleAPICalled",
  params: { type: "log", args: [{ value: "x" }], timestamp: 1 },
});

describe("a CDP event listener that throws is reported, not swallowed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the listener's error and the event name to stderr and keeps the console record", () => {
    const client = new CDPConnection() as unknown as Probe;
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));

      return true;
    }) as typeof process.stderr.write);

    let calls = 0;
    client.eventListeners.add(() => {
      calls += 1;

      throw new Error("listener bug");
    });

    expect(() => client.handleMessage(event)).not.toThrow();
    expect(calls).toBe(1);
    expect(written.join("")).toContain("listener bug");
    expect(written.join("")).toContain("Runtime.consoleAPICalled");
    expect(client.consoleMessages).toHaveLength(1);
  });

  it("still drops a frame that is not JSON without a word", () => {
    const client = new CDPConnection() as unknown as Probe;
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));

      return true;
    }) as typeof process.stderr.write);

    expect(() => client.handleMessage("not json")).not.toThrow();
    expect(written).toEqual([]);
    expect(client.consoleMessages).toHaveLength(0);
  });
});
