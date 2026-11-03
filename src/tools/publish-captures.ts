// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { linksOf, madeSentence, recordedOutcome } from "../lib/act-outcome";
import {
  BROWSER_CAPTURES_ACTION,
  CAPTURE_BROWSERS,
  approvalBody,
  browserDisplayName,
  capturesDigest,
  capturesFolder,
  isCaptureBrowser,
  majorVersion,
  readCaptures,
  readCapturedIn,
  syncBody,
  type CaptureBrowser,
  type CapturesRead,
} from "../lib/browser-captures";
import { envelope } from "../lib/envelope";
import { consoleProjectUrl } from "../lib/registry";
import { badShipRequest, isRow, openShipApi, runShipAct, text } from "../lib/ship-act";

import type { ProjectApi } from "../lib/project-api";

const COMMAND = "extension_publish";

export const SYNC_CAPTURES = "sync-captures";

type Row = Record<string, unknown>;

export interface SyncCapturesArgs {
  browsers?: unknown;
  projectPath?: string;
  approvalId?: string;
  project?: string;
  api?: string;
}

interface ReadSet extends Extract<CapturesRead, { captures: unknown[] }> {
  browser: CaptureBrowser;
}

function refuseLocal(browser: CaptureBrowser, read: Extract<CapturesRead, { problem: string }>): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status: "bad-request",
    value: { action: SYNC_CAPTURES, browser, ...(read.file ? { file: read.file } : {}) },
    error: { code: "E_BAD_REQUEST", name: "CapturesInputError", message: `${read.problem}. Nothing was sent.` },
    hint: `Capture again with extension_screenshot browserCapture:true on a ${browserDisplayName(browser)} dev session (it writes ${capturesFolder(browser)}/<surface>-NN.png as a flat PNG), or fix the file, then call sync-captures again with the same browsers and projectPath.`,
  });
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

async function sendOne(api: ProjectApi, args: SyncCapturesArgs, set: ReadSet): Promise<Row | { out: string }> {
  const { browser, captures, capturedIn } = set;
  const digest = capturesDigest(captures, capturedIn);
  const name = browserDisplayName(browser);
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const sent = await runShipAct(
    {
      command: COMMAND,
      act: SYNC_CAPTURES,
      action: BROWSER_CAPTURES_ACTION,
      route: `browsers/${browser}/captures`,
      method: "PUT",
      body: syncBody(captures, capturedIn),
      approvalBody: approvalBody(browser, captures, capturedIn),
      approvalId: text(args.approvalId),
      description: `Show ${plural(captures.length, `${name} capture`)} of ${project} on its public build pages${capturedIn ? `, captured in ${majorVersion(capturedIn)}` : ""}.`,
      reason: "The captures land on the project's public build pages for anyone who opens them, so a workspace owner approves the set as the platform computed it before it shows; the approval page lists each file by its hash, size and surface.",
      stateRead: `the project settings' Browser captures section (${capturesTrackUrl(api, args)})`,
      scopeFits: (scope) => text(scope.browser) === browser && (scope.capturesDigest === undefined || text(scope.capturesDigest) === digest),
      apiHint: args.api,
      value: { browser, project },
    },
    api,
  );

  if (!sent.ok) {
    let parsed: Row;

    try {
      parsed = JSON.parse(sent.out) as Row;
    } catch {
      return { out: sent.out };
    }

    const value = isRow(parsed.value) ? parsed.value : {};
    const error = isRow(parsed.error) ? parsed.error : {};

    if (text(error.platformCode) === "NO_CHANGE") {
      return { browser, status: "unchanged", from: { folder: set.folder, files: set.files }, trackUrl: capturesTrackUrl(api, args), ...(capturedIn ? { capturedIn } : {}) };
    }

    if (parsed.status !== "approval-required" || !text(value.approvalId)) return { out: sent.out };

    return {
      browser,
      status: "approval-required",
      approvalId: text(value.approvalId),
      approvalUrl: text(value.approvalUrl),
      ...(text(value.expiresAt) ? { expiresAt: text(value.expiresAt) } : {}),
      changes: Array.isArray(value.changes) ? value.changes : [],
      captures: captures.map((capture) => ({ file: capture.file, sha256: capture.sha256, width: capture.width, height: capture.height, ...(capture.surface ? { surface: capture.surface } : {}), ...(capture.caption ? { caption: capture.caption } : {}) })),
      ...(capturedIn ? { capturedIn } : {}),
    };
  }

  const json = sent.json;
  const record = isRow(json.record) ? json.record : json;
  const recorded = readCapturedIn(record.capturedIn) ?? capturedIn;

  return {
    browser,
    status: "synced",
    changes: Array.isArray(json.changes) ? json.changes : [],
    captures: Array.isArray(record.captures) ? record.captures : [],
    ...(recorded ? { capturedIn: recorded } : {}),
    ...(text(record.updatedAt) ? { updatedAt: text(record.updatedAt) } : {}),
    from: { folder: set.folder, files: set.files },
    trackUrl: text(json.trackUrl) || capturesTrackUrl(api, args),
    ...(text(json.publicUrl) ? { publicUrl: text(json.publicUrl) } : {}),
  };
}

function capturesTrackUrl(api: ProjectApi, args: SyncCapturesArgs): string {
  return consoleProjectUrl(api.ref, ConsoleProjectPage.projectSettingsSection("browser-captures"), args.api);
}

/* @invariant A CAPTURE SET IS SENT AS THE FOLDER HOLDS IT, AND NEVER TWICE.
 * sync-captures reads captures/<browser>/ in file name order with the
 * surfaces, captions and capturedIn the index beside it records, refuses the
 * set on this machine before any approval is asked for, and sends it once:
 * the first call without approvalId answers approval-required with the
 * change as the platform computed it, the second with that approvalId writes
 * once and answers what the platform recorded, with the console page that
 * tracks the set and the public listing page that shows it. */
export async function syncCaptures(args: SyncCapturesArgs): Promise<string> {
  const browsers = (Array.isArray(args.browsers) ? args.browsers : []).map((b) => text(b).toLowerCase()).filter(Boolean);
  const unknown = browsers.filter((b) => !isCaptureBrowser(b));

  if (!browsers.length) {
    return badShipRequest(COMMAND, SYNC_CAPTURES, "CapturesInputError", `sync-captures needs browsers, one or more of ${CAPTURE_BROWSERS.join(", ")}: each names the captures/<browser>/ folder to send. Nothing was sent.`);
  }

  if (unknown.length) {
    return badShipRequest(COMMAND, SYNC_CAPTURES, "CapturesInputError", `${unknown.join(", ")} is not a browser the public build page shows captures for; use ${CAPTURE_BROWSERS.join(", ")}. Nothing was sent.`);
  }

  if (text(args.approvalId) && browsers.length > 1) {
    return badShipRequest(COMMAND, SYNC_CAPTURES, "CapturesInputError", "An approval covers one browser's captures, so pass one browser with its approvalId. Nothing was sent.");
  }

  const projectPath = text(args.projectPath);

  if (!projectPath || !fs.existsSync(projectPath)) {
    return badShipRequest(COMMAND, SYNC_CAPTURES, "CapturesInputError", "sync-captures needs projectPath, the extension project root that holds captures/<browser>/. Nothing was sent.");
  }

  const sets: ReadSet[] = [];

  for (const browser of [...new Set(browsers)] as CaptureBrowser[]) {
    const read = readCaptures(projectPath, browser);
    if ("problem" in read) return refuseLocal(browser, read);

    sets.push({ browser, ...read });
  }

  const opened = await openShipApi(COMMAND, args, { action: SYNC_CAPTURES, browsers });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const rows: Record<string, Row> = {};

  for (const set of sets) {
    const result = await sendOne(api, args, set);
    if ("out" in result) return result.out as string;

    rows[set.browser] = result;
  }

  const listed = Object.values(rows);
  const approvals = listed.filter((row) => row.status === "approval-required");
  const value: Row = { action: SYNC_CAPTURES, project, browsers: rows };

  if (approvals.length) {
    const only = approvals.length === 1 ? approvals[0]! : null;
    const named = approvals.map((row) => text(row.browser));

    return envelope({
      ok: false,
      command: COMMAND,
      status: "approval-required",
      value: {
        ...value,
        ...(only ? { approvalId: only.approvalId, approvalUrl: only.approvalUrl, ...(only.expiresAt ? { expiresAt: only.expiresAt } : {}) } : {}),
      },
      error: {
        code: "E_APPROVAL_REQUIRED",
        name: "ApprovalRequired",
        message: `The platform asked a workspace owner to approve the ${named.join(", ")} captures before they show on the public build pages. Nothing was written.`,
      },
      hint: only
        ? `Approve at ${text(only.approvalUrl)}: the page lists the ${plural((only.captures as unknown[]).length, `${browserDisplayName(text(only.browser) as CaptureBrowser)} capture`)} as the platform computed the change. Then call extension_publish action:"sync-captures" again with browsers:["${text(only.browser)}"], the same projectPath and approvalId ${text(only.approvalId)}.`
        : `Approve at ${approvals.map((row) => `${text(row.approvalUrl)} (${text(row.browser)})`).join(", ")}, then call extension_publish action:"sync-captures" again once per browser with browsers:[<browser>], the same projectPath and that browser's approvalId.`,
    });
  }

  const first = listed[0]!;
  const trackUrl = text(first.trackUrl);
  const publicUrl = listed.map((row) => text(row.publicUrl)).find(Boolean) ?? "";
  const links = linksOf([
    { kind: "track", url: trackUrl },
    ...(publicUrl ? [{ kind: "project" as const, url: publicUrl, audience: "anyone with the link" }] : []),
  ]);
  const synced = listed.filter((row) => row.status === "synced");
  const said = listed.map((row) => {
    const browser = text(row.browser) as CaptureBrowser;
    const count = Array.isArray(row.captures) ? row.captures.length : 0;
    const captured = readCapturedIn(row.capturedIn);

    if (row.status === "unchanged") return `${capturesFolder(browser)}/ already matches the ${browserDisplayName(browser)} captures on record, so nothing was written for ${browser}.`;

    return `${plural(count, `${browserDisplayName(browser)} capture`)} from ${capturesFolder(browser)}/ now ${count === 1 ? "shows" : "show"} on the public build pages of ${project}${captured ? ` as captured in ${majorVersion(captured)}` : ""}${publicUrl ? `: ${publicUrl}` : ""}.`;
  });

  return envelope({
    ok: true,
    command: COMMAND,
    status: synced.length ? "captures-synced" : "captures-unchanged",
    value: { ...value, trackUrl, ...(publicUrl ? { publicUrl } : {}), outcome: recordedOutcome(synced.length ? "synced" : "unchanged"), links },
    hint: `${said.join(" ")} Track the set at ${trackUrl}, the project settings' Browser captures section. ${madeSentence(links)}`,
  });
}
