import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* @invariant The release publishes the tarball and then asks npm for it. The
   budget below is the floor that covers every propagation measured so far. */
const MIN_WAIT_SECONDS = 600;

describe("the registry listing waits long enough for npm to serve the tarball it describes", () => {
  it("budgets at least ten minutes before it gives up", () => {
    const script = fs.readFileSync(
      fileURLToPath(new URL("../../scripts/publish-mcp-registry.sh", import.meta.url)),
      "utf8",
    );
    const attempts = Number(script.match(/^NPM_WAIT_ATTEMPTS=(\d+)$/m)?.[1]);
    const seconds = Number(script.match(/^NPM_WAIT_SECONDS=(\d+)$/m)?.[1]);
    expect(attempts).toBeGreaterThan(0);
    expect(seconds).toBeGreaterThan(0);
    expect(attempts * seconds).toBeGreaterThanOrEqual(MIN_WAIT_SECONDS);
    expect(script).toContain('for attempt in $(seq 1 "$NPM_WAIT_ATTEMPTS")');
    expect(script).toContain('sleep "$NPM_WAIT_SECONDS"');
  });
});
