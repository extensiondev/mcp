// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";
import { API_BASE } from "../lib/common-schema";
import { envelope, type ErrorCode } from "../lib/envelope";
import fs from "node:fs";
import path from "node:path";
import { resolveToken } from "../lib/publish";
import { PROJECT_TOKEN_INPUT, noStoredLoginHint } from "../lib/credentials";
import { resolveApiBase, safeApiBase } from "../lib/login-flow";
import { identityHeaders } from "../lib/session-identity";
import { STORE_MD_FILENAME, parseStoreMd } from "../lib/store-md";
import { platformHoldEnvelope, sawPlatformHold } from "../lib/platform-hold";
import {
  approvalGateEnabled,
  evaluateApproval,
  platformRequiresApproval,
  requestApprovalAfterRefusal,
} from "../lib/approval-gate";
import { spendNarration } from "../lib/allowance";
import { readSubmitOutcome } from "../lib/submit-outcome";
import {
  consoleProjectUrl,
  fetchRegistryJson,
  parseChannels,
  registryFileUrl,
  loginProjectRef,
} from "../lib/registry";

export function storeMdWarnings(browsers: string[], cwd: string): string[] {
  const wantsFirefox = browsers.includes("firefox");
  const wantsEdge = browsers.includes("edge");
  if (!wantsFirefox && !wantsEdge) return [];

  const filePath = path.join(cwd, STORE_MD_FILENAME);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [
      `No ${STORE_MD_FILENAME} found in the current working directory. Platform submissions read ${STORE_MD_FILENAME} from the project's source repository at the built commit, so this may not apply here; make sure ${STORE_MD_FILENAME} exists there for Firefox reviewer notes and Edge certification notes. See the extension-dev skill's store-md reference.`,
    ];
  }

  const data = parseStoreMd(content);
  const warnings: string[] = [];
  if (wantsFirefox && !data.firefox?.approvalNotes) {
    warnings.push(
      `${STORE_MD_FILENAME} has no Firefox reviewer notes; AMO reviews go faster with test credentials and steps.`,
    );
  }
  if (wantsEdge && !data.edge?.certificationNotes) {
    warnings.push(
      `${STORE_MD_FILENAME} has no Edge certification notes; the certification team gets no testing guidance.`,
    );
  }
  if (warnings.length === 0) {
    warnings.push(
      `The notes above were read from ${filePath}. The submission reads ${STORE_MD_FILENAME} from the project's source repository at the built commit, so an uncommitted or unpushed edit here does not travel with it.`,
    );
  }
  return warnings;
}

export interface SubmitToolArgs {
  project?: string;
  browsers: string[];
  buildSha: string;
  channel?: string;
  version?: string;
  dryRun?: boolean;
  projectPath?: string;
  approvalId?: string;
  api?: string;
}

export const schema = {
  name: "extension_submit",
  description:
    "Submit a built extension for store REVIEW through extension.dev, which holds your store credentials and dispatches from your project's mirror CI: the Chrome Web Store, Firefox AMO, Edge Add-ons and the App Store (Safari). This is store review only. It does not push a build to the extension.dev platform, and it does not make a shareable link: that is extension_publish, which is what \"deploy\" or \"ship\" an extension almost always means. Reach for this only when the ask is explicitly a store submission. It defaults to a dry run that dispatches nothing: the platform verifies auth, project, build and store workflow, and this tool adds each store's credential-health verdict. Trust those per-store rows over the platform's bare preflight line, which does not check store health. Pass dryRun:false to actually submit, which is irreversible and enters store review. A real submission answers 'submitted' only when the platform recorded a submission for every store asked; 'submitted-partially' names the stores it did not record, which are the only ones to submit again; 'submit-unconfirmed' means no usable answer came back, so read extension_release_status before submitting again, because a second call submits a second time. The project comes from your token (extension_auth or EXTENSION_DEV_TOKEN; tokens live at most 7 days, so CI must re-mint from the console's Access tokens page); with several logins stored, `project` picks which one. Store credentials are never arguments, and no local file is uploaded. Call extension_release_status for valid shas, and, after a real submission, for the recorded outcome and review state.",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: PROJECT_TOKEN_INPUT,
      browsers: {
        type: "array",
        items: {
          type: "string",
          enum: ["chrome", "firefox", "edge", "safari"],
        },
        description: "Stores to submit to.",
      },
      buildSha: {
        type: "string",
        description:
          "The built commit SHA to submit. It needs a completed build in the project's build index; an unknown sha is rejected.",
      },
      channel: {
        type: "string",
        description: "Release channel to submit from (default stable).",
      },
      version: {
        type: "string",
        description: "Version label for the submission record (optional).",
      },
      dryRun: {
        type: "boolean",
        default: true,
        description:
          "Preflight only. Pass false to actually dispatch (irreversible, enters store review).",
      },
      projectPath: {
        type: "string",
        description:
          "Path to the extension project root, read only for the local STORE.md advisory check. Nothing local is uploaded; without it the check falls back to the server's working directory.",
      },
      approvalId: {
        type: "string",
        description:
          "The approval handle returned by a prior approval-required response for a real submission. A real submission (dryRun:false) is irreversible and needs a human approval when the platform's approval gate is on: call once without this to get an approval id and URL, have a human approve at extension.dev, then call again with the same id. A dry run never needs it.",
      },
      api: API_BASE,
    },
    required: ["browsers", "buildSha"],
  },
};

function fail(
  name: string,
  message: string,
  status: string,
  code: ErrorCode,
): string {
  return envelope({
    ok: false,
    command: "extension_submit",
    status,
    error: { code, name, message },
  });
}

export async function handler(args: SubmitToolArgs): Promise<string> {
  const token = resolveToken({ project: args.project });
  if (!token && args.project) {
    return fail("SubmitAuthError", noStoredLoginHint(args.project), "auth-required", "E_AUTH_REQUIRED");
  }
  if (!token) {
    return fail(
      "SubmitAuthError",
      "No token. Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard under project settings -> Access tokens; tokens live at most 7 days, so CI must re-mint before expiry).",
      "auth-required",
      "E_AUTH_REQUIRED",
    );
  }

  const browsers = (Array.isArray(args.browsers) ? args.browsers : [])
    .map((b) => String(b).trim().toLowerCase())
    .filter(Boolean);
  if (browsers.length === 0) {
    return fail(
      "SubmitInputError",
      'browsers is required (e.g. ["chrome","firefox","edge","safari"]).',
      "bad-request",
      "E_BAD_REQUEST",
    );
  }
  const buildSha = String(args.buildSha || "").trim();
  if (!buildSha) {
    return fail(
      "SubmitInputError",
      "buildSha is required (the built commit to submit).",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  const apiCheck = safeApiBase(resolveApiBase(args.api), args.api);
  if (!apiCheck.ok) {
    return fail(
      "SubmitConfigError",
      apiCheck.message,
      "bad-config",
      "E_CONFIG",
    );
  }
  const url = `${apiCheck.base}/api/cli/stores/submit`;

  const dryRun = args.dryRun !== false;
  const channel = args.channel ? String(args.channel).trim() : "stable";
  const body: Record<string, unknown> = { browsers, buildSha, dryRun };
  if (args.channel) body.channel = String(args.channel).trim();
  if (args.version) body.version = String(args.version).trim();

  const gateInput = {
    command: "extension_submit",
    action: "extension_submit",
    scope: {
      browsers: [...browsers].sort(),
      buildSha: buildSha.toLowerCase(),
      channel,
    },
    description: `Submit build ${buildSha} to ${browsers.join(", ")} for store review.`,
    approvalId: args.approvalId,
    token,
    api: args.api,
  };

  if (!dryRun) {
    const gate = await evaluateApproval({
      ...gateInput,
      enabled: approvalGateEnabled(true),
    });
    if (gate.blocked) return gate.envelope;
    const approvalId = gate.approvalId ?? (args.approvalId ? String(args.approvalId).trim() : "");
    if (approvalId) body.approvalId = approvalId;
  }

  const statusRead = `extension_release_status (include: ['stores']${
    args.project ? `, project: '${args.project}'` : ""
  })`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...identityHeaders("extension_submit"),
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    if (!dryRun) {
      /* @invariant A real submission that got no answer is unconfirmed, never
       * failed. The request left this machine, and the platform dispatches a
       * store's workflow before it answers, so "could not reach" would invite
       * the retry that submits a second time. */
      return envelope({
        ok: false,
        command: "extension_submit",
        status: "submit-unconfirmed",
        error: {
          code: "E_NETWORK",
          name: "SubmitUnconfirmed",
          message: `The submission request for ${browsers.join(", ")} left this machine and no answer came back (${err?.message || err}), so whether any store was submitted is unknown.`,
        },
        value: { browsers, buildSha, channel },
        hint: `Do not submit again blind: a store that was dispatched would be submitted twice. Read ${statusRead} first and submit only the stores with no new submission.`,
      });
    }
    return fail(
      "SubmitNetworkError",
      `Could not reach ${url}: ${err?.message || err}`,
      "network-failed",
      "E_NETWORK",
    );
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    if (sawPlatformHold(res, data)) {
      return platformHoldEnvelope({
        command: "extension_submit",
        name: "SubmitHeld",
        body: data,
        api: args.api,
        value: { browsers, buildSha, dryRun },
      });
    }
    if (!dryRun && !args.approvalId && platformRequiresApproval(res, data)) {
      return requestApprovalAfterRefusal(gateInput);
    }
    /* @invariant A server error on a real submission may come after a
     * dispatch. The platform dispatches each store's workflow and only then
     * records it and moves to the next store, so a 5xx can follow one or more
     * stores already submitted. The failure is reported as a failure and says
     * that, because the natural next move is to submit again. The exception
     * is the platform's own `retryable: true`, which it sends only before any
     * dispatch and which says so; that one is safe to repeat and is told as
     * such, with the wait it asked for. */
    const saidNothingDispatched = data?.retryable === true;
    const maybeDispatched =
      !dryRun && res.status >= 500 && !saidNothingDispatched;
    return envelope({
      ok: false,
      command: "extension_submit",
      status: "submit-failed",
      error: {
        code: "E_PLATFORM",
        name: "SubmitError",
        message: `${dryRun ? "preflight" : "submit"} failed (${res.status}): ${data?.message || text || "unknown error"}`,
        ...(typeof data?.code === "string" ? { platformCode: data.code } : {}),
      },
      ...(maybeDispatched
        ? {
            hint: `The platform failed after the request was accepted, and it dispatches each store before it records it, so ${
              browsers.length === 1 ? browsers[0] : "one or more of " + browsers.join(", ")
            } may already be submitted. Read ${statusRead} before submitting again.`,
          }
        : saidNothingDispatched
          ? {
              hint: `The platform says nothing was dispatched or recorded and that this call can be repeated as it is${
                res.headers.get("retry-after")
                  ? `, after ${res.headers.get("retry-after")} seconds`
                  : ""
              }.`,
            }
          : {}),
    });
  }

  const warnings: (string | null | undefined | false)[] = Array.isArray(
    data?.warnings,
  )
    ? [...data.warnings]
    : [];
  warnings.push(
    ...storeMdWarnings(
      browsers,
      String(args.projectPath || "").trim() || process.cwd(),
    ),
  );

  const result: Record<string, unknown> = { mode: "platform", dryRun, ...data };
  delete result.ok;
  delete result.warnings;
  delete result.message;
  const platformOk = data?.ok !== false;
  let ok = platformOk;
  let message = typeof data?.message === "string" ? data.message : "";
  let channelNote: string | null = null;
  let statusNote: string | null = null;

  if (dryRun) {
    const ref = loginProjectRef(args.project);
    const consoleStoresUrl = consoleProjectUrl(
      ref,
      ConsoleProjectPage.submissions,
      args.api,
    );
    const storeModeNote = `Store publish mode (draft / skip-publish / live) is not readable with the CLI token, so it cannot be verified from here; check per-store settings at ${consoleStoresUrl}.`;

    let health: Record<string, { ok?: boolean; message?: string }> | null = null;
    let healthUnreadable: string | null = null;
    let channelRows: ReturnType<typeof parseChannels> | null = null;
    if (ref) {
      const [healthRes, channelsRes] = await Promise.all([
        fetchRegistryJson(registryFileUrl(ref, "stores/health.json"), fetch, {
          ref,
          api: args.api,
        }),
        fetchRegistryJson(registryFileUrl(ref, "channels.json"), fetch, {
          ref,
          api: args.api,
        }),
      ]);
      if (healthRes.ok) {
        const stores = (healthRes.json as { stores?: unknown })?.stores;
        health =
          stores && typeof stores === "object"
            ? (stores as Record<string, { ok?: boolean; message?: string }>)
            : null;
        if (!health) healthUnreadable = "stores/health.json had no stores map";
      } else {
        healthUnreadable = healthRes.message;
      }
      if (channelsRes.ok) channelRows = parseChannels(channelsRes.json);
    } else {
      healthUnreadable =
        "no stored workspace/project to look up (run extension_auth)";
    }

    const preflight = browsers.map((browser) => {
      if (!health) {
        return {
          browser,
          ok: false,
          configured: "unknown" as const,
          publishMode: "unknown",
          reason: `Store configuration could not be read (${healthUnreadable}); verify the ${browser} store in the console before submitting.`,
        };
      }
      const row = health[browser];
      if (!row) {
        return {
          browser,
          ok: false,
          configured: false,
          publishMode: "unknown",
          reason: `No ${browser} store is configured on this project; a real submission for ${browser} would fail. Configure it at ${consoleStoresUrl}.`,
        };
      }
      if (row.ok !== true) {
        return {
          browser,
          ok: false,
          configured: false,
          publishMode: "unknown",
          reason:
            String(row.message || "").trim() ||
            `The ${browser} store failed its last credential health check.`,
        };
      }
      return {
        browser,
        ok: true,
        configured: true as const,
        publishMode: "unknown",
      };
    });

    const actionable = preflight.filter((p) => p.ok).map((p) => p.browser);
    const blocked = preflight.filter(
      (p) => !p.ok && p.configured !== "unknown",
    );
    const unverified = preflight.filter((p) => p.configured === "unknown");

    const channelDefaulted = !String(args.channel || "").trim();
    const resolvedChannel =
      String(data?.channel || "").trim() ||
      (channelDefaulted ? "stable" : String(args.channel).trim());
    if (channelRows) {
      const exists = channelRows.some(
        (r) =>
          r.channel === resolvedChannel ||
          r.channel.endsWith(`-${resolvedChannel}`),
      );
      if (!exists) {
        warnings.push(
          `Channel "${resolvedChannel}"${channelDefaulted ? " (the default)" : ""} does not exist in this project's channels.json (existing: ${
            channelRows.map((r) => r.channel).join(", ") || "none"
          }), so a real submission from it has no promoted build to serve. Promote a build there first (extension_release_promote) or pass an existing channel.`,
        );
      }
    }

    const summaryParts: string[] = [];
    if (!platformOk) {
      summaryParts.push(
        `Preflight FAILED on the platform${
          typeof data?.message === "string" && data.message
            ? `: ${data.message}`
            : ""
        }. The per-store rows below are advisory and do not override that verdict.`,
      );
    }
    if (actionable.length > 0) {
      summaryParts.push(
        platformOk
          ? `Preflight passed for ${actionable.join(", ")}: the platform verified auth, the project, build ${
              data?.buildId ?? buildSha
            }, and the store workflow, and the store credentials passed their last health check.`
          : `${actionable.join(", ")}: the store credentials passed their last health check, but the platform failure above still blocks submission.`,
      );
    }
    for (const p of blocked) {
      summaryParts.push(`${p.browser}: NOT actionable - ${p.reason}`);
    }
    for (const p of unverified) {
      summaryParts.push(
        `${p.browser}: cannot be verified - ${p.reason}${
          platformOk
            ? ` The platform preflight itself passed, so this is advisory only.`
            : ""
        }`,
      );
    }
    summaryParts.push(storeModeNote);

    ok = platformOk && (blocked.length === 0 || actionable.length > 0);
    result.preflight = preflight;
    result.channel = resolvedChannel;
    result.channelDefaulted = channelDefaulted;
    if (channelDefaulted) {
      channelNote = `channel: ${resolvedChannel} (default)`;
    }
    result.consoleStoresUrl = consoleStoresUrl;
    if (typeof data?.message === "string") result.platformMessage = data.message;
    message = summaryParts.join(" ");
  }

  if (!dryRun) {
    const outcome = readSubmitOutcome(data, browsers);
    if (outcome.state === "unconfirmed") {
      return envelope({
        ok: false,
        command: "extension_submit",
        status: "submit-unconfirmed",
        error: {
          code: "E_PLATFORM",
          name: "SubmitUnconfirmed",
          message: `The platform answered ${res.status} but ${outcome.why}, so whether ${browsers.join(", ")} ${browsers.length === 1 ? "was" : "were"} submitted is unknown.`,
        },
        value: { browsers, buildSha, channel, platform: data },
        hint: `Do not submit again blind: a store that was dispatched would be submitted twice. Read ${statusRead} first and submit only the stores with no new submission.`,
      });
    }
    if (outcome.state === "refused") {
      return envelope({
        ok: false,
        command: "extension_submit",
        status: "submit-refused",
        error: {
          code: "E_PLATFORM",
          name: "SubmitRefused",
          message: message || "The platform refused the submission.",
        },
        value: result,
        warnings,
      });
    }
    statusNote = `Track this submission with ${statusRead}: it reads the recorded outcome, per-store credential health, and review state from the public registry.`;
    result.submittedStores = outcome.stores;
    result.allowance = spendNarration({
      what: "This submission",
      body: data,
      api: args.api,
    });
    if (outcome.state === "partial") {
      result.missingStores = outcome.missing;
      return envelope({
        ok: true,
        command: "extension_submit",
        status: "submitted-partially",
        value: result,
        hint: `The platform recorded a submission for ${outcome.stores.join(", ")} and none for ${outcome.missing.join(", ")}. Submit again with browsers limited to ${outcome.missing.join(", ")}; do not repeat ${outcome.stores.join(", ")}.`,
        warnings: [
          `NOT submitted: ${outcome.missing.join(", ")}. The platform's answer has no submission row for ${outcome.missing.length === 1 ? "it" : "them"}.`,
          ...warnings,
          channelNote,
          statusNote,
        ],
      });
    }
    return envelope({
      ok: true,
      command: "extension_submit",
      status: "submitted",
      value: result,
      hint:
        message ||
        `The platform dispatched the store workflow for ${outcome.stores.join(", ")} and recorded each submission as pending. A store's own review comes after that and is not part of this answer.`,
      warnings: [...warnings, channelNote, statusNote],
    });
  }

  return envelope({
    ok,
    command: "extension_submit",
    status: "preflight",
    value: result,
    hint: message,
    warnings: [...warnings, channelNote, statusNote],
  });
}
