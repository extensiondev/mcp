// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { WRITE_FAILURE_REPORT_URL } from "./settings-write";
import { isRow, text } from "./row";
import { connectionSourceOf, nextStep, storeLabel, type ConnectionSource, type NextStep } from "./store-connection";

type Row = Record<string, unknown>;

export const AMO_KEY_PAGE = "https://addons.mozilla.org/developers/addon/api/key/";

export type CredentialFault = "issuer-unknown" | "secret-rejected" | "credential-refused";
export type CredentialStore = "firefox" | "chrome" | "edge" | "safari";
export type KeyOnFile = "refused" | "accepted" | "unread";

export interface CredentialFailure {
  store: CredentialStore;
  credential: CredentialFault;
  keyOnFile: KeyOnFile;
  source: ConnectionSource | null;
}

const AMO_401 = /\bHTTP 401\b[\s\S]*addons\.mozilla\.org|unknown jwt iss|error decoding signature/i;
const UNKNOWN_ISSUER = /unknown jwt iss/i;
const KEY_ON_FILE = new Set<KeyOnFile>(["refused", "accepted", "unread"]);

type KeyedStore = Exclude<CredentialStore, "firefox">;

/* @invariant A STORE API'S AUTH REFUSAL IS A CREDENTIAL FAILURE ON EVERY
 * STORE, READ FROM THE SENTENCE THE RUN RECORDED. The store run records a
 * refused request as "HTTP <status> <text>, <method> <url>" followed by the
 * store's body, so a 401 from the Chrome Web Store, Partner Center or App
 * Store Connect host, Google's refusal of the token exchange (invalid_grant,
 * invalid_client) and Apple's NOT_AUTHORIZED each name the credential the
 * run was handed. Chrome's upload, publish and cancel calls word theirs
 * "Chrome upload failed: 401 Unauthorized", with no host. A 403 is left
 * alone: it is what a store answers for an item the account does not own,
 * and connecting again fixes nothing there.
 */
const AUTH_REFUSAL: Record<KeyedStore, RegExp> = {
  chrome: /\bHTTP 401\b[\s\S]*googleapis\.com|\bChrome [a-z ]+ failed: 401\b|\binvalid_grant\b|\binvalid_client\b/i,
  edge: /\bHTTP 401\b[\s\S]*microsoftedge\.microsoft\.com/i,
  safari: /\bHTTP 401\b[\s\S]*appstoreconnect\.apple\.com|\bNOT_AUTHORIZED\b/i,
};

const REFUSED: Record<KeyedStore, string> = {
  chrome: "Google refused the Chrome Web Store connection the run was handed",
  edge: "Partner Center answered 401 on the Publish API Client ID and key the run was handed",
  safari: "App Store Connect answered 401 on the API key the run was handed",
};

const SO_ON_FILE: Record<KeyedStore, string> = {
  chrome: "so the connection on file was revoked or has expired",
  edge: "so the key on file has expired or was regenerated",
  safari: "so the key on file was revoked or its issuer ID, key ID and private key no longer match",
};

const REFUSED_BY: Record<KeyedStore, string> = {
  chrome: `${REFUSED.chrome}, ${SO_ON_FILE.chrome}`,
  edge: `${REFUSED.edge}, ${SO_ON_FILE.edge}`,
  safari: `${REFUSED.safari}, ${SO_ON_FILE.safari}`,
};

const CONNECT_AGAIN: Record<KeyedStore, string> = {
  chrome: "Connect the Chrome Web Store again (Connect Chrome Web Store; Google asks for one click)",
  edge: "Connect Edge Add-ons again with a current Publish API Client ID and key from Partner Center, replacing the ones on file",
  safari: "Connect the App Store again with a current App Store Connect issuer ID, key ID and private key (.p8), replacing the ones on file",
};

function keyedStore(store: string): KeyedStore | null {
  return store === "chrome" || store === "edge" || store === "safari" ? store : null;
}

/* @invariant A 401 FROM AMO IS A CREDENTIAL FAILURE, AND THE PLATFORM'S
 * DETAIL DECIDES WHICH SIDE IS AT FAULT. On 2026-11-11 an approved Firefox
 * submit failed 401 "Unknown JWT iss (issuer)" and the next step said only
 * "fix the cause" (ledger 529). The platform now answers the record's
 * failureCause with the half that failed (the issuer AMO does not know, or
 * the secret that does not match it), whether the key on file was refused
 * or accepted by the platform's own signed read, and whose account the run
 * used. The platform answers the same cause for a Chrome, Edge and App
 * Store run, with the verdict its status poll holds on the key on file, so
 * the structured cause is read first for every store and decides alone. A
 * record from an older platform carries only the lane's sentence, which is
 * read by shape with the key on file left unread.
 */
export function credentialFailureOf(submission: Row): CredentialFailure | null {
  const cause = isRow(submission.failureCause) ? submission.failureCause : null;
  const named = cause && text(cause.kind) === "store-connection-failed" ? text(cause.store) : "";

  if (cause && (named === "firefox" || keyedStore(named))) {
    const keyOnFile = text(cause.keyOnFile) as KeyOnFile;
    const firefoxFault = text(cause.credential) === "issuer-unknown" ? "issuer-unknown" : "secret-rejected";

    return {
      store: named as CredentialStore,
      credential: named === "firefox" ? firefoxFault : "credential-refused",
      keyOnFile: KEY_ON_FILE.has(keyOnFile) ? keyOnFile : "unread",
      source: connectionSourceOf(cause.source),
    };
  }

  const reason = text(submission.failureReason);
  const keyed = keyedStore(text(submission.store));

  if (keyed) return AUTH_REFUSAL[keyed].test(reason) ? { store: keyed, credential: "credential-refused", keyOnFile: "unread", source: null } : null;

  if (text(submission.store) !== "firefox" || !AMO_401.test(reason)) return null;

  return { store: "firefox", credential: UNKNOWN_ISSUER.test(reason) ? "issuer-unknown" : "secret-rejected", keyOnFile: "unread", source: null };
}

export function credentialFaultSentence(credential: CredentialFault, store: CredentialStore = "firefox"): string {
  const keyed = keyedStore(store);

  if (keyed) return REFUSED_BY[keyed];

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
 * A Chrome, Edge or App Store failure follows the same three verdicts, read
 * from the platform's status poll of that store with the key on file.
 */
export function credentialFailureStep(args: {
  failure: CredentialFailure;
  connectUrl: string;
  accountsUrl: string;
  trackUrl: string;
}): NextStep {
  const { failure, trackUrl } = args;
  const keyed = keyedStore(failure.store);

  if (keyed) {
    const label = storeLabel(keyed);
    const reached = `The submission did not reach ${label}; nothing is in review.`;
    const held = `${trackUrl} holds the run's own words.`;

    if (failure.keyOnFile === "accepted") {
      return nextStep(
        "preflight",
        `${reached} ${REFUSED[keyed]}. The credential on file is not at fault: ${label} accepted it on the platform's own status read after this run failed, so the handoff of that credential to the store run is, and connecting again fixes nothing. Report it at ${WRITE_FAILURE_REPORT_URL} with the submission id; say preflight again before the next submit. ${held}`,
        trackUrl,
      );
    }

    const where = keyed === "chrome" ? `the Chrome store settings at ${args.connectUrl}` : `the workspace's Store accounts page at ${args.accountsUrl}, or the ${label} store settings at ${args.connectUrl} when the project holds its own key`;
    const fault =
      failure.keyOnFile === "refused"
        ? `${REFUSED_BY[keyed]}. The credential on file is at fault: ${label} refused it on the platform's own status read too.`
        : `${REFUSED_BY[keyed]}.`;
    const again =
      failure.keyOnFile === "refused"
        ? ""
        : ` If the store refuses the next run the same way, the handoff of the credential to the store run is at fault: report it at ${WRITE_FAILURE_REPORT_URL} with the submission id.`;
    const say = `${reached} ${fault} ${CONNECT_AGAIN[keyed]} at ${where}; the console checks it against the store before it saves it. Then submit the same build again.${again} ${held}`;

    return { ...nextStep("connect", say, keyed === "chrome" ? args.connectUrl : args.accountsUrl), replace: true };
  }

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
