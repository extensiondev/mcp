// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pendingApproval } from "../lib/approval-outcome";
import { writeCredentials } from "../lib/credentials";
import { envelope } from "../lib/envelope";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";

const API = "http://localhost:3100";
const APPROVAL_ID = "apr_oSA5_UlubgsXJACljtVfT8RskyWvv2SN";
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const saved: Record<string, string | undefined> = {};
let tmp: string;
let prevFetch: typeof fetch;
let polls: string[];
let grantAfterPolls: number;
let calls: Array<Record<string, unknown>>;

function pending(): string {
  return pendingApproval({
    command: "extension_submit",
    approvalId: APPROVAL_ID,
    message: `Approval ${APPROVAL_ID} has not been granted yet: Submit build e4b8976.`,
    undone: "Nothing was executed.",
    api: API,
    retryAfterSeconds: 10,
  });
}

function fakeSubmit(): ToolModule {
  return {
    schema: {
      name: "extension_submit",
      description: "fake",
      inputSchema: {
        type: "object",
        properties: {
          approvalId: { type: "string" },
          waitSeconds: { type: "number" },
          project: { type: "string" },
          api: { type: "string" },
          dryRun: { type: "boolean" },
        },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      calls.push(args);

      return polls.length >= grantAfterPolls
        ? envelope({ ok: true, command: "extension_submit", status: "submitted", value: { browsers: ["chrome"] } })
        : pending();
    },
  };
}

async function call(args: Record<string, unknown>) {
  const dispatch = createToolDispatcher({ tools: [fakeSubmit()], options: { features: ["local", "platform"], noShip: false } });
  const frame = await dispatch({ name: "extension_submit", arguments: { api: API, dryRun: false, ...args } });

  return JSON.parse(frame.content[0]?.text ?? "{}");
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-approval-wait-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  writeCredentials({
    version: 1,
    token: "rebeccat.sig",
    workspaceSlug: "cezaraugusto",
    projectSlug: "rebeccat",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: API,
  });

  polls = [];
  calls = [];
  grantAfterPolls = 3;
  prevFetch = global.fetch;
  global.fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const target = String(url);

    if (!target.endsWith(`/api/cli/approvals/${APPROVAL_ID}`)) throw new Error(`unexpected request ${target}`);

    polls.push(String(headers.authorization ?? ""));
    const status = polls.length >= grantAfterPolls ? "approved" : "pending";

    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status }) } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = prevFetch;

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ledger 254: an approval still waiting is waited for inside a call that names waitSeconds", () => {
  it("polls the approval every retryAfterSeconds and, once granted, runs the act in the same call", async () => {
    const out = await call({ approvalId: APPROVAL_ID, waitSeconds: 300 });

    expect(out.status).toBe("submitted");
    expect(polls).toEqual(["Bearer rebeccat.sig", "Bearer rebeccat.sig", "Bearer rebeccat.sig"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.waitSeconds).toBe(270);
    expect(out.value.approvalWaitedSeconds).toBe(30);
    expect(out.hint).toContain("waited 30 s for the approval, then went on once it was decided");
  });

  it("answers approval-pending only when the bound passes, saying how long it waited", async () => {
    grantAfterPolls = 99;

    const out = await call({ approvalId: APPROVAL_ID, waitSeconds: 45 });

    expect(out.status).toBe("approval-pending");
    expect(calls).toHaveLength(1);
    expect(polls).toHaveLength(5);
    expect(out.value.approvalWaitedSeconds).toBe(45);
    expect(out.hint).toContain("waited 45 s for the approval, which nobody has decided yet");
  });

  it("answers at once, polling nothing, when the call names no waitSeconds", async () => {
    const out = await call({ approvalId: APPROVAL_ID });

    expect(out.status).toBe("approval-pending");
    expect(calls).toHaveLength(1);
    expect(polls).toEqual([]);
    expect(out.value.approvalWaitedSeconds).toBeUndefined();
  });

  it("re-runs the call at once when the approval stops reading pending, so a decline answers its own refusal", async () => {
    let declined = false;
    global.fetch = (async () => {
      polls.push("poll");
      declined = true;

      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: "denied" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const tool = fakeSubmit();
    const handler = tool.handler;

    tool.handler = async (args) => {
      if (!declined) return handler(args);

      calls.push(args);

      return envelope({ ok: false, command: "extension_submit", status: "approval-declined", error: { code: "E_APPROVAL_REJECTED", message: "declined" } });
    };

    const dispatch = createToolDispatcher({ tools: [tool], options: { features: ["local", "platform"], noShip: false } });
    const frame = await dispatch({ name: "extension_submit", arguments: { api: API, dryRun: false, approvalId: APPROVAL_ID, waitSeconds: 300 } });
    const out = JSON.parse(frame.content[0]?.text ?? "{}");

    expect(out.status).toBe("approval-declined");
    expect(polls).toEqual(["poll"]);
    expect(calls).toHaveLength(2);
  });
});
