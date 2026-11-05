// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

type Row = Record<string, unknown>;

export type SafariSigningState = "current" | "renewing" | "expired" | "minted-at-next-submit" | "hand-saved" | "no-key";

export const SAFARI_SIGNING_RENEW_DAYS = 30;

export const ASC_KEY_EXPIRY = "An App Store Connect API key has no end date; it works until someone revokes it in App Store Connect, and a revoked key is refused at the next check with Apple's words.";

const DAY_MS = 24 * 60 * 60 * 1000;

const ASC_SECRETS = ["STORE_SAFARI_ASC_KEY_ID", "STORE_SAFARI_ASC_ISSUER_ID", "STORE_SAFARI_ASC_KEY_BASE64"];

const SIGNING_SECRETS = [
  "STORE_SAFARI_APP_CERT_P12_BASE64",
  "STORE_SAFARI_APP_CERT_PASSWORD",
  "STORE_SAFARI_INSTALLER_CERT_P12_BASE64",
  "STORE_SAFARI_INSTALLER_CERT_PASSWORD",
  "STORE_SAFARI_PROVISIONING_PROFILE_BASE64",
  "STORE_SAFARI_APPEX_PROVISIONING_PROFILE_BASE64",
];

const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const day = (iso: string): string => iso.slice(0, 10);

function rows(value: unknown, keys: string[]): Row[] {
  return (Array.isArray(value) ? value : []).filter(isRow).map((row) => Object.fromEntries(keys.map((key) => [key, text(row[key])])));
}

function missingOf(json: Row): string[] | null {
  const config = isRow(json.storeConfig) ? json.storeConfig : null;

  if (!config || config.credentialsVerified === false || !Array.isArray(config.missingSecrets)) return null;

  return config.missingSecrets.map(text).filter(Boolean);
}

function sentence(state: SafariSigningState, expires: string, daysLeft: number, renewsFrom: string): string {
  switch (state) {
    case "no-key":
      return "The App Store has no App Store Connect key to sign with; connect it once and every later Safari submit mints and renews its own certificates and profiles.";
    case "minted-at-next-submit":
      return "The App Store Connect key is all the App Store needs: the next Safari submit mints both distribution certificates and both provisioning profiles before it builds, or signs with the Apple team's shared pair, so no .p12 is exported.";
    case "hand-saved":
      return "The six signing values were saved by hand, so their end dates are not readable from here; each Safari submit reads them itself and renews them from the App Store Connect key inside 30 days of their end.";
    case "expired":
      return `The Safari certificates and profiles ended on ${day(expires)}; the next Safari submit renews them from the App Store Connect key before it signs.`;
    case "renewing":
      return `The Safari certificates and profiles end on ${day(expires)}, ${daysLeft} ${daysLeft === 1 ? "day" : "days"} from now; the next Safari submit renews them from the App Store Connect key before it signs.`;
    default:
      return `Safari signing is valid through ${day(expires)}; the first Safari submit after ${day(renewsFrom)} renews it.`;
  }
}

export function safariSigningOf(json: Row, now: Date = new Date()): Row | null {
  const missing = missingOf(json);
  const view = isRow(json.safariSigningAssets) ? json.safariSigningAssets : null;

  if (!missing && !view) return null;

  const keyMissing = (missing ?? []).some((name) => ASC_SECRETS.includes(name));
  const signingMissing = (missing ?? []).some((name) => SIGNING_SECRETS.includes(name));
  const expires = view ? text(view.expires) : "";
  const leftMs = Date.parse(expires) - now.getTime();
  const daysLeft = Number.isFinite(leftMs) ? Math.ceil(leftMs / DAY_MS) : 0;
  const renewsFrom = Number.isFinite(leftMs) ? new Date(Date.parse(expires) - SAFARI_SIGNING_RENEW_DAYS * DAY_MS).toISOString() : "";
  const state: SafariSigningState = keyMissing
    ? "no-key"
    : signingMissing
      ? "minted-at-next-submit"
      : !view
        ? "hand-saved"
        : !(leftMs > 0)
          ? "expired"
          : daysLeft <= SAFARI_SIGNING_RENEW_DAYS
            ? "renewing"
            : "current";
  const dated = view && !signingMissing && !keyMissing;

  return {
    state,
    ...(dated ? { expires, daysLeft, renewsFrom, mintedAt: text(view.mintedAt) } : {}),
    ...(dated ? { certificates: rows(view.certificates, ["type", "serial", "expires"]), profiles: rows(view.profiles, ["bundleId", "name", "expires"]) } : {}),
    key: { expires: null, say: ASC_KEY_EXPIRY },
    say: sentence(state, expires, daysLeft, renewsFrom),
  };
}

export function safariSigningSentence(stores: Row): string {
  const safari = isRow(stores.safari) ? stores.safari : null;
  const signing = safari && isRow(safari.signing) ? safari.signing : null;

  return signing && text(signing.state) !== "current" ? text(signing.say) : "";
}
