import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APPROVAL_OPENED_SENTENCE, approvalBatchSentence, forgetOpenedApprovals, openApprovalOnce, setApprovalOpener } from "../lib/approval-open";
import { verifyApproval } from "../lib/approval-verify";
import { envelope } from "../lib/envelope";
import { handler } from "../tools/approvals";

const API = "https://api.test";
const DESKTOP = { HOME: "/Users/person" };
const id = (letter: string) => `apr_${letter.repeat(32)}`;
const CHROME = id("C");
const EDGE = id("E");
const FIREFOX = id("F");
const SAFARI = id("S");

function asked(approvalId: string, api = API): string {
  return envelope({
    ok: false,
    command: "extension_submit",
    status: "approval-required",
    error: { code: "E_APPROVAL_REQUIRED", message: "A workspace owner approves this first." },
    value: { approvalId, approvalUrl: `${api}/device/approve/${approvalId}` },
    hint: `Approve at ${api}/device/approve/${approvalId}.`,
  });
}

describe("approvals opened together open one page that lists them all (ledger 173)", () => {
  const opened: string[] = [];
  let restore: () => void = () => undefined;

  beforeEach(() => {
    opened.length = 0;
    forgetOpenedApprovals();
    restore = setApprovalOpener((url) => {
      opened.push(url);

      return true;
    });
  });

  afterEach(() => {
    restore();
    vi.useRealTimers();
  });

  it("opens the first request's own page, then one page with every request asked for since", () => {
    const first = JSON.parse(openApprovalOnce(asked(CHROME), { noShip: false }, DESKTOP, "darwin"));
    const second = JSON.parse(openApprovalOnce(asked(EDGE), { noShip: false }, DESKTOP, "darwin"));
    openApprovalOnce(asked(FIREFOX), { noShip: false }, DESKTOP, "darwin");
    const fourth = JSON.parse(openApprovalOnce(asked(SAFARI), { noShip: false }, DESKTOP, "darwin"));

    expect(opened).toEqual([
      `${API}/device/approve/${CHROME}`,
      `${API}/device/approve?ids=${CHROME},${EDGE}`,
      `${API}/device/approve?ids=${CHROME},${EDGE},${FIREFOX}`,
      `${API}/device/approve?ids=${CHROME},${EDGE},${FIREFOX},${SAFARI}`,
    ]);

    expect(first.hint).toContain(APPROVAL_OPENED_SENTENCE);
    expect(first.value.approvalBatchUrl).toBeUndefined();
    expect(second.value).toMatchObject({ approvalOpened: true, approvalBatchUrl: `${API}/device/approve?ids=${CHROME},${EDGE}` });
    expect(fourth.hint).toContain(approvalBatchSentence(4));
    expect(fourth.hint).not.toContain(APPROVAL_OPENED_SENTENCE);
  });

  it("leaves a request asked for more than ten minutes earlier, or on another platform, off the list", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T18:00:00.000Z"));
    openApprovalOnce(asked(CHROME), { noShip: false }, DESKTOP, "darwin");
    vi.setSystemTime(new Date("2026-11-01T18:05:00.000Z"));
    openApprovalOnce(asked(EDGE, "https://other.test"), { noShip: false }, DESKTOP, "darwin");
    vi.setSystemTime(new Date("2026-11-01T18:11:00.000Z"));
    openApprovalOnce(asked(FIREFOX), { noShip: false }, DESKTOP, "darwin");

    expect(opened[opened.length - 1]).toBe(`${API}/device/approve/${FIREFOX}`);
  });
});

describe("a pending approval says when its page was last open, if ever (ledger 173)", () => {
  const pendingRead = (page?: Record<string, unknown>) =>
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "pending",
          fingerprint: "f".repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          used: false,
          ...(page ? { page } : {}),
        }),
        { status: 200 },
      ),
    );

  async function verify(page?: Record<string, unknown>) {
    const result = await verifyApproval({
      base: API,
      fingerprint: "f".repeat(64),
      input: {
        command: "extension_submit",
        action: "extension_submit",
        scope: {},
        description: "Upload build 603fc8a to Firefox Add-ons.",
        approvalId: FIREFOX,
        token: "tok",
        api: API,
      },
      doFetch: pendingRead(page) as unknown as typeof fetch,
    });

    return JSON.parse(result.blocked ? result.envelope : "{}");
  }

  it("says nobody had the page open, and when it was shown signed out", async () => {
    const out = await verify({ openedAt: null, openCount: 0, signedOutAt: "2026-11-01T18:00:00.000Z" });

    expect(out.status).toBe("approval-pending");
    expect(out.hint).toContain("Nobody has had the approval page open while signed in since it was asked for.");
    expect(out.hint).toContain("It was last shown signed out at 2026-11-01T18:00:00.000Z.");
    expect(out.value.page).toEqual({ openedAt: null, openCount: 0, signedOutAt: "2026-11-01T18:00:00.000Z" });
  });

  it("says who had it open last, when, and that no decision was recorded", async () => {
    const out = await verify({ openedAt: "2026-11-01T18:02:00.000Z", openedBy: "cezaraugusto", openCount: 2 });

    expect(out.hint).toContain("The approval page was last open by cezaraugusto at 2026-11-01T18:02:00.000Z (2 times), and no decision was recorded.");
    expect(out.hint).toContain("the click did not count");
  });

  it("says nothing about the page when the platform does not report it", async () => {
    const out = await verify();

    expect(out.status).toBe("approval-pending");
    expect(out.hint).not.toMatch(/approval page (was last open|open while signed in)/);
    expect(out.value.page).toBeUndefined();
  });
});

describe("extension_approvals status reads the page trace of a pending approval", () => {
  const saved: Record<string, string | undefined> = {};
  let tmp = "";

  beforeEach(() => {
    for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) saved[key] = process.env[key];

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-approval-trace-"));
    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_API_URL = API;
    process.env.EXTENSION_DEV_TOKEN = "env-token";
    delete process.env.EXTENSION_DEV_PROJECT;
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("tells a page nobody opened from one that was open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ status: "pending", used: false, fingerprint: "f".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", page: { openedAt: null, openCount: 0 } }),
          { status: 200 },
        ),
      ),
    );

    const out = JSON.parse(await handler({ action: "status", approvalId: FIREFOX }));

    expect(out.status).toBe("pending");
    expect(out.value.page).toEqual({ openedAt: null, openCount: 0 });
    expect(out.hint).toContain("Nobody has had the approval page open while signed in since it was asked for.");
  });
});
