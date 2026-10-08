import { describe, expect, it, vi } from "vitest";

import { CDPClient } from "../lib/cdp";

describe("Page.navigate answers a refused navigation as errorText without a protocol error, and navigate reports it instead of calling the page navigated", () => {
  it("throws with the browser's own error text", async () => {
    const cdp = new CDPClient();
    const sendCommand = vi.fn(async (method: string) =>
      method === "Page.navigate" ? { errorText: "net::ERR_NAME_NOT_RESOLVED" } : {},
    );
    (cdp as unknown as { sendCommand: typeof sendCommand }).sendCommand = sendCommand;

    await expect(cdp.navigate("session-1", "https://nowhere.invalid/")).rejects.toThrow(
      /refused to navigate to https:\/\/nowhere\.invalid\/: net::ERR_NAME_NOT_RESOLVED/,
    );
  });
});
