// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { WRITE_FAILURE_REPORT_URL } from "./settings-write";
import { isRow, text } from "./ship-act";
import { connectionSourceOf, nextStep, type ConnectionSource, type NextStep } from "./store-connection";

type Row = Record<string, unknown>;

export const AMO_KEY_PAGE = "https://addons.mozilla.org/developers/addon/api/key/";

export type CredentialFault = "issuer-unknown" | "secret-rejected";
export type KeyOnFile = "refused" | "accepted" | "unread";

export interface CredentialFailure {
  store: "firefox";
  credential: CredentialFault;
  keyOnFile: KeyOnFile;
  source: ConnectionSource | null;
}

const AMO_401 = /\bHTTP 401\b[\s\S]*addons\.mozilla\.org|unknown jwt iss|error decoding signature/i;
const UNKNOWN_ISSUER = /unknown jwt iss/i;
const KEY_ON_FILE = new Set<KeyOnFile>(["refused", "accepted", "unread"]);

/* @invariant A 401 FROM AMO IS A CREDENTIAL FAILURE, AND THE PLATFORM'S
 * DETAIL DECIDES WHICH SIDE IS AT FAULT. On 2026-11-11 an approved Firefox
 * submit failed 401 "Unknown JWT iss (issuer)" and the next step said only
 * "fix the cause" (ledger 529). The platform now answers the record's
 * failureCause with the half that failed (the issuer AMO does not know, or
 * the secret that does not match it), whether the key on file was refused
 * or accepted by the platform's own signed read, and whose account the run
 * used. A record from an older platform carries only the lane's sentence,
 * which is read by shape with the key on file left unread.
 */
export function credentialFailureOf(submission: Row): CredentialFailure | null {
  const cause = isRow(submission.failureCause) ? submission.failureCause : null;

  if (cause && text(cause.kind) === "store-connection-failed" && text(cause.store) === "firefox") {
    const keyOnFile = text(cause.keyOnFile) as KeyOnFile;

    return {
      store: "firefox",
      credential: text(cause.credential) === "issuer-unknown" ? "issuer-unknown" : "secret-rejected",
      keyOnFile: KEY_ON_FILE.has(keyOnFile) ? keyOnFile : "unread",
      source: connectionSourceOf(cause.source),
    };
  }

  const reason = text(submission.failureReason);

  if (text(submission.store) !== "firefox" || !AMO_401.test(reason)) return null;

  return { store: "firefox", credential: UNKNOWN_ISSUER.test(reason) ? "issuer-unknown" : "secret-rejected", keyOnFile: "unread", source: null };
}

export function credentialFaultSentence(credential: CredentialFault): string {
  return credential === "issuer-unknown"
    ? `AMO answered 401 "Unknown JWT iss (issuer)": the JWT issuer the run was handed is not one AMO knows, so the key was revoked or regenerated at ${AMO_KEY_PAGE}`
    : "AMO answered 401 on the JWT secret: the issuer is known to AMO and the secret the run was handed does not match it";
}

function connectWhere(failure: CredentialFailure, connectUrl: string, accountsUrl: string): string {
  if (failure.source === "workspace") return `the workspace's Store accounts page at ${accountsUrl}`;
  if (failure.source === "project") return `the Firefox store settings at ${connectUrl}`;

  return `the Firefox store settings at ${connectUrl}, or the workspace's Store accounts page at ${accountsUrl} when the project runs on the workspace's account`;
}

/* @invariant THE CONNECT STEP IS THE NEXT STEP ONLY WHEN THE KEY ON FILE CAN
 * BE AT FAULT. A key the platform's own read was refused with is replaced;
 * a key that read accepted a moment ago says the handoff is at fault and
 * sends the person to preflight and the report, never to paste a key that
 * works; an unread key names the key on file as the likely cause and both
 * places to connect it, with the handoff as the fault if AMO refuses again.
 */
export function credentialFailureStep(args: {
  failure: CredentialFailure;
  connectUrl: string;
  accountsUrl: string;
  trackUrl: string;
}): NextStep {
  const { failure, trackUrl } = args;
  const lead = `The submission did not reach Firefox Add-ons; nothing is in review. ${credentialFaultSentence(failure.credential)}.`;
  const url = failure.source === "workspace" ? args.accountsUrl : args.connectUrl;
  const connect = `Connect Firefox Add-ons again with the current key pair from ${AMO_KEY_PAGE}, replacing the one on file, at ${connectWhere(failure, args.connectUrl, args.accountsUrl)}; the console checks the pair against AMO before it saves it. Then submit the same build again.`;
  const words = `${trackUrl} holds the run's own words.`;

  if (failure.keyOnFile === "accepted") {
    return nextStep(
      "preflight",
      `${lead} The key on file is not at fault: the platform's own signed read of AMO with it was accepted just now, so the handoff of that key to the store run is, and replacing the key fixes nothing. Report it at ${WRITE_FAILURE_REPORT_URL} with the submission id; say preflight again before the next submit. ${words}`,
      trackUrl,
    );
  }

  const fault =
    failure.keyOnFile === "refused"
      ? "The key on file is at fault: the platform's own signed read of AMO with it was refused too."
      : `Whether the key on file or its handoff to the store run is at fault could not be told, since the platform did not read AMO with the key on file; the key on file is the likely cause. If AMO refuses the next run the same way, the handoff is at fault: report it at ${WRITE_FAILURE_REPORT_URL} with the submission id.`;

  return { ...nextStep("connect", `${lead} ${fault} ${connect} ${words}`, url), replace: true };
}
