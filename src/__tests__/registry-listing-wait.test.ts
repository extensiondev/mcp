import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/* @invariant The release publishes the tarball and then asks npm for it, and
   npm has served a fresh version anywhere from seconds to several minutes
   later. On 2026-09-25 the 10.10.0 tarball took longer than the 150 s this
   script used to wait, so the listing step failed on a release that had
   already shipped and the repair lane had to run by hand. The budget below is
   the floor that covers every propagation measured so far. */
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
