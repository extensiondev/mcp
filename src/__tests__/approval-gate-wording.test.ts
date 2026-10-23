import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluateApproval, type ApprovalGateInput } from "../lib/approval-gate";

const API = "https://www.extension.dev";

const unreachable = (async () => {
  throw new Error("socket hang up");
}) as unknown as typeof fetch;

function answering(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as unknown as typeof fetch;
}

function input(over: Partial<ApprovalGateInput>): ApprovalGateInput {
  return {
    command: "extension_builds",
    action: "extension_settings.build",
    scope: { settingsDigest: "a".repeat(64) },
    description: "Change the build settings of acme/widget.",
    token: "tok_test",
    api: API,
    enabled: true,
    platformAsked: true,
    ...over,
  };
}

async function message(over: Partial<ApprovalGateInput>): Promise<string> {
  const gate = await evaluateApproval(input(over));
  if (!gate.blocked) throw new Error("the gate let the call through");

  return JSON.parse(gate.envelope).error.message as string;
}

describe("the approval gate describes an action by what it is, not as irreversible by default", () => {
  it("does not call a build settings change irreversible when the approval cannot be requested", async () => {
    expect(await message({ fetchImpl: unreachable })).not.toContain("irreversible");
  });

  it("does not call it irreversible when the platform creates no approval", async () => {
    expect(await message({ fetchImpl: answering(500, { message: "down" }) })).not.toContain("irreversible");
  });

  it("does not call it irreversible when the approval answer carries no id", async () => {
    expect(await message({ fetchImpl: answering(201, {}) })).not.toContain("irreversible");
  });

  it("does not call it irreversible when an approval cannot be verified", async () => {
    expect(await message({ approvalId: "apr_1", fetchImpl: unreachable })).not.toContain("irreversible");
    expect(await message({ approvalId: "apr_1", fetchImpl: answering(404, { message: "unknown" }) })).not.toContain("irreversible");
  });

  it("does not call it irreversible once an approval is created", async () => {
    const said = await message({ fetchImpl: answering(201, { approvalId: "apr_1", approvalUrl: `${API}/approve/apr_1` }) });

    expect(said).toContain("approvalId apr_1");
    expect(said).toContain("with the same arguments");
    expect(said).not.toContain("irreversible");
  });

  it("still calls an irreversible action irreversible on every path", async () => {
    expect(await message({ irreversible: true, fetchImpl: unreachable })).toContain("irreversible");
    expect(await message({ irreversible: true, approvalId: "apr_1", fetchImpl: unreachable })).toContain("irreversible");
    expect(await message({ irreversible: true, fetchImpl: answering(201, { approvalId: "apr_1" }) })).toContain("irreversible");
  });

  it("names the action the way the platform describes it once it writes the description", async () => {
    const gate = await evaluateApproval(
      input({
        fetchImpl: answering(201, {
          approvalId: "apr_1",
          approvalUrl: `${API}/approve/apr_1`,
          description: "Open a release pull request in acme/widget that bumps the extension's manifest by one patch version.",
        }),
      }),
    );
    const out = JSON.parse((gate as { envelope: string }).envelope);

    expect(out.value.description).toBe("Open a release pull request in acme/widget that bumps the extension's manifest by one patch version.");
    expect(out.error.message).toContain("Open a release pull request in acme/widget");
    expect(out.error.message).not.toContain("Change the build settings");
  });
});

describe("a submit approval repeats the platform's outcome sentence on every later call", () => {
  const PLATFORM_SAID = "Upload Rebeccat, build 1f948f5 to App Store Connect as a TestFlight draft (no App Review).";
  const AGENT_SAID = "Submit build 1f948f5 to safari for store review.";
  const token = `${Buffer.from(JSON.stringify({ u: "acme", p: "rebeccat" })).toString("base64url")}.sig`;
  const submit = (over: Partial<ApprovalGateInput>) =>
    input({
      command: "extension_submit",
      action: "extension_submit",
      scope: { browsers: ["safari"], buildSha: "1f948f5", channel: "stable" },
      description: AGENT_SAID,
      token,
      ...over,
    });
  let previousXdg: string | undefined;
  let isolated = "";

  beforeEach(() => {
    previousXdg = process.env.XDG_CONFIG_HOME;
    isolated = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-gate-words-"));
    process.env.XDG_CONFIG_HOME = isolated;
  });

  afterEach(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;

    fs.rmSync(isolated, { recursive: true, force: true });
  });

  it("asks with the platform's sentence and answers a pending or spent re-call with it, never this server's", async () => {
    const minted = await evaluateApproval(
      submit({
        fetchImpl: answering(201, { approvalId: "apr_safari", approvalUrl: `${API}/device/approve/apr_safari`, description: PLATFORM_SAID }),
      }),
    );
    const asked = JSON.parse((minted as { envelope: string }).envelope);

    expect(asked.error.message).toContain(PLATFORM_SAID);
    expect(asked.error.message).not.toContain("for store review");
    expect(asked.value.description).toBe(PLATFORM_SAID);

    const waiting = await evaluateApproval(
      submit({ approvalId: "apr_safari", fetchImpl: answering(200, { status: "pending", used: false }) }),
    );
    const pending = JSON.parse((waiting as { envelope: string }).envelope);

    expect(pending.status).toBe("approval-pending");
    expect(pending.hint).toContain(`Approval apr_safari has not been granted yet: ${PLATFORM_SAID}`);
    expect(pending.hint).not.toContain("for store review");

    const spent = await evaluateApproval(
      submit({ approvalId: "apr_safari", fetchImpl: answering(200, { status: "approved", used: true, fingerprint: asked.value.fingerprint, expiresAt: "2099-01-01T00:00:00.000Z" }) }),
    );
    const consumed = JSON.parse((spent as { envelope: string }).envelope);

    expect(consumed.error.name).toBe("ApprovalConsumed");
    expect(consumed.error.message).toContain(PLATFORM_SAID);
    expect(consumed.error.message).not.toContain("for store review");
  });

  it("keeps this server's sentence for an approval this machine did not mint", async () => {
    const waiting = await evaluateApproval(
      submit({ approvalId: "apr_elsewhere", fetchImpl: answering(200, { status: "pending", used: false }) }),
    );

    expect(JSON.parse((waiting as { envelope: string }).envelope).hint).toContain(`has not been granted yet: ${AGENT_SAID}`);
  });
});
