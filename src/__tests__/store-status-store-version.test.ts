import { describe, expect, it } from "vitest";

import { latestSubmissionsByStore } from "../tools/store-status";

describe("the store status read carries the platform stamp the mirror recorded", () => {
  it("answers storeVersion and storeCrxVersion from the submission row", () => {
    const out = latestSubmissionsByStore({
      submissions: [
        {
          id: "sub_1",
          store: "chrome",
          status: "draft",
          version: "0.1.0",
          buildSha: "111d167",
          submittedAt: "2026-10-20T03:41:41.000Z",
          storeVersion: { packaged: "0.1.0.3", displayed: "0.1.0", source: "platform", buildNumber: 3 },
          storeCrxVersion: "0.1.0.3",
        },
      ],
    });

    expect(out.chrome.storeVersion).toEqual({ packaged: "0.1.0.3", displayed: "0.1.0", source: "platform", buildNumber: 3 });
    expect(out.chrome.storeCrxVersion).toBe("0.1.0.3");
  });

  it("drops a malformed stamp instead of inventing one", () => {
    const out = latestSubmissionsByStore({
      submissions: [
        { id: "sub_2", store: "chrome", status: "draft", version: "0.1.0", submittedAt: "2026-10-20T03:41:41.000Z", storeVersion: { packaged: "0.1.0.4" }, storeCrxVersion: 7 },
      ],
    });

    expect(out.chrome.storeVersion).toBeUndefined();
    expect(out.chrome.storeCrxVersion).toBeUndefined();
  });
});
