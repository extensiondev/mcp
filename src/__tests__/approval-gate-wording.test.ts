import { describe, expect, it } from "vitest";

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
