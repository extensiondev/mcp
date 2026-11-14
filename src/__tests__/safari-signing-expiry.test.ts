// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit-local";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, any>;

const PREFLIGHT = `${PROJECT_ROUTE}/stores/safari/submissions/preflight`;
const WALK: Record<string, Row> = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/preflight-four-stores.json", import.meta.url)), "utf8"));
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNING = [
  "STORE_SAFARI_APP_CERT_P12_BASE64",
  "STORE_SAFARI_APP_CERT_PASSWORD",
  "STORE_SAFARI_INSTALLER_CERT_P12_BASE64",
  "STORE_SAFARI_INSTALLER_CERT_PASSWORD",
  "STORE_SAFARI_PROVISIONING_PROFILE_BASE64",
  "STORE_SAFARI_APPEX_PROVISIONING_PROFILE_BASE64",
];

function report(args: { missing: string[]; endsInDays?: number }): Row {
  const base = structuredClone(WALK.safari!);
  const expires = args.endsInDays === undefined ? "" : new Date(Date.now() + args.endsInDays * DAY_MS).toISOString();

  return {
    ...base,
    storeConfig: { missingSecrets: args.missing, bundleId: "dev.extension.widget" },
    ...(expires
      ? {
          safariSigningAssets: {
            mintedAt: "2026-07-23T10:00:00.000Z",
            expires,
            source: "mirror",
            bundleIds: [],
            certificates: [{ type: "MAC_APP_DISTRIBUTION", serial: "AA01", expires }],
            profiles: [{ bundleId: "dev.extension.widget", name: "extension.dev dev.extension.widget Mac App Store", expires }],
          },
        }
      : {}),
  };
}

describe("extension_submit preflight answers when Safari signing ends and who renews it", () => {
  const platform = useProjectRoutes("extdev-safari-signing-");

  async function preflight(body: Row): Promise<Row> {
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body });

    return JSON.parse(await submit({ action: "preflight", browsers: ["safari"], api: API }));
  }

  it("says the App Store Connect key is enough and the next submit mints the six, with the key's no-end-date answer", async () => {
    const out = await preflight(report({ missing: SIGNING }));
    const signing = out.value.stores.safari.signing;

    expect(signing.state).toBe("minted-at-next-submit");
    expect(signing.expires).toBeUndefined();
    expect(signing.say).toContain("no .p12 is exported");
    expect(signing.key).toEqual({ expires: null, say: expect.stringContaining("has no end date") });
    expect(out.value.sayToPerson).toContain(signing.say);
  });

  it("warns inside thirty days with the end date and the days left, and names the submit as the renewal", async () => {
    const out = await preflight(report({ missing: [], endsInDays: 12 }));
    const signing = out.value.stores.safari.signing;

    expect(signing).toMatchObject({ state: "renewing", daysLeft: 12 });
    expect(signing.certificates).toEqual([expect.objectContaining({ serial: "AA01" })]);
    expect(signing.profiles).toHaveLength(1);
    expect(signing.say).toContain("12 days from now; the next Safari submit renews them");
    expect(out.value.sayToPerson).toContain(signing.say);
  });

  it("reads an ended mint as expired, and a mint far from its end as current and quiet", async () => {
    const ended = (await preflight(report({ missing: [], endsInDays: -2 }))).value.stores.safari.signing;

    expect(ended.state).toBe("expired");
    expect(ended.say).toContain("ended on");

    const out = await preflight(report({ missing: [], endsInDays: 200 }));
    const current = out.value.stores.safari.signing;

    expect(current.state).toBe("current");
    expect(current.renewsFrom.slice(0, 10)).toBe(new Date(Date.parse(current.expires) - 30 * DAY_MS).toISOString().slice(0, 10));
    expect(out.value.sayToPerson).not.toContain(current.say);
  });

  it("asks for the key alone when the App Store Connect key is missing, and never prints a secret name's value", async () => {
    const out = await preflight(report({ missing: ["STORE_SAFARI_ASC_KEY_BASE64", ...SIGNING] }));
    const signing = out.value.stores.safari.signing;

    expect(signing.state).toBe("no-key");
    expect(signing.say).toContain("connect it once");
    expect(JSON.stringify(signing)).not.toMatch(/BEGIN|P12_BASE64/);
  });
});
