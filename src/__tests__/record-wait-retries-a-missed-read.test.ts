// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLATFORM_READ_TIMEOUT_MS } from "../lib/platform-fetch";
import { attachTrack } from "../lib/track-url";
import { handler as submit } from "../tools/submit";
import { API, useProjectRoutes } from "./fixtures/project-routes";

const SUBMISSIONS = "/api/cli/stores/submissions";
const AMO_REASON =
  'HTTP 400 Bad Request, POST https://addons.mozilla.org/api/v5/addons/addon/rebeccat@extension.dev/versions/ {"license":["This field, or custom_license, is required for listed versions."]}';

function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
}

async function settled(args: Record<string, unknown>, bounds: number): Promise<Record<string, any>> {
  const pending = submit(args);
  const got: { answer: string | null } = { answer: null };
  void pending.then((text) => {
    got.answer = text;
  });

  for (let i = 0; i < bounds && got.answer === null; i += 1) await vi.advanceTimersByTimeAsync(PLATFORM_READ_TIMEOUT_MS);

  if (got.answer === null) throw new Error(`the call did not answer within ${bounds} read bounds`);

  return JSON.parse(attachTrack("extension_submit", args, got.answer));
}

describe("ledger 256: a record read the platform does not answer is a miss the wait retries, not the end of the wait", () => {
  const platform = useProjectRoutes("extdev-record-wait-");
  let hung = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hung = 0;
    platform.login();
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.routes["POST /api/cli/stores/submit"] = () => ({ body: { ok: true, submissions: [{ id: "sub_ff", store: "firefox", status: "pending" }] } });

    const routed = global.fetch;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (new URL(String(url)).pathname === SUBMISSIONS && hung > 0) {
        hung -= 1;

        return hangUntilAborted(init);
      }

      return routed(url, init);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers submit-failed when the record reads failed after one 15 s read timeout inside the bound", async () => {
    if (process.platform === "win32") return;

    hung = 1;
    let reads = 0;

    platform.routes[`GET ${SUBMISSIONS}`] = () => {
      reads += 1;

      return { body: { submissions: [{ id: "sub_ff", store: "firefox", status: "failed", failureReason: AMO_REASON }] } };
    };

    const out = await settled({ browsers: ["firefox"], buildSha: "6d9e10c", dryRun: false, waitSeconds: 300, api: API }, 3);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("submit-failed");
    expect(reads).toBe(1);
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "failed", readMisses: 1, waitedSeconds: 5 });
    expect(out.value.outcome.readProblem).toBeUndefined();
    expect(out.value.nextStep.kind).toBe("resubmit");
    expect(out.value.nextStep.say).toContain("required for listed versions");
    expect(out.value.nextStep.url).toMatch(/\/submissions\//);
    expect(out.value.links[0]).toMatchObject({ kind: "submission", url: expect.stringMatching(/\/submissions\/firefox\//), made: true });
    expect(JSON.stringify(out)).not.toMatch(/extension-user-land-dev|\/actions\/runs\//);
  });

  it("answers submit-dispatched with readProblem naming the misses only when the whole bound was spent on reads the platform did not answer", async () => {
    if (process.platform === "win32") return;

    hung = 99;
    const out = await settled({ browsers: ["firefox"], buildSha: "6d9e10c", dryRun: false, waitSeconds: 20, api: API }, 8);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("submit-dispatched");
    expect(hung).toBe(94);
    expect(out.value.outcome).toMatchObject({ recorded: false, waitedSeconds: 20, readMisses: 5 });
    expect(out.value.outcome.readProblem).toBe(
      `could not reach ${API}${SUBMISSIONS}: the platform did not answer within 15 s; 5 reads of the record missed over 20 s`,
    );

    expect(out.hint).toContain("its record has not confirmed the result yet");
    expect(out.value.trackUrl).toMatch(/^https?:\/\//);
    expect(JSON.stringify(out)).not.toMatch(/extension-user-land-dev|\/actions\/runs\//);
  });
});
