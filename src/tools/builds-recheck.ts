// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { after, awaitRecordedOutcome, dispatchedHint, linksOf, madeSentence, missedRead, stampNow, type Verdict } from "../lib/act-outcome";
import { browserHealthOf, describeBrowserHealth, readBuildHealth, type BrowserHealth } from "../lib/build-health";
import { envelope } from "../lib/envelope";
import { projectApiSend, type ProjectApi } from "../lib/project-api";
import { trackUrl } from "../lib/track-url";
import { COMMAND, actRefusal, badRequest, isRow, openFor, text, type ActArgs, type Row } from "./builds-acts";

const REFUSALS: Record<number, { status: string; message: string }> = {
  404: {
    status: "not-found",
    message: "has no stored artifact to check for that browser, so there is nothing to recheck. Read extension_builds (action: 'get') for the browsers it built.",
  },
  409: {
    status: "run-in-progress",
    message: "has a run in progress, and the platform checks its artifacts itself when that run finishes. Wait for it on the build page instead of rechecking.",
  },
  429: {
    status: "rate-limited",
    message: "was rechecked less than a minute ago; the platform allows one recheck per build every 60 seconds. Read the result with extension_builds (action: 'get') or wait a minute.",
  },
};

function buildPageOf(api: ProjectApi, buildId: string, apiHint?: string): string {
  return trackUrl("build", { workspace: api.ref.workspace, project: api.ref.project, buildId }, apiHint);
}

function checkedRows(json: Row): Row[] {
  return (Array.isArray(json.browsers) ? json.browsers : []).filter(isRow).filter((row) => text(row.browser) || text(row.name));
}

function healthOf(row: Row): BrowserHealth | null {
  if (!Array.isArray(row.checks)) return null;

  return browserHealthOf(
    text(row.browser) || text(row.name),
    null,
    { ok: true, json: { ok: row.ok === true, checks: row.checks } },
    { explicit: { checkedAt: row.checkedAt, runId: row.run } },
  );
}

const SETTLED_INTEGRITY = new Set(["passed", "failed", "stale"]);

function browserRow(health: BrowserHealth): Row {
  return {
    integrity: health.integrity,
    ...(health.checkedAt ? { checkedAt: health.checkedAt } : {}),
    ...(health.checkedRun ? { checkedRun: health.checkedRun } : {}),
    ...(health.failedChecks.length ? { failedChecks: health.failedChecks } : {}),
  };
}

function judgeRecheck(health: BrowserHealth[], wanted: string[], sinceIso: string): Verdict {
  const rows = wanted.length ? health.filter((row) => wanted.includes(row.browser)) : health;
  if (!rows.length || (wanted.length && rows.length < wanted.length)) return { kind: "waiting", status: "no verdict yet" };

  const settled = rows.every((row) => SETTLED_INTEGRITY.has(row.integrity) && (!row.checkedAt || after(row.checkedAt, sinceIso)));
  if (!settled) return { kind: "waiting", status: "checking" };

  const failed = rows.filter((row) => row.integrity !== "passed");

  return { kind: "recorded", status: failed.length ? `failed: ${failed.map((row) => row.browser).join(", ")}` : "passed" };
}

function resultHint(buildId: string, done: BrowserHealth[], checking: string[], buildPage: string, project?: string): string {
  const failed = done.filter((b) => b.integrity !== "passed");
  const publish = `extension_publish (buildSha: '${buildId}'${project ? `, project: '${project}'` : ""})`;

  if (checking.length) {
    return `The platform is still checking ${checking.join(", ")}. Read the verdict with extension_builds (action: 'get', buildId: '${buildId}') in a minute, or follow it at ${buildPage}.`;
  }

  if (done.length && !failed.length) {
    return `Every rechecked browser passed (${done.map((b) => b.browser).join(", ")}), so publish is now possible: call ${publish}. The build page is ${buildPage}.`;
  }

  return `The recheck rejects the stored artifacts of ${failed.map(describeBrowserHealth).join("; ")}. These are the artifacts this build serves, so rebuild with extension_builds (action: 'rebuild', buildId: '${buildId}') before publishing. The build page is ${buildPage}.`;
}

export async function recheck(args: ActArgs & { browser?: string }): Promise<string> {
  const buildId = text(args.buildId);
  const browser = text(args.browser).toLowerCase();

  if (!buildId) {
    return badRequest(
      "recheck",
      "BuildsInputError",
      'action:"recheck" needs a buildId. Run action:"list" for the recent builds and pass one of their buildId values.',
    );
  }

  const opened = await openFor(args, "recheck", { buildId });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const buildPage = buildPageOf(api, buildId, args.api);
  const sent = await projectApiSend<Row>(
    api,
    "POST",
    `builds/${encodeURIComponent(buildId)}/integrity/recheck`,
    browser ? { browser } : {},
  );

  if (!sent.ok) {
    const known = REFUSALS[sent.status];

    if (!known || sent.held) {
      return actRefusal(sent, "recheck", api, args, { buildId, ...(browser ? { browser } : {}) });
    }

    const subject = `Build ${buildId}${browser ? ` (${browser})` : ""}`;

    return envelope({
      ok: false,
      command: COMMAND,
      status: known.status,
      value: {
        action: "recheck",
        buildId,
        ...(browser ? { browser } : {}),
        ...(sent.retryAfterSeconds ? { retryAfterSeconds: sent.retryAfterSeconds } : {}),
        status: `${subject} was not rechecked: it ${known.message.split(".")[0]}.`,
        trackUrl: buildPage,
      },
      error: {
        code: sent.status === 404 ? "E_BUILD_NOT_FOUND" : "E_PLATFORM",
        name: "BuildsRefused",
        ...(sent.code ? { platformCode: sent.code } : {}),
        message: `${subject} ${known.message}`,
      },
      hint: `Follow the build at ${buildPage}.`,
    });
  }

  const acceptedAt = stampNow();
  const json = isRow(sent.json) ? sent.json : {};
  const sinceIso = text(json.checkedAt) && Number.isFinite(Date.parse(text(json.checkedAt))) ? text(json.checkedAt) : new Date(Date.parse(acceptedAt) - 60_000).toISOString();
  const rows = checkedRows(json);
  let done: BrowserHealth[] = [];
  let checking: string[] = [];
  const browsers: Row = {};

  for (const row of rows) {
    const name = text(row.browser) || text(row.name);
    const health = healthOf(row);

    if (!health) {
      checking.push(name);
      browsers[name] = { integrity: "checking", ...(text(row.checkedAt) ? { checkedAt: text(row.checkedAt) } : {}) };
      continue;
    }

    done.push(health);
    browsers[name] = browserRow(health);
  }

  const canonical = text(json.buildId) || buildId;
  const wanted = rows.map((row) => text(row.browser) || text(row.name)).filter(Boolean);
  const waited = await awaitRecordedOutcome<BrowserHealth[]>({
    waitSeconds: args.waitSeconds,
    read: async () => {
      const health = await readBuildHealth({ command: COMMAND, buildId: canonical, project: args.project, api: args.api });
      if (!health.checked) return missedRead({ status: health.status ?? -1, message: health.reason });

      return { ok: true, record: health.browsers };
    },
    judge: (health) => judgeRecheck(health, browser ? [browser] : wanted, sinceIso),
  });

  if (waited.outcome.recorded && waited.record) {
    const fresh = waited.record.filter((row) => (browser ? row.browser === browser : wanted.length === 0 || wanted.includes(row.browser)));
    done = fresh;
    checking = [];
    for (const row of fresh) browsers[row.browser] = browserRow(row);
  }

  const good = done.filter((b) => b.integrity === "passed").map((b) => b.browser);
  const failed = done.filter((b) => b.integrity !== "passed").map((b) => b.browser);
  const publishable = rows.length > 0 && checking.length === 0 && failed.length === 0 && waited.outcome.recorded;
  const links = linksOf([{ kind: "build", url: buildPage }]);
  const made = madeSentence(links);
  const readCall = `extension_builds (action: "get", buildId: "${canonical}")`;
  const value = {
    action: "recheck",
    buildId: canonical,
    ...(text(json.checkedAt) ? { checkedAt: text(json.checkedAt) } : {}),
    browsers,
    good,
    failed,
    checking,
    publishable,
    status: !waited.outcome.recorded
      ? `Build ${canonical} is being rechecked; the platform's record has not confirmed the verdict for ${checking.join(", ") || wanted.join(", ") || "its browsers"} yet.`
      : publishable
        ? `Build ${canonical} passed the recheck for ${good.join(", ")}; nothing blocks publishing it.`
        : `Build ${canonical} failed the recheck for ${failed.join(", ") || "every browser"}; a new build unblocks it.`,
    trackUrl: buildPage,
    outcome: waited.outcome,
    links,
  };

  if (!waited.outcome.recorded) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "recheck-dispatched",
      value,
      hint: `${dispatchedHint({ acceptedAt, trackUrl: buildPage, readCall })} ${made}`,
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "rechecked",
    value,
    hint: `${resultHint(canonical, done, checking, buildPage, args.project)} ${made}`,
  });
}
