import { describe, expect, it, vi } from "vitest";

import { navigateToUrlViaBridge } from "../lib/bridge-tabs";
import { actFailure, actFrame, tabRows } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";

const act = vi.hoisted(() => ({
  calls: [] as string[][],
  replies: [] as Array<{ body: string; afterMs: number }>,
}));

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      act.calls.push(cli);
      const next = act.replies.shift();

      if (next && next.afterMs > 0) await new Promise((resolve) => setTimeout(resolve, next.afterMs));

      return next?.body ?? JSON.stringify({ ok: true, value: {} });
    },
  };
});

function reset(...replies: unknown[]) {
  act.calls.length = 0;
  act.replies.length = 0;
  for (const r of replies) act.replies.push({ body: JSON.stringify(r), afterMs: 0 });
}

function slow(reply: unknown, afterMs: number) {
  act.replies.push({ body: JSON.stringify(reply), afterMs });
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

  it("on Safari reads the tab list a second time when the first read outlives the budget, instead of calling the navigation unconfirmed", async () => {
    reset({ ok: true, command: "navigate", status: "ok", value: { tabId: 7, url: "https://a.test/", created: false } });
    slow(actFailure("inspect", { name: "CliTimeout", code: "E_CLI", message: "the control channel answered nothing within the budget" }), 700);
    slow(actFrame("inspect", tabRows([{ id: 7, url: "https://a.test/", title: "A" }])), 0);

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "safari", "https://a.test/", 600));
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("navigated");
    expect(parsed.value.tab).toMatchObject({ tabId: 7, url: "https://a.test/" });
    expect(act.calls.filter((c) => c[0] === "inspect")).toHaveLength(2);
  });

  it("on Safari says the unconfirmed read had its longer budget when both reads fail", async () => {
    reset(
      { ok: true, command: "navigate", status: "ok", value: { tabId: 7, url: "https://a.test/", created: false } },
      actFailure("inspect", { name: "CliTimeout", code: "E_CLI", message: "nothing within the budget" }),
    );

    slow(actFailure("inspect", { name: "CliTimeout", code: "E_CLI", message: "nothing within the budget" }), 650);

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "safari", "https://a.test/", 600));
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("navigation-unconfirmed");
    expect(parsed.error.message).toContain("rides the extension's background, which answers slowly right after it wakes");
    expect(act.calls.filter((c) => c[0] === "inspect")).toHaveLength(2);
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

  it("carries the tab's active flag from the engine's tab row and says a hidden tab is not observed", async () => {
    reset(
      { ok: true, command: "navigate", status: "ok", value: { tabId: 7, url: "https://a.test/", created: true } },
      actFrame("inspect", tabRows([{ id: 1, url: "https://front.test/", title: "Front", active: true }, { id: 7, url: "https://a.test/", title: "A", active: false }])),
    );

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "firefox", "https://a.test/"));
    expect(parsed.ok).toBe(true);
    expect(parsed.value.tab).toEqual({ tabId: 7, url: "https://a.test/", title: "A", active: false });
    expect(parsed.value).not.toHaveProperty("viewport");
    expect(parsed.hint).toContain("The tab is hidden (not the active tab)");
  });

  it("answers the tab's active flag and viewport from the fallback eval when the engine's tab carries them", async () => {
    reset(
      { ok: false, error: { code: "E_CLI", message: "error: unknown command 'navigate'" } },
      actFrame("eval", { tabId: 3, active: true, width: 1200, height: 700 }),
      actFrame("inspect", tabRows([{ id: 3, url: "https://b.test/", title: "B" }])),
    );

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "firefox", "https://b.test/"));
    expect(parsed.ok).toBe(true);
    expect(act.calls[1][1]).toContain("tab.width");
    expect(parsed.value.tab).toEqual({ tabId: 3, url: "https://b.test/", title: "B", active: true });
    expect(parsed.value.viewport).toEqual({ width: 1200, height: 700 });
    expect(parsed.hint).toContain("The viewport is 1200x700");
  });

  it("omits active and viewport from the fallback eval answer when the engine's tab carries neither", async () => {
    reset(
      { ok: false, error: { code: "E_CLI", message: "error: unknown command 'navigate'" } },
      actFrame("eval", { tabId: 3 }),
      actFrame("inspect", tabRows([{ id: 3, url: "https://b.test/", title: "B" }])),
    );

    const parsed = JSON.parse(await navigateToUrlViaBridge("/p", "firefox", "https://b.test/"));
    expect(parsed.ok).toBe(true);
    expect(parsed.value.tab).toEqual({ tabId: 3, url: "https://b.test/", title: "B" });
    expect(parsed.value).not.toHaveProperty("viewport");
  });
});
