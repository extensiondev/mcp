import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler, schema } from "../tools/submit";
import { readSubmitOutcome } from "../lib/submit-outcome";
import { submitAnswer } from "./fixtures/platform-answers";

const API = "https://api.test";
const saved: Record<string, string | undefined> = {};
let tmp: string;

function stubSubmit(answer: unknown | (() => never), status = 200) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const href = String(url);

      if (href.endsWith("/api/cli/stores/submit")) {
        calls.push(href);
        if (typeof answer === "function") return (answer as () => never)();

        return new Response(
          typeof answer === "string" ? answer : JSON.stringify(answer),
          { status },
        );
      }

      throw new Error(`Unexpected fetch: ${href}`);
    }),
  );

  return calls;
}

async function submit(browsers: string[], extra: Record<string, unknown> = {}) {
  return JSON.parse(
    await handler({
      browsers,
      buildSha: "abc1234",
      dryRun: false,
      projectPath: tmp,
      ...extra,
    } as never),
  );
}

beforeEach(() => {
  for (const key of [
    "XDG_CONFIG_HOME",
    "EXTENSION_DEV_API_URL",
    "EXTENSION_DEV_TOKEN",
    "EXTENSION_DEV_APPROVAL_GATE",
  ]) {
    saved[key] = process.env[key];
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-submit-outcome-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  process.env.EXTENSION_DEV_TOKEN = "release-token";
  process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
});

afterEach(() => {
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension_submit says submitted only for stores the platform recorded", () => {
  it("says submitted when every store asked has a submission row", async () => {
    stubSubmit(submitAnswer(["chrome", "firefox"]));
    const out = await submit(["chrome", "firefox"]);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("submitted");
    expect(out.value.submittedStores).toEqual(["chrome", "firefox"]);
    expect(out.value.missingStores).toBeUndefined();
    expect(out.value.allowance.spent).toContain("This submission");
    expect(out.hint).toContain("chrome, firefox");
    expect(out.hint).toContain("pending");
  });

  it("names the store the platform did not record and how to submit only that one", async () => {
    stubSubmit(submitAnswer(["chrome"]));
    const out = await submit(["chrome", "firefox"]);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("submitted-partially");
    expect(out.value.submittedStores).toEqual(["chrome"]);
    expect(out.value.missingStores).toEqual(["firefox"]);
    expect(out.warnings[0]).toContain("NOT submitted: firefox");
    expect(out.hint).toContain("browsers limited to firefox");
    expect(out.hint).toContain("do not repeat chrome");
  });

  it.each([
    ["an empty list of submissions", submitAnswer([])],
    ["no list of submissions", { ok: true, message: "dispatched", buildId: "abc1234" }],
    ["a bare ok", { ok: true }],
    ["an empty object", {}],
    ["rows for other stores only", submitAnswer(["edge"])],
    ["a page of html", "<html>ok</html>"],
  ])("refuses to call %s a submission", async (_label, body) => {
    stubSubmit(body);
    const out = await submit(["chrome", "firefox"]);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("submit-unconfirmed");
    expect(out.error.message).toContain("is unknown");
    expect(out.hint).toContain("Do not submit again blind");
    expect(out.hint).toContain("extension_release_status");
    expect(JSON.stringify(out.value)).not.toContain("metered against");
  });

  it("never calls a 2xx that says ok false submitted", async () => {
    stubSubmit({ ok: false, message: "Store credentials are not healthy." });
    const out = await submit(["chrome"]);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("submit-refused");
    expect(out.error.message).toContain("not healthy");
    expect(out.value.allowance).toBeUndefined();
  });

  it("calls a request that got no answer unconfirmed, not failed", async () => {
    stubSubmit(() => {
      throw new Error("socket hang up");
    });

    const out = await submit(["chrome", "firefox"]);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("submit-unconfirmed");
    expect(out.error.message).toContain("no answer came back");
    expect(out.hint).toContain("Do not submit again blind");
  });

  it("keeps a dry run that got no answer a plain network failure", async () => {
    stubSubmit(() => {
      throw new Error("socket hang up");
    });

    const out = await submit(["chrome"], { dryRun: true });

    expect(out.status).toBe("network-failed");
  });

  it("says a store may already be submitted when the platform fails after accepting", async () => {
    stubSubmit({ message: "Internal error" }, 500);
    const out = await submit(["chrome", "firefox"]);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("submit-failed");
    expect(out.hint).toContain("may already be submitted");
    expect(out.hint).toContain("extension_release_status");
  });

  it("says a retryable refusal is safe to repeat, because the platform says nothing was dispatched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              retryable: true,
              code: "AUTHORITY_UNAVAILABLE",
              reason: "The project record could not be read.",
              message:
                "The project record could not be read. Nothing was dispatched or recorded; retry the same call in a few seconds.",
            }),
            { status: 503, headers: { "retry-after": "10" } },
          ),
      ),
    );

    const out = await submit(["chrome", "firefox"]);

    expect(out.status).toBe("submit-failed");
    expect(out.error.platformCode).toBe("AUTHORITY_UNAVAILABLE");
    expect(out.hint).not.toContain("may already be submitted");
    expect(out.hint).toContain("can be repeated as it is");
    expect(out.hint).toContain("after 10 seconds");
  });

  it("does not raise that alarm for a refusal the platform made before dispatching", async () => {
    stubSubmit({ message: "Unsupported store(s): opera" }, 400);
    const out = await submit(["chrome"]);

    expect(out.status).toBe("submit-failed");
    expect(out.hint ?? "").not.toContain("may already be submitted");
  });

  it("promises the partial and unconfirmed statuses in its description", () => {
    expect(schema.description).toContain("submitted-partially");
    expect(schema.description).toContain("submit-unconfirmed");
  });
});

describe("readSubmitOutcome", () => {
  it("matches stores by name, whatever the row order or case", () => {
    const body = submitAnswer(["firefox", "chrome"]);
    (body.submissions as Array<Record<string, unknown>>)[0]!.store = "Firefox";

    expect(readSubmitOutcome(body, ["chrome", "firefox"])).toEqual({
      state: "submitted",
      stores: ["chrome", "firefox"],
    });
  });

  it("does not let a truthy but non-literal ok through", () => {
    expect(
      readSubmitOutcome(submitAnswer(["chrome"], { ok: "true" }), ["chrome"]).state,
    ).toBe("unconfirmed");
  });
});
