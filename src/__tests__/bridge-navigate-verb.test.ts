import { describe, expect, it, vi } from "vitest";

import { navigateToUrlViaBridge } from "../lib/bridge-tabs";
import { actFrame, tabRows } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";

const act = vi.hoisted(() => ({
  calls: [] as string[][],
  replies: [] as string[],
}));

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      act.calls.push(cli);

      return act.replies.shift() ?? JSON.stringify({ ok: true, value: {} });
    },
  };
});

function reset(...replies: unknown[]) {
  act.calls.length = 0;
  act.replies.length = 0;
  for (const r of replies) act.replies.push(JSON.stringify(r));
}

describe("navigateToUrlViaBridge asks the engine's navigate verb first", () => {
  it("uses the verb's answer and never evals when the engine knows it", async () => {
    reset(
      { ok: true, command: "navigate", status: "ok", value: { tabId: 7, url: "https://a.test/", created: false } },
      actFrame("inspect", tabRows([{ id: 7, url: "https://a.test/", title: "A" }])),
    );

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "safari", "https://a.test/"));
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("navigated");
    expect(parsed.value).toMatchObject({ navigated: "https://a.test/", tabId: 7, created: false, via: "navigate" });
    expect(act.calls.filter((c) => c[0] === "navigate")).toHaveLength(1);
    expect(act.calls.filter((c) => c[0] === "eval")).toHaveLength(0);
    expect(act.calls[0].slice(0, 2)).toEqual(["navigate", "https://a.test/"]);
  });

  it("does not call a navigation navigated when the tab never reports the url", async () => {
    reset(
      { ok: true, command: "navigate", status: "ok", value: { tabId: 7, url: "http://localhost:5173/", created: false } },
      actFrame("inspect", tabRows([{ id: 7, url: "about:blank", title: "" }])),
      actFrame("inspect", tabRows([{ id: 7, url: "about:blank", title: "" }])),
    );

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "firefox", "http://localhost:5173/"));
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("navigation-unconfirmed");
    expect(parsed.error.message).toContain("about:blank");
  });

  it("passes the verb's own refusal through, with a hint", async () => {
    reset({ ok: false, error: { code: "E_SESSION_NOT_FOUND", message: "No active control channel found for safari." } });
    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "safari", "https://a.test/"));
    expect(parsed.ok).toBe(false);
    expect(parsed.hint).toContain("allowControl");
    expect(act.calls).toHaveLength(1);
  });

  it("falls back to the background eval only when the engine does not know the verb", async () => {
    reset(
      { ok: false, error: { code: "E_CLI", message: "error: unknown command 'navigate'" } },
      { ok: true, value: { tabId: 3 } },
      { ok: true, value: [{ id: 3, url: "https://b.test/", title: "B" }] },
    );

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "firefox", "https://b.test/"));
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("navigated");
    expect(act.calls.map((c) => c[0])).toEqual(["navigate", "eval", "inspect"]);
    expect(act.calls[1]).toContain("background");
  });

  it("names the upgrade when the fallback eval is refused", async () => {
    reset(
      { ok: false, error: { code: "E_CLI", message: "error: unknown command 'navigate'" } },
      { ok: false, error: { name: "Unsupported", message: "eval is blocked in the extension background by CSP" } },
    );

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "safari", "https://b.test/"));
    expect(parsed.ok).toBe(false);
    expect(parsed.hint).toContain("extension navigate");
  });
});
