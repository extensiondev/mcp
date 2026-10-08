import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const NPM_PROPAGATION_FLOOR_SECONDS = 600;

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
    expect(attempts * seconds).toBeGreaterThanOrEqual(NPM_PROPAGATION_FLOOR_SECONDS);
  });
});
