// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { fallbackConnectUrl } from "./store-connection";

import type { ProjectRef } from "./registry";

type Row = Record<string, unknown>;

export const AMO_API_KEY_PAGE = "https://addons.mozilla.org/developers/addon/api/key/";

const CREDENTIALS_CHECK = "store.credentials_present";

function checkOf(json: Row, id: string): Row | null {
  const checks = Array.isArray(json.checks) ? json.checks : [];

  return checks.filter(isRow).find((check) => text(check.id) === id) ?? null;
}

/* @invariant A MISSING AMO CREDENTIAL IS "NOT CONNECTED", NOT THREE FAILED
 * CHECKS. The platform answers a Firefox store with no saved secrets as three
 * blocking checks (store.enabled, store.config_present and
 * store.credentials_present) whose docs link says nothing about Firefox, and
 * on 2026-10-22 the maintainer had to learn from the agent which values to
 * paste where. The credentials check reads fail only when the platform
 * verified the secret names and found them absent, so that one fact is the
 * connection state; the two values are named by the console form's labels,
 * never by the platform's secret names.
 */
export function firefoxNotConnected(json: Row): boolean {
  const check = checkOf(json, CREDENTIALS_CHECK);

  return check !== null && text(check.status) === "fail";
}

export function firefoxConnectUrl(ref: ProjectRef | null, api?: string): string {
  return fallbackConnectUrl(ref, "firefox", api);
}

export function firefoxConnectSentences(connectUrl: string): string {
  return `Firefox AMO is not connected to this project yet. Mozilla issues the two values once at ${AMO_API_KEY_PAGE}: the JWT issuer and the JWT secret, as the console form labels them. Paste them, with the add-on id or its AMO dashboard address, into the Firefox store settings at ${connectUrl} and turn store publishing on there; then say preflight again. I upload to the unlisted channel unless the project saved a release channel, and sign it for self distribution.`;
}
