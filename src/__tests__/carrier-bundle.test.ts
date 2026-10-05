import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  CARRIER_ALLOWED_ORIGINS_SENTENCE,
  CARRIER_REFUSAL_SENTENCE,
  CARRIER_TRUSTED_LOCAL_HOSTS,
  CARRIER_TRUSTED_LOCAL_PORTS,
  CARRIER_TRUSTED_ORIGINS,
} from "../lib/carrier";

const bundle = path.resolve(
  __dirname,
  "..",
  "..",
  "extensions",
  "live-preview",
  "chromium",
);
const worker = fs.readFileSync(
  path.join(bundle, "background", "service_worker.js"),
  "utf8",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"),
) as { externally_connectable?: { matches?: string[] } };

function externalListener(): string {
  const start = worker.indexOf("onMessageExternal.addListener(");
  expect(start).toBeGreaterThan(-1);

  return worker.slice(start, start + 600);
}

describe("the shipped carrier enforces what its sentence promises", () => {
  it("refuses an external message before reading it", () => {
    const listener = externalListener();

    expect(listener).toContain(CARRIER_REFUSAL_SENTENCE);
    expect(listener.indexOf(CARRIER_REFUSAL_SENTENCE)).toBeLessThan(
      listener.indexOf("getManifest"),
    );
  });

  it("names every trusted origin, host and port the sentence names", () => {
    for (const origin of CARRIER_TRUSTED_ORIGINS) {
      expect(worker).toContain(`"${origin}"`);
    }
    for (const host of CARRIER_TRUSTED_LOCAL_HOSTS) {
      expect(worker).toContain(`"${host}"`);
    }
    for (const port of CARRIER_TRUSTED_LOCAL_PORTS) {
      expect(worker).toContain(`"${port}"`);
    }
  });

  it("says in its sentence only what the bundle lists", () => {
    const matches = manifest.externally_connectable?.matches ?? [];
    for (const origin of CARRIER_TRUSTED_ORIGINS) {
      expect(matches).toContain(`${origin}/*`);
    }
    for (const host of CARRIER_TRUSTED_LOCAL_HOSTS) {
      expect(matches).toContain(`http://${host}/*`);
    }
    for (const port of CARRIER_TRUSTED_LOCAL_PORTS) {
      expect(CARRIER_ALLOWED_ORIGINS_SENTENCE).toContain(port);
    }
    expect(CARRIER_ALLOWED_ORIGINS_SENTENCE).toContain(
      "checks the sender's origin",
    );
  });
});
