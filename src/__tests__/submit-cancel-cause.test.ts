// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { failureLineOf } from "../lib/store-upload-words";
import { handler as submit } from "../tools/submit";
import { API, useProjectRoutes } from "./fixtures/project-routes";

const CAUSE =
  "The safari run was canceled before any store step ran, so no store received this submission, and the platform did not retry it, because a retry runs the same workflow and meets the same refusal. Why GitHub canceled it: GitHub refused the macos-14 runner image the workflow asks for: macOS 14 images are retired (GitHub cancels jobs on them during its scheduled brownouts before the retirement), so the job was canceled before a runner picked it up. Nothing reached the store; submitting safari again meets the same refusal until the project's store workflow stops asking for that runner image.";

describe("a submit whose run GitHub canceled answers the platform's cause once, in one sentence each", () => {
  const platform = useProjectRoutes("extdev-submit-cancel-cause-");

  it("drops the record's own closing period so the joined line never ends in two", () => {
    expect(failureLineOf("safari", undefined, "The run was canceled.")).toBe("safari: The run was canceled");
    expect(failureLineOf("safari", undefined, " The run was canceled. ")).toBe("safari: The run was canceled");
    expect(failureLineOf("safari", undefined, "...")).toBe("safari: the store run failed");
  });

  it("names why GitHub canceled the Safari run in the error, the warnings and the next step", async () => {
    if (process.platform === "win32") return;

    platform.login();
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.routes["POST /api/cli/stores/submit"] = () => ({ body: { ok: true, submissions: [{ id: "sub_sf", store: "safari", status: "pending" }] } });
    platform.routes["GET /api/cli/stores/submissions"] = () => ({ body: { submissions: [{ id: "sub_sf", store: "safari", status: "failed", failureReason: CAUSE }] } });

    const out = JSON.parse(await submit({ browsers: ["safari"], buildSha: "6b393ca", dryRun: false, api: API }));

    expect(out.status).toBe("submit-failed");
    expect(out.error.message).toContain("Why GitHub canceled it: GitHub refused the macos-14 runner image");
    expect(out.error.message).not.toContain("..");
    expect(out.error.message.endsWith("runner image.")).toBe(true);
    expect(JSON.stringify(out.warnings ?? [])).not.toContain("..");
    expect(out.value.nextStep.say).toContain("GitHub refused the macos-14 runner image");
    expect(out.value.nextStep.say).not.toContain("..");
  });
});
