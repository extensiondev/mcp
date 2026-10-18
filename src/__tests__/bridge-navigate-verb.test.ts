import { describe, expect, it, vi } from "vitest";

import { navigateToUrlViaBridge } from "../lib/bridge-tabs";
import { actFailure, actFrame, tabRows } from "./fixtures/engine-answers";

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

  it("calls a tab that landed on the extension's own page, carrying the requested url, navigated by redirect", async () => {
    const requested = "http://127.0.0.1:8765/media/letter.pdf";
    const viewer = `moz-extension://6f1c2d3e-aaaa-bbbb-cccc-1234567890ab/pages/pdf.html#${requested}`;
    reset(
      { ok: true, command: "navigate", status: "ok", value: { tabId: 7, url: requested, created: false } },
      actFrame("inspect", tabRows([{ id: 7, url: viewer, title: "PDF viewer" }])),
    );

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "firefox", requested, 600));
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("navigated");
    expect(parsed.value.redirected).toEqual({ from: requested, to: viewer });
    expect(parsed.value.tab).toMatchObject({ tabId: 7, url: viewer, title: "PDF viewer" });
    expect(parsed.value.navigated).toBe(requested);
    expect(parsed.hint).toMatch(/redirect/i);
    expect(parsed.hint).toContain(viewer);
  });

  it("calls a tab that landed on another web page navigated by redirect", async () => {
    const requested = "http://127.0.0.1:8765/old";
    const landed = "https://docs.test/new";
    reset(
      { ok: true, command: "navigate", status: "ok", value: { tabId: 7, url: requested, created: false } },
      actFrame("inspect", tabRows([{ id: 7, url: landed, title: "New home" }])),
      actFrame("inspect", tabRows([{ id: 7, url: landed, title: "New home" }])),
      actFrame("inspect", tabRows([{ id: 7, url: landed, title: "New home" }])),
    );

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "firefox", requested, 600));
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("navigated");
    expect(parsed.value.redirected).toEqual({ from: requested, to: landed });
    expect(parsed.value.tab.url).toBe(landed);
    expect(parsed.hint).toMatch(/redirect/i);
  });

  it("keeps the navigation unconfirmed when the tab shows the browser's error page or no url", async () => {
    for (const shown of ["about:neterror?e=dnsNotFound&u=http%3A//nothing.test/", ""]) {
      reset(
        { ok: true, command: "navigate", status: "ok", value: { tabId: 7, url: "http://nothing.test/", created: false } },
        actFrame("inspect", tabRows([{ id: 7, url: shown, title: "Server Not Found" }])),
        actFrame("inspect", tabRows([{ id: 7, url: shown, title: "Server Not Found" }])),
        actFrame("inspect", tabRows([{ id: 7, url: shown, title: "Server Not Found" }])),
      );

      const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "firefox", "http://nothing.test/", 600));
      expect(parsed.ok).toBe(false);
      expect(parsed.status).toBe("navigation-unconfirmed");
      expect(parsed.error.code).toBe("E_NAVIGATE_FAILED");
      expect(parsed.value.redirected).toBeUndefined();
    }
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
      actFrame("eval", { tabId: 3 }),
      actFrame("inspect", tabRows([{ id: 3, url: "https://b.test/", title: "B" }])),
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
      actFailure("eval", { name: "Unsupported", code: "E_UNSUPPORTED", message: "eval is blocked in the extension background by CSP" }),
    );

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "safari", "https://b.test/"));
    expect(parsed.ok).toBe(false);
    expect(parsed.hint).toContain("extension navigate");
  });
});
