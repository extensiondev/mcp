// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { API_BASE } from "../lib/common-schema";
import { resolveCredential } from "../lib/credential-source";
import { envelope, type ErrorCode } from "../lib/envelope";
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
import { approvalRoundTrip } from "../lib/approval-outcome";
import { readSubmitOutcome } from "../lib/submit-outcome";
import {
  consoleProjectUrl,
  fetchRegistryJson,
  parseChannels,
  registryFileUrl,
  channelsShapeProblem,
} from "../lib/registry";
import { cancelSubmission, preflight as readPreflight, raiseRollout } from "./store-acts";
import {
  NOT_CONNECTED_CODES,
  chromeItemUrl,
  connectSentences,
  failedCheckSentence,
  fallbackConnectUrl,
  storeSettingsUrl,
  withReviewPromise,
  withoutSecretNames,
} from "../lib/store-connection";
import { syncListing } from "./store-listing";

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
  action?: string;
  store?: string;
  submissionId?: string;
  deployPercentage?: unknown;
  project?: string;
  browsers?: string[];
  buildSha?: string;
  channel?: string;
  version?: string;
  dryRun?: boolean;
  projectPath?: string;
  screenshots?: unknown;
  approvalId?: string;
  api?: string;
}

export const schema = {
  name: "extension_submit",
  description:
    "Submit a built extension for store REVIEW through extension.dev, which holds your store credentials and runs the store upload on the platform: the Chrome Web Store, Firefox AMO, Edge Add-ons and the App Store (Safari). This is the store path only. It does not push a build to the extension.dev platform, and it does not make a shareable link: that is extension_publish, which is what \"deploy\", \"ship\" or \"share\" an extension almost always means. Reach for this when the ask is a store, or a signed Firefox build for testers. Submissions default to the least public outcome each store's API offers, unless the project's store settings say otherwise. Through this tool, Chrome and Edge upload a draft that is not published and does not enter review, even for an item that is already published; publish it from the store dashboard, or save a publishing mode in the console. Firefox uploads to the unlisted channel whenever the project has no saved release channel, never a channel inferred from AMO's current listing, and a saved channel is used as is. AMO is read only as a guard: an add-on AMO already lists, with no saved channel, is refused before upload with the instruction to save a release channel in the project's store settings, because an unlisted upload of a listed add-on burns the version number, and the refusal holds while AMO cannot be read. Safari uploads to App Store Connect and stops at the TestFlight draft unless this call asks for Apple review. AMO signs an unlisted version for self distribution with no public listing. No store's API sets listing visibility: Chrome's Public, Unlisted or Private setting and its trusted testers live in the Chrome Web Store dashboard, and Edge's Public or Hidden setting lives in Partner Center. A store that only uploaded is recorded as \"Uploaded, not public\", never as live. It defaults to a dry run that dispatches nothing: the platform verifies the token and project, finds the store workflow, reads the build from its index when that index is readable, reads store health itself and adds a Safari plan verdict; this tool re-reads the per-store health rows beside it. The dry run does not run the owner gate, the approval, the build quota, the dispatch pause or the submission-mode check, which the real run does first. Pass dryRun:false to actually submit, which is irreversible: it needs a token issued by a workspace owner and a workspace owner's approval of that exact submission, every time, and it dispatches the store workflow; a Chrome or Edge store with no saved submission mode is uploaded as a draft (absent_mode: safe) and does not enter review. A real submission answers 'submitted' only when the platform recorded a submission for every store asked; 'submitted-partially' names the stores it did not record, which are the only ones to submit again; 'submit-unconfirmed' means no usable answer came back, so read extension_release_status before submitting again, because a second call submits a second time. The project comes from your token (extension_auth or EXTENSION_DEV_TOKEN; tokens live at most 7 days, so CI must re-mint from the console's Access tokens page); with several logins stored, `project` picks which one. action:'preflight' reads each store's readiness for browsers (the failing checks with what to fix, the warnings, never a secret value or a secret's name) and writes nothing; with projectPath it also says, per store, which failing listing checks the local STORE.md and the built icons already cover. For Chrome it also reads the store connection: with no Chrome Web Store account connected it answers status 'store-not-connected' with value.connectUrl, value.trackUrl (the console store settings page) and, in hint, the two sentences to say to the person; a connection that failed its last check answers 'store-connection-failed' with the reason; a healthy connection with no store item says the first submission creates the item, and one with an item answers value.itemUrl, the item's dashboard link. A real submission's approval-required answer carries value.expiresAt and says that nothing goes to review until the person publishes. action:'sync-listing' fills the extension.dev store listing for browsers from the project's STORE.md (title, summary, description, category, support email, privacy policy URL, single purpose, permission justifications, reviewer, release and certification notes), the 128 px icon in the built dist/<browser>, and optional screenshots (PNG paths inside projectPath, for example from extension_screenshot); it needs projectPath, a workspace owner approves each store's exact change first (the first call answers approval-required with the approval URL and the change as the platform computed it, a second call with browsers:[store] and that approvalId writes it once), and it answers what changed and what the listing still lacks. action:'cancel' withdraws a submission from review (store, default chrome, and submissionId from extension_release_status), and action:'rollout' raises the Chrome staged rollout to deployPercentage, which Chrome does not let be lowered again; both need a workspace owner's approval of the exact act, so the first call answers approval-required with the approval URL, or refuses with the reason before anyone is asked. Store credentials are never arguments, and no local file is uploaded. Call extension_release_status for valid shas, and, after a real submission, for the recorded outcome and review state.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["submit", "preflight", "sync-listing", "cancel", "rollout"],
        default: "submit",
        description:
          "submit (the default) sends a build for store review; preflight reads each store's readiness and writes nothing; sync-listing fills the store listing from STORE.md and the built icons with an owner's approval; cancel withdraws a submission from review; rollout raises the Chrome staged rollout.",
      },
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
          "Path to the extension project root. A submit and a preflight read it only for the local STORE.md advisory, and nothing local is uploaded; without it a submit's check falls back to the server's working directory. sync-listing requires it and sends the listing text parsed from its STORE.md, the 128 px icon from its built dist and the screenshots named, nothing else.",
      },
      approvalId: {
        type: "string",
        description:
          "The approval handle returned by a prior approval-required response for a real submission. A real submission (dryRun:false) is irreversible and needs a workspace owner's approval every time: call once without this to get an approval id and URL, have a human approve at extension.dev, then call again with the same id. A dry run never needs it.",
      },
      screenshots: {
        type: "array",
        items: { type: "string" },
        description: "With sync-listing, up to 5 PNG screenshots inside projectPath (for example written by extension_screenshot) to set as the listing's screenshots. The Chrome Web Store takes 1280x800 or 640x400.",
      },
      api: API_BASE,
      store: {
        type: "string",
        enum: ["chrome", "firefox", "edge", "safari"],
        description: "With cancel or rollout, the store (default chrome, the one store that supports both).",
      },
      submissionId: {
        type: "string",
        description: "With cancel, the platform's id of the submission to withdraw, from extension_release_status include:['stores'].",
      },
      deployPercentage: {
        type: "number",
        description: "With rollout, the share of users to raise the staged rollout to: a whole number from 1 to 100, above the current one.",
      },
    },
    required: [],
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
  return withoutSecretNames(await answer(args));
}

const DRAFT_STORES = new Set(["chrome", "edge"]);

function chromeItemOf(data: any): string {
  const rows = [
    ...(Array.isArray(data?.submissions) ? data.submissions : []),
    data?.stores?.chrome?.connection,
    data?.connection,
    data,
  ].filter((row) => row && typeof row === "object" && (!row.store || row.store === "chrome"));

  for (const row of rows) {
    const url = chromeItemUrl(row as Record<string, unknown>);
    if (url) return url;
  }

  return "";
}

async function answer(args: SubmitToolArgs): Promise<string> {
  if (args.action === "preflight") return readPreflight(args);
  if (args.action === "cancel") return cancelSubmission(args);
  if (args.action === "rollout") return raiseRollout(args);
  if (args.action === "sync-listing") return withReviewPromise(await syncListing(args));

  if (args.action !== undefined && args.action !== "submit") {
    return fail("SubmitInputError", `action must be submit, preflight, sync-listing, cancel or rollout; got "${args.action}". Nothing was sent.`, "bad-request", "E_BAD_REQUEST");
  }

  const credential = resolveCredential({ project: args.project, api: args.api });
  const token = credential.token;

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
    refusedStatus: "submit-failed",
    irreversible: true,
  };

  const promisesNoReview = browsers.every((browser) => DRAFT_STORES.has(browser));
  const asked = (out: string) => (promisesNoReview ? withReviewPromise(out) : out);

  if (!dryRun) {
    const gate = await evaluateApproval({
      ...gateInput,
      enabled: approvalGateEnabled(true),
    });
    if (gate.blocked) return asked(gate.envelope);

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

    const refusedCode = typeof data?.code === "string" ? data.code : "";

    if (NOT_CONNECTED_CODES.has(refusedCode) || (typeof data?.connectUrl === "string" && data.connectUrl.trim())) {
      const settingsUrl = storeSettingsUrl(credential.ref, args.api);
      const connectUrl = (typeof data?.connectUrl === "string" && data.connectUrl.trim()) || fallbackConnectUrl(credential.ref, "chrome", args.api);
      const failedCheck = refusedCode === "STORE_CONNECTION_UNHEALTHY";
      const say = failedCheck
        ? `${failedCheckSentence(typeof data?.reason === "string" ? data.reason : typeof data?.message === "string" ? data.message : "")} ${connectSentences(connectUrl)}`
        : connectSentences(connectUrl);

      return envelope({
        ok: false,
        command: "extension_submit",
        status: failedCheck ? "store-connection-failed" : "store-not-connected",
        error: {
          code: "E_PLATFORM",
          name: "StoreNotConnected",
          message: failedCheck
            ? "The Chrome Web Store connection failed its last check, so nothing was submitted by this call."
            : "The Chrome Web Store is not connected to this project, so nothing was submitted by this call.",
          ...(refusedCode ? { platformCode: refusedCode } : {}),
        },
        value: { browsers, buildSha, channel, connectUrl, trackUrl: settingsUrl, sayToPerson: say },
        hint: say,
      });
    }

    if (!dryRun && !args.approvalId && platformRequiresApproval(res, data)) {
      return asked(await requestApprovalAfterRefusal(gateInput));
    }

    const answered = !dryRun && body.approvalId
      ? approvalRoundTrip({
          command: "extension_submit",
          platformCode: typeof data?.code === "string" ? data.code : "",
          message: typeof data?.message === "string" ? data.message : "",
          approvalId: String(body.approvalId),
          undone: "Nothing was submitted by this call.",
          api: args.api,
          value: { browsers, buildSha, channel },
          stateRead: statusRead,
        })
      : undefined;

    if (answered) return answered;

    const saidNothingDispatched = data?.retryable === true;
    const maybeDispatched =
      !dryRun && res.status >= 500 && !saidNothingDispatched;
    const BEFORE_APPROVAL = new Set(["BUILD_DISPATCH_DISABLED", "OWNER_REQUIRED", "TOKEN_ISSUER_UNKNOWN", "APPROVAL_REQUIRED", "APPROVAL_NOT_FOUND", "APPROVAL_SCOPE_MISMATCH", "APPROVAL_USED", "APPROVAL_EXPIRED"]);
    const platformCode = typeof data?.code === "string" ? data.code : "";
    const approvalSpent = !dryRun && Boolean(body.approvalId) && res.status < 500 && data?.refusedBeforeApproval !== true && !BEFORE_APPROVAL.has(platformCode);

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
              browsers.length === 1 ? browsers[0] : `one or more of ${  browsers.join(", ")}`
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
          : approvalSpent
            ? {
                hint: `The approval presented with this call was spent by the platform before this refusal (it consumes the grant once the owner, runner-class, dispatch-pause and allowance checks pass, and ${platformCode || "this refusal"} came after). Fix the cause, then call again with no approvalId to request a fresh approval.`,
              }
            : {}),
    });
  }

  const warnings: Array<string | null | undefined | false> = Array.isArray(
    data?.warnings,
  )
    ? (data.warnings as unknown[]).map((w) => {
        if (typeof w === "string") return w;
        if (!w || typeof w !== "object") return null;

        const row = w as { code?: unknown; store?: unknown; message?: unknown; docsUrl?: unknown };
        const rowText = String(row.message ?? row.code ?? "").trim();
        if (!rowText) return null;

        return `${row.store ? `${String(row.store)}: ` : ""}${rowText}${row.docsUrl ? ` (${String(row.docsUrl)})` : ""}`;
      })
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
    const ref = credential.ref;
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
        fetchRegistryJson(registryFileUrl(ref, "stores/health.json", args.api), fetch, {
          ref,
          api: args.api,
        }),
        fetchRegistryJson(registryFileUrl(ref, "channels.json", args.api), fetch, {
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

      if (channelsRes.ok && !channelsShapeProblem(channelsRes.json)) channelRows = parseChannels(channelsRes.json);
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
          reason: browser === "chrome"
            ? `No Chrome Web Store account is connected to this project, so a real submission for chrome would fail. ${connectSentences(fallbackConnectUrl(ref, "chrome", args.api))}`
            : `No ${browser} store is configured on this project; a real submission for ${browser} would fail. Configure it at ${consoleStoresUrl}.`,
        };
      }

      if (row.ok !== true) {
        return {
          browser,
          ok: false,
          configured: true as const,
          healthy: false,
          publishMode: "unknown",
          reason:
            String(row.message || "").trim() ||
            `The ${browser} store is configured but failed its last credential health check.`,
        };
      }

      return {
        browser,
        ok: true,
        configured: true as const,
        healthy: true,
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
          ? `Preflight passed for ${actionable.join(", ")}: the platform verified the token and project, found the store workflow, read build ${
              data?.buildId ?? buildSha
            } from its index where that index was readable, and the store credentials passed their last health check. Not checked by a dry run: the owner gate, the approval, the build quota, the dispatch pause and the submission mode, which the real run checks first.`
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

    statusNote = `Track this submission with ${statusRead}: the record appears in the registry's stores/submissions.json when the store workflow reports, so a read right after this answer may still show none; that is not a reason to submit again.`;
    result.submittedStores = outcome.stores;

    const itemUrl = outcome.stores.includes("chrome") ? chromeItemOf(data) : "";
    if (itemUrl) result.itemUrl = itemUrl;

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
        `The platform dispatched the store workflow for ${outcome.stores.join(", ")} and recorded each submission as pending. A Chrome or Edge store with no saved submission mode is uploaded as a draft (absent_mode: safe) and does not enter review and is recorded as "Uploaded, not public"; a store's own review, where it happens, comes after this answer.`,
      warnings: [...warnings, channelNote, statusNote, credential.note],
    });
  }

  return envelope({
    ok,
    command: "extension_submit",
    status: "preflight",
    value: result,
    hint: message,
    warnings: [...warnings, channelNote, statusNote, credential.note],
  });
}
