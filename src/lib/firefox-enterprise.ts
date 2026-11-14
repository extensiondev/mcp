// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { engineManifestView } from "./engine-manifest-view";
import { engineProjectRoot } from "./session-paths";
import { isRow, text } from "./row";

type Row = Record<string, unknown>;

export const ENTERPRISE_CHANNEL_DATE = "2026-12-01";
export const ENTERPRISE_CHANNEL_DAY = "December 1, 2026";
export const ENTERPRISE_POLICIES_POST = "https://blog.mozilla.org/addons/2026/10/28/introducing-enterprise-add-on-policies/";
export const FIREFOX_AGREEMENT_URL = "https://addons.mozilla.org/developers/addon/agreement/";
export const FIREFOX_AGREEMENT_CHECK = "firefox.distribution_agreement";
export const FIREFOX_ENTERPRISE_CHANNEL_CHECK = "firefox.enterprise_channel";
export const ADMIN_INSTALL_ONLY_KEY = "browser_specific_settings.gecko.admin_install_only";

export const ENTERPRISE_CHANNEL_SENTENCE = `${ADMIN_INSTALL_ONLY_KEY} is true, the key Mozilla has enterprise developers self-declare with, so from ${ENTERPRISE_CHANNEL_DAY} this version goes to AMO's enterprise channel, which is neither listed nor unlisted: enterprise versions are only available through that channel, never appear on AMO and are not distributed by Mozilla in any other way, and they follow the enterprise add-on policies. The submission process does not change, and every developer on AMO must accept the updated Firefox Add-on Distribution Agreement. To keep the add-on listed on AMO, submit it the usual way without the key. Until that day AMO's linter (addons-linter 10.15.0, measured 2026-11-11) refuses any upload that carries the key as ADMIN_INSTALL_ONLY_PROP_RESERVED. Mozilla's post: ${ENTERPRISE_POLICIES_POST}`;

export const AGREEMENT_SENTENCE = `Every developer on AMO must accept the updated Firefox Add-on Distribution Agreement, which Mozilla adopts on ${ENTERPRISE_CHANNEL_DAY} with the enterprise add-on policies (${ENTERPRISE_POLICIES_POST})`;

export function adminInstallOnlyOf(manifest: Row): unknown {
  const bss = isRow(manifest.browser_specific_settings) ? manifest.browser_specific_settings : null;
  const gecko = bss && isRow(bss.gecko) ? bss.gecko : null;

  return gecko ? gecko.admin_install_only : undefined;
}

export function adminInstallOnlyTypeIssue(value: unknown): string | null {
  if (value === undefined || typeof value === "boolean") return null;

  return `${ADMIN_INSTALL_ONLY_KEY} must be true or false, got ${JSON.stringify(value)}; AMO's linter refuses the upload with MANIFEST_FIELD_INVALID ("must be boolean").`;
}

function readJson(file: string): Row | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));

    return isRow(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface FirefoxManifestRead {
  manifest: Row;
  from: string;
}

export function firefoxManifestOf(projectPath: string): FirefoxManifestRead | null {
  const root = engineProjectRoot(projectPath);
  const built = readJson(path.join(root, "dist", "firefox", "manifest.json"));
  if (built) return { manifest: built, from: "the built dist/firefox/manifest.json" };

  const sources: Array<[string, string]> = [
    [path.join(root, "src", "manifest.json"), "the source src/manifest.json"],
    [path.join(root, "manifest.json"), "the source manifest.json"],
  ];

  for (const [file, from] of sources) {
    const manifest = readJson(file);
    if (manifest) return { manifest: engineManifestView(manifest, "firefox"), from };
  }

  return null;
}

export interface EnterpriseChannelView {
  adminInstallOnly: true;
  channel: "enterprise";
  from: string;
  readFrom: string;
  say: string;
}

export function firefoxEnterpriseChannelOf(read: FirefoxManifestRead | null): EnterpriseChannelView | null {
  if (!read || adminInstallOnlyOf(read.manifest) !== true) return null;

  return {
    adminInstallOnly: true,
    channel: "enterprise",
    from: ENTERPRISE_CHANNEL_DATE,
    readFrom: read.from,
    say: `Firefox: ${ENTERPRISE_CHANNEL_SENTENCE} (read from ${read.from}).`,
  };
}

export interface AgreementRead {
  accepted: boolean | "unknown";
  acceptedAt: string;
  detail: string;
}

export function firefoxAgreementOf(dryRun: unknown): AgreementRead | null {
  const firefox = isRow(dryRun) && isRow(dryRun.firefox) ? dryRun.firefox : null;
  if (!firefox) return null;

  const accepted = firefox.agreementAccepted;
  if (accepted !== true && accepted !== false && accepted !== "unknown") return null;

  return { accepted, acceptedAt: text(firefox.agreementAcceptedAt), detail: text(firefox.agreementDetail) };
}

function day(iso: string): string {
  const ms = Date.parse(iso);

  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : iso;
}

export function firefoxAgreementCheck(read: AgreementRead | null, now = Date.now()): Row | null {
  if (read?.accepted === true) return null;

  const inForce = now >= Date.parse(`${ENTERPRISE_CHANNEL_DATE}T00:00:00Z`);
  const accept = `Accept it at ${FIREFOX_AGREEMENT_URL} with the connected AMO account, then call preflight again`;
  const base = {
    id: FIREFOX_AGREEMENT_CHECK,
    label: "The updated Firefox Add-on Distribution Agreement is accepted",
    stage: "integration",
    owner: "you",
    docsUrl: FIREFOX_AGREEMENT_URL,
    expected: `an acceptance AMO dates ${ENTERPRISE_CHANNEL_DATE} or later`,
  };

  if (read?.accepted === false && !read.acceptedAt) {
    return {
      ...base,
      status: "fail",
      severity: "blocking",
      actual: "AMO records no acceptance for the connected account",
      message: `AMO records no Firefox Add-on Distribution Agreement acceptance for the connected account, and AMO takes no submission without one. ${accept}.`,
    };
  }

  if (read?.accepted === false) {
    const dated = `AMO records the agreement accepted on ${day(read.acceptedAt)}, before the updated one`;

    return inForce
      ? {
          ...base,
          status: "fail",
          severity: "blocking",
          actual: dated,
          message: `${dated}. ${AGREEMENT_SENTENCE}, and that day has passed. ${accept}.`,
        }
      : {
          ...base,
          status: "warn",
          severity: "warning",
          actual: dated,
          message: `${dated}. ${AGREEMENT_SENTENCE}; AMO takes this submission today and prompts for the updated agreement from that day. Accept it at ${FIREFOX_AGREEMENT_URL} when AMO prompts.`,
        };
  }

  const why = read?.detail ? `: ${read.detail.replace(/[.\s]+$/, "")}` : " (the submit route's dry run did not answer it)";
  const unread = `whether the connected AMO account accepted the updated Firefox Add-on Distribution Agreement could not be read${why}`;

  return inForce
    ? {
        ...base,
        status: "fail",
        severity: "blocking",
        actual: `acceptance could not be read${why}`,
        message: `${unread[0]!.toUpperCase()}${unread.slice(1)}. ${AGREEMENT_SENTENCE}, and that day has passed. ${accept}.`,
      }
    : {
        ...base,
        status: "warn",
        severity: "warning",
        actual: `acceptance could not be read${why}`,
        message: `${unread[0]!.toUpperCase()}${unread.slice(1)}. ${AGREEMENT_SENTENCE}. Accept it at ${FIREFOX_AGREEMENT_URL} when AMO prompts.`,
      };
}
