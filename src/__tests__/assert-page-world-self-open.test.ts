// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GUEST_ID,
  PAGE_URL,
  STATIC_MANIFEST,
  assertOnce,
  live,
  liveSession,
  usePageWorldProject,
  writeManifest,
} from "./assert-page-world-harness";

import type * as OpenModule from "../tools/open";

const opens = {
  calls: [] as unknown[][],
  answer: null as null | (() => string),
};

vi.mock("../tools/open", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenModule>();

  return {
    ...actual,
    navigateToUrl: async (...args: unknown[]) => {
      opens.calls.push(args);

      if (opens.answer) return opens.answer();

      live.targets.push({ id: "tab", type: "page", url: String(args[2]), title: "opened by the check" });

      return JSON.stringify({
        ok: true,
        command: "extension_open",
        status: "navigated",
        value: { navigated: args[2], openedNewTab: true, target: { targetId: "tab", url: args[2], title: "opened by the check" } },
      });
    },
  };
});

const { assertVerdict, passCheck, inconclusiveCheck, verdictSentence } = await import("../lib/verdict");
const { notReadyCheck } = await import("../lib/verdict-not-ready");

usePageWorldProject();

beforeEach(() => {
  opens.calls = [];
  opens.answer = null;
  live.targets = [{ id: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` }];
});

describe("page-world-clean opens the page itself when a full url matches no open target", () => {
  it("opens a full url through extension_open's navigation, reads the page it landed and passes", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession("start");

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });

    expect(opens.calls).toEqual([[live.project, "chrome", PAGE_URL, undefined]]);
    expect(check.outcome).toBe("pass");
    expect(check.reason).toBeUndefined();
    expect(check.evidence.openedByCheck).toBe(PAGE_URL);
    expect(check.evidence.url).toBe(PAGE_URL);
    expect(frame.hint).toBe("1/1 passed.");
  });

  it("never opens a url pattern, and answers not ready with the page named as the precondition", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession("start");

    const pattern = "https://www.youtube.com/watch?v=*";
    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: pattern });

    expect(opens.calls).toEqual([]);
    expect(check.outcome).toBe("inconclusive");
    expect(check.reason).toBe("not-ready");
    expect(check.detail).toMatch(/a url pattern is matched, never opened; a full url is opened by this check/);
    expect(check.settledBy).toBe(
      `The page this check reads is not open: open it with extension_open (url: '${pattern}'), wait for it to load, then assert again.`,
    );

    expect(frame.status).toBe("inconclusive");
    expect(frame.hint).toBe(
      `0/1 passed, 1 not ready, a precondition this platform covers once it is met (not a platform limit, not a bug in the extension): the page this check reads is not open: open it with extension_open (url: '${pattern}'), wait for it to load, then assert again.`,
    );

    expect(frame.hint).not.toMatch(/cannot cover/);
  });

  it("answers not ready, naming the navigation's own answer, when the open does not land a page", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession("start");
    opens.answer = () =>
      JSON.stringify({
        ok: false,
        command: "extension_open",
        status: "navigate-blocked",
        error: { code: "E_NAVIGATE_FAILED", message: "The browser refused the url and shows its own error page instead." },
      });

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL });

    expect(opens.calls).toHaveLength(1);
    expect(check.outcome).toBe("inconclusive");
    expect(check.reason).toBe("not-ready");
    expect(check.detail).toContain("opening it from this check did not land a page (extension_open answered navigate-blocked: The browser refused the url and shows its own error page instead.)");
    expect(frame.hint).toMatch(/^0\/1 passed, 1 not ready/);
  });

  it("keeps the platform-limit sentence for a check this platform cannot read", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession("start");

    const { frame, check } = await assertOnce({ assert: "page-world-clean", url: PAGE_URL }, "firefox");

    expect(opens.calls).toEqual([]);
    expect(check.outcome).toBe("inconclusive");
    expect(check.reason).toBeUndefined();
    expect(frame.hint).toMatch(/1 inconclusive, meaning this platform cannot cover the question today/);
    expect(frame.hint).not.toMatch(/not ready/);
  });
});

describe("verdictSentence counts not-ready checks apart from platform limits", () => {
  it("names each precondition from settledBy and keeps the platform-limit count beside it", () => {
    const verdict = assertVerdict({
      checks: [
        passCheck("background-worker-booted", null, "booted"),
        notReadyCheck("page-world-clean", "https://a.test/", "not open", "Open https://a.test/ first, then assert again."),
        inconclusiveCheck("no-outside-requests", null, "no CDP here", "Run it on Chromium."),
      ],
    });

    expect(verdictSentence(verdict)).toBe(
      "1/3 passed, 1 not ready, a precondition this platform covers once it is met (not a platform limit, not a bug in the extension): open https://a.test/ first, then assert again, 1 inconclusive, meaning this platform cannot cover the question today: not a pass, not a bug in the extension, and each one carries the evidence that would settle it in settledBy.",
    );
  });
});
