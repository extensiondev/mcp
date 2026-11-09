import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_AUTO_OPEN_ENV, setApprovalOpener } from "../lib/approval-open";
import * as submitCheckTool from "../tools/submit-check";
import * as submitTool from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const submit = submitTool.handler;
const ROUTE = `${PROJECT_ROUTE}/stores/chrome/first-submission`;
const PAGE = "https://console.extension.dev/acme/widget/submissions/chrome";
const DASHBOARD = "https://chrome.google.com/webstore/devconsole/pub1/item1/edit";
const WAITING_SENTENCE = `Everything Chrome Web Store takes by hand is on ${PAGE}: fill the Store listing and Privacy tabs of the item's dashboard from it, answer Data usage disclosures yourself, and press Submit for review.`;

function page(state: string, extra: Record<string, unknown> = {}) {
  return {
    body: {
      store: "chrome",
      storeName: "Chrome Web Store",
      state,
      read: null,
      dashboardUrl: DASHBOARD,
      packageUrl: "https://acme.extension.dev/widget/builds/abc1234/chrome.zip",
      pageUrl: PAGE,
      left: [],
      pages: [{ page: "Store listing" }, { page: "Privacy" }],
      sayToPerson: WAITING_SENTENCE,
      pollSeconds: 0,
      ...extra,
    },
  };
}

const DONE = {
  read: { word: "submitted", storeWord: "PENDING_REVIEW", readAt: "2026-11-05T12:05:00.000Z", source: "poll" },
  sayToPerson: "Chrome Web Store says PENDING_REVIEW, read at 2026-11-05T12:05:00.000Z: the first submission is in, so later versions go to review from extension.dev.",
};

describe("extension_submit first-submission opens the console page beside the store dashboard and says what is left in one sentence", () => {
  const platform = useProjectRoutes("extdev-first-submission-");
  const opened: string[] = [];
  let restoreOpener: () => void = () => undefined;
  beforeEach(() => {
    opened.length = 0;
    vi.stubEnv("CI", "");
    vi.stubEnv("EXTENSION_HEADLESS", "");
    vi.stubEnv("EXTENSION_BROWSER_FLAGS", "");
    vi.stubEnv(NO_AUTO_OPEN_ENV, "");
    for (const key of ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"]) vi.stubEnv(key, "");
    vi.stubEnv("DISPLAY", ":0");
    restoreOpener = setApprovalOpener((url) => {
      opened.push(url);

      return true;
    });
  });

  afterEach(() => {
    restoreOpener();
    vi.unstubAllEnvs();
  });

  it("answers waiting with the platform's own sentence, opening the dashboard and the console page and nothing else", async () => {
    platform.login();
    platform.routes[`GET ${ROUTE}`] = () => page("waiting");

    const out = JSON.parse(await submit({ action: "first-submission", store: "chrome", api: API }));

    expect(out.status).toBe("first-submission-waiting");
    expect(out.value.sayToPerson).toBe(WAITING_SENTENCE);
    expect(out.value.pageUrl).toBe(PAGE);
    expect(out.value.trackUrl).toBe(PAGE);
    expect(out.value.dashboardUrl).toBe(DASHBOARD);
    expect(out.value.pages).toEqual(["Store listing", "Privacy"]);
    expect(out.value.read).toBeNull();
    expect(out.value.nextStep).toEqual({ kind: "dashboard", say: WAITING_SENTENCE, url: DASHBOARD });
    expect(opened).toEqual([DASHBOARD, PAGE]);
    expect(out.value.opened).toBe(true);
    expect(out.value.openedNote).toBeUndefined();
    expect(platform.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });

  it("says why no page opened: a headless server names its variable, and a call that waited points at waitSeconds: 0", async () => {
    platform.login();
    platform.routes[`GET ${ROUTE}`] = () => page("waiting", { pollSeconds: 2 });
    vi.stubEnv("EXTENSION_HEADLESS", "1");

    const shut = JSON.parse(await submit({ action: "first-submission", store: "chrome", api: API }));

    expect(shut.status).toBe("first-submission-waiting");
    expect(shut.value.opened).toBe(false);
    expect(shut.value.openedNote).toBe("No page was opened: EXTENSION_HEADLESS=1 is set in this server's environment. Hand the person the urls in this answer instead of calling again for a window.");
    expect(shut.hint).toContain(shut.value.openedNote);

    vi.stubEnv("EXTENSION_HEADLESS", "");
    vi.useFakeTimers();

    const call = submit({ action: "first-submission", store: "chrome", waitSeconds: 5, api: API });
    await vi.advanceTimersByTimeAsync(6_000);
    const waited = JSON.parse(await call);

    vi.useRealTimers();
    expect(waited.status).toBe("first-submission-waiting");
    expect(waited.value.opened).toBe(false);
    expect(waited.value.openedNote).toBe("No page was opened: this call waited on the platform's read; a call with waitSeconds: 0 opens the console page and the store dashboard.");
    expect(opened).toEqual([]);
  });

  it("names what is missing while the page reads to-do and points at the console page first", async () => {
    platform.login();
    platform.routes[`GET ${ROUTE}`] = () =>
      page("to-do", { left: [{ id: "chrome.item", label: "Chrome Web Store item", how: "Create it." }], sayToPerson: `Before the first Chrome Web Store submission, Chrome Web Store item is still missing, and ${PAGE} says how to add each.` });

    const out = JSON.parse(await submit({ action: "first-submission", browsers: ["chrome"], api: API }));

    expect(out.status).toBe("first-submission-to-do");
    expect(out.value.left).toEqual(["Chrome Web Store item"]);
    expect(out.value.nextStep.url).toBe(PAGE);
  });

  it("waits on the platform's read and answers done only with the store's own word, opening nothing while it waits", async () => {
    platform.login();

    let reads = 0;

    platform.routes[`GET ${ROUTE}`] = () => {
      reads += 1;

      return reads < 3 ? page("waiting") : page("done", DONE);
    };

    const out = JSON.parse(await submit({ action: "first-submission", store: "chrome", waitSeconds: 5, api: API }));

    expect(out.status).toBe("first-submission-done");
    expect(reads).toBe(3);
    expect(out.value.read).toEqual(DONE.read);
    expect(out.value.sayToPerson).toBe(DONE.sayToPerson);
    expect(out.value.nextStep.kind).toBe("preflight");
    expect(out.value.openedNote).toBe("No page was opened: the first submission is done, so nothing is left to finish on the console page.");
    expect(opened).toEqual([]);
  });

  it("refuses a done answer that carries no read word rather than relaying it", async () => {
    platform.login();
    platform.routes[`GET ${ROUTE}`] = () => page("done", { sayToPerson: "It is done." });

    const out = JSON.parse(await submit({ action: "first-submission", store: "chrome", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).not.toBe("first-submission-done");
  });

  it("says Firefox needs no page and sends nothing", async () => {
    platform.login();

    const out = JSON.parse(await submit({ action: "first-submission", store: "firefox", api: API }));

    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("Firefox AMO takes the first version");
    expect(platform.calls.filter((call) => call.path.includes("first-submission"))).toHaveLength(0);
  });

  it("runs as a read through extension_submit_check", async () => {
    platform.login();
    platform.routes[`GET ${ROUTE}`] = () => page("waiting");

    const out = JSON.parse(await submitCheckTool.handler({ action: "first-submission", store: "chrome", api: API }));

    expect(out.status).toBe("first-submission-waiting");
  });
});
