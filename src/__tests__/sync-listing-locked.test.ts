// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit-local";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const MESSAGE =
  "The App Store listing is locked while Apple reviews 0.3.0 (WAITING_FOR_REVIEW); push the listing again once that version is editable.";
const LOCKED = {
  status: "locked",
  runState: "locked",
  dispatched: false,
  lockedVersion: "0.3.0",
  lockedState: "WAITING_FOR_REVIEW",
  outcome: "locked",
  message: MESSAGE,
};

const STORE_MD = `# Store metadata

## Listing

- Name: PII Shield
- Summary: Hide personal information on every open tab with one click.
- Description:

  Click PII Shield and names are blurred on every open tab.
`;

describe("sync-listing answers a locked App Store listing as locked", () => {
  const platform = useProjectRoutes("extdev-sync-locked-");

  it("says the lock, sends no forced resend and never says to sync again", async () => {
    if (process.platform === "win32") return;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-locked-"));
    fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/safari/submissions/preflight`] = () => ({ body: { checks: [] } });
    platform.routes[`PUT ${PROJECT_ROUTE}/stores/safari/listing`] = () => ({
      body: { ok: true, store: "safari", changes: [], appStoreConnect: LOCKED },
    });

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["safari"], projectPath: root, approvalId: "apr_s", api: API }));

    expect(platform.sent("PUT", `${PROJECT_ROUTE}/stores/safari/listing`)).toHaveLength(1);
    expect(out.value.stores.safari.appStoreConnect).toMatchObject({ status: "locked", lockedVersion: "0.3.0", lockedState: "WAITING_FOR_REVIEW" });
    expect(out.value.sayToPerson).toContain(MESSAGE);
    expect(out.value.sayToPerson).not.toContain("sync-listing");
  });
});
