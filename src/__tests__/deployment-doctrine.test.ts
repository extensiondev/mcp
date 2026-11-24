// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEPLOYMENT_DOCTRINE, serverInstructions } from "../index";
import { actionFingerprint } from "../lib/approval-gate";
import { APPROVAL_OPENED_SENTENCE, canAutoOpen, forgetOpenedApprovals, openApprovalOnce, openableUrl, osOpen, osOpenCommand, setApprovalOpener } from "../lib/approval-open";
import { envelope } from "../lib/envelope";
import { WORLD_API, WORLD_PROJECT_ID, usePlatformWorld } from "./fixtures/platform-world";

const PLATFORM_ON = { features: ["local", "platform"] as Array<"local" | "platform">, noShip: false };
const PREFLIGHT = new RegExp(`^POST /api/projects/${WORLD_PROJECT_ID}/stores/chrome/submissions/preflight$`);
const SUBMIT = /^POST \/api\/cli\/stores\/submit$/;
const SUBMIT_ARGS = { action: "submit", browsers: ["chrome"], buildSha: "603fc8a", dryRun: false, api: WORLD_API };
const DESKTOP = { HOME: "/Users/person" };
const ORDER = [
  "Anything that leaves the person's machine goes through extension.dev",
  "extension_build is for the person's own machine only",
  "A store's version refusal is the platform's to absorb",
  "After any stop that asked the person for one action (connect, link, approve)",
];

function approvalAnswer(approvalId: string): string {
  return envelope({
    ok: false,
    command: "extension_submit",
    status: "approval-required",
    error: { code: "E_APPROVAL_REQUIRED", message: "A workspace owner approves this submission first." },
    value: { approvalId, approvalUrl: `${WORLD_API}/device/approve/${approvalId}`, expiresAt: "2026-10-19T21:00:00.000Z" },
    hint: `Approve at ${WORLD_API}/device/approve/${approvalId}.`,
  });
}

function approved(world: ReturnType<typeof usePlatformWorld>, approvalId: string): void {
  world.routes.push([
    new RegExp(`^GET /api/cli/approvals/${approvalId}$`),
    () => ({
      body: {
        status: "approved",
        used: false,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        fingerprint: actionFingerprint("extension_submit", { browsers: ["chrome"], buildSha: "603fc8a" }),
      },
    }),
  ]);
}

describe("the deployment doctrine sits in the server instructions, in order, beside the extension.dev-first rule", () => {
  const text = serverInstructions(PLATFORM_ON);
  const lines = text.split("\n");

  it("carries four lines between the extension.dev-first line and the Chrome goal playbook", () => {
    expect(DEPLOYMENT_DOCTRINE.length).toBeLessThan(8);

    const first = lines.findIndex((line) => line.includes("lead with extension.dev"));
    const goal = lines.findIndex((line) => line.startsWith("Chrome Web Store goal:"));
    let at = first;

    for (const opening of ORDER) {
      const next = lines.findIndex((line) => line.startsWith(opening));

      expect(next, opening).toBeGreaterThan(at);
      at = next;
    }

    expect(at).toBeLessThan(goal);
  });

  it("routes everything that leaves the machine to the platform build, extension_publish and extension_submit, with stores only on demand", () => {
    const rule = lines.find((line) => line.startsWith(ORDER[0])) ?? "";

    expect(rule).toMatch(/platform build \(extension_builds\)/);
    expect(rule).toMatch(/links from extension_publish/);
    expect(rule).toMatch(/stores from extension_submit/);
    expect(rule).toMatch(/a store is touched only when the person asks for a store/);
  });

  it("answers 'give me the zip to send to my tester' with the platform, never the extension_build output", () => {
    const rule = lines.find((line) => line.startsWith(ORDER[1])) ?? "";

    expect(rule).toMatch(/never offer its output, a zip or a dist folder/);

    for (const word of ["share", "send", "test with someone", "submit"]) {
      expect(rule).toContain(word);
    }

    expect(rule).toMatch(/route to the platform, a link from extension_publish or a store act from extension_submit/);
  });

  it("keeps a store version refusal on the platform and re-runs preflight after a one-action stop", () => {
    const version = lines.find((line) => line.startsWith(ORDER[2])) ?? "";
    const resume = lines.find((line) => line.startsWith(ORDER[3])) ?? "";

    expect(version).toMatch(/never tell the person to edit the manifest and rebuild locally/);
    expect(resume).toMatch(/the next message re-runs extension_submit_check action:'preflight' without being told/);
  });

  it("is absent when the platform tools are off", () => {
    expect(serverInstructions()).not.toContain(ORDER[0]);
  });

  it("the Chrome goal playbook calls preflight on the next message instead of waiting to be told", () => {
    expect(text).not.toMatch(/says they are back|say they connected/);

    for (const step of ["2. On store-not-connected", "3. On store-item-not-linked"]) {
      const line = lines.find((entry) => entry.startsWith(step)) ?? "";

      expect(line, step).toContain("on the person's next message, call preflight again.");
    }
  });
});

describe("an approval page opens itself once in the person's browser", () => {
  const world = usePlatformWorld("extdev-doctrine-open-");
  const opened: string[] = [];
  let restore: () => void = () => undefined;

  beforeEach(() => {
    opened.length = 0;
    forgetOpenedApprovals();
    restore = setApprovalOpener((url) => {
      opened.push(url);

      return true;
    });

    vi.stubEnv("CI", "");
    vi.stubEnv("EXTENSION_HEADLESS", "");
    vi.stubEnv("EXTENSION_BROWSER_FLAGS", "");
    vi.stubEnv("EXTENSION_DEV_NO_AUTO_OPEN", "");
    vi.stubEnv("DISPLAY", ":0");
  });

  afterEach(() => {
    restore();
    vi.unstubAllEnvs();
  });

  it("opens a forwarded approval page once through the local server and says so in the hint", async () => {
    if (process.platform === "win32") return;

    world.login();
    world.routes.push([/^POST \/api\/cli\/forward\/exchange$/, () => ({ body: { access_token: "forward-credential", expires_in: 600 } })]);
    world.routes.push([/^POST \/mcp\/forward$/, () => ({ body: JSON.parse(approvalAnswer("apr_open")) })]);

    const first = await world.call("extension_submit", SUBMIT_ARGS, { openApprovals: true });
    const second = await world.call("extension_submit", SUBMIT_ARGS, { openApprovals: true });
    const unopened = await world.call("extension_submit", SUBMIT_ARGS);

    expect(first.status).toBe("approval-required");
    expect(opened).toEqual([`${WORLD_API}/device/approve/apr_open`]);
    expect(first.hint).toContain(APPROVAL_OPENED_SENTENCE);
    expect(first.value.approvalOpened).toBe(true);
    expect(second.hint ?? "").not.toContain(APPROVAL_OPENED_SENTENCE);
    expect(unopened.status).toBe("approval-required");
    expect(unopened.hint ?? "").not.toContain(APPROVAL_OPENED_SENTENCE);
  });

  it("does not open with EXTENSION_DEV_NO_AUTO_OPEN=1", () => {
    vi.stubEnv("EXTENSION_DEV_NO_AUTO_OPEN", "1");

    const out = JSON.parse(openApprovalOnce(approvalAnswer("apr_env"), { noShip: false }));

    expect(opened).toEqual([]);
    expect(out.hint).not.toContain(APPROVAL_OPENED_SENTENCE);
  });

  it("does not open under --no-ship", () => {
    openApprovalOnce(approvalAnswer("apr_noship"), { noShip: true });

    expect(opened).toEqual([]);
  });

  it.each([
    ["headless", { ...DESKTOP, EXTENSION_HEADLESS: "1" }, "darwin"],
    ["headless by flags", { ...DESKTOP, EXTENSION_BROWSER_FLAGS: "--headless=new" }, "darwin"],
    ["CI", { ...DESKTOP, CI: "true" }, "darwin"],
    ["Linux with no display", { ...DESKTOP }, "linux"],
  ] as const)("does not open when %s", (_label, env, platform) => {
    expect(canAutoOpen({ noShip: false }, env, platform)).toBe(false);
    openApprovalOnce(approvalAnswer(`apr_${platform}_${Object.keys(env).join("_")}`), { noShip: false }, env, platform);

    expect(opened).toEqual([]);
  });

  it("opens on a desktop, Linux included when a display is set", () => {
    expect(canAutoOpen({ noShip: false }, DESKTOP, "darwin")).toBe(true);
    expect(canAutoOpen({ noShip: false }, { ...DESKTOP, WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
  });

  it("uses the OS opener for each platform", () => {
    expect(osOpenCommand("https://x.test/a", "darwin")).toEqual(["open", ["https://x.test/a"]]);
    expect(osOpenCommand("https://x.test/a", "linux")).toEqual(["xdg-open", ["https://x.test/a"]]);
    expect(osOpenCommand("https://x.test/a?b=1&c=2", "win32")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", "https://x.test/a?b=1&c=2"]]);
  });

  it("897: hands the OS opener one argument and no shell, on Windows too", () => {
    const hostile = "https://x.test/a?b=%USERPROFILE%&c=1|d";

    for (const platform of ["darwin", "linux", "win32"] as const) {
      const [command, args] = osOpenCommand(hostile, platform);

      expect(command, platform).not.toMatch(/^(cmd|powershell|pwsh|sh|bash)(\.exe)?$/i);
      expect(args[args.length - 1], platform).toBe(hostile);
      expect(args.join(" "), platform).not.toContain("^");
    }
  });

  it("897: opens only an https page, or an http page on this machine, and hands the opener its parsed form", () => {
    expect(openableUrl("https://www.extension.dev/device/approve/apr_a")).toBe("https://www.extension.dev/device/approve/apr_a");
    expect(openableUrl("http://localhost:3100/device/approve/apr_a")).toBe("http://localhost:3100/device/approve/apr_a");
    expect(openableUrl('https://x.test/a b"c\n?d=<e>')).toBe("https://x.test/a%20b%22c?d=%3Ce%3E");

    for (const refused of ["file:///Applications/Calculator.app", "-a Calculator", "-aCalculator", "javascript:alert(1)", "http://example.com/a", "https://person:secret@x.test/a", "calc.exe", "", "https://"]) {
      expect(openableUrl(refused), refused).toBe("");
      expect(osOpen(refused), refused).toBe(false);
    }
  });

  it("opens a local dev console or www host over http only when the configured platform origin is that local host", () => {
    const saved = process.env.EXTENSION_DEV_API_URL;

    try {
      process.env.EXTENSION_DEV_API_URL = "https://www.extension.dev";
      expect(openableUrl("http://console.extension.localhost/a")).toBe("");

      process.env.EXTENSION_DEV_API_URL = "http://localhost:3100";
      expect(openableUrl("http://console.extension.localhost/a")).toBe("http://console.extension.localhost/a");
      expect(openableUrl("http://docs.extension.localhost/a")).toBe("");
      expect(openableUrl("http://console.extension.localhost.evil.test/a")).toBe("");
    } finally {
      if (saved === undefined) delete process.env.EXTENSION_DEV_API_URL;
      else process.env.EXTENSION_DEV_API_URL = saved;
    }
  });

  it("897: does not open an approval page on a host that is neither extension.dev nor the configured platform", () => {
    const answer = (approvalId: string, approvalUrl: string) => envelope({ ok: false, command: "extension_submit", status: "approval-required", error: { code: "E_APPROVAL_REQUIRED", message: "x" }, value: { approvalId, approvalUrl } });

    for (const [index, foreign] of ["https://evil.test/device/approve/apr_a", "https://www.extension.dev.evil.test/device/approve/apr_a", "https://www.extension.dev@evil.test/device/approve/apr_a", "https://evilextension.dev/device/approve/apr_a", "HTTPS://evil.test/%USERPROFILE%"].entries()) {
      const raw = answer(`apr_foreign_${index}`, foreign);

      expect(openApprovalOnce(raw, { noShip: false }, DESKTOP, "darwin"), foreign).toBe(raw);
    }

    expect(opened).toEqual([]);

    openApprovalOnce(answer("apr_home", "https://console.extension.dev/acme/web/approvals/apr_home"), { noShip: false }, DESKTOP, "darwin");
    vi.stubEnv("EXTENSION_DEV_API_URL", "https://platform.example.test");
    openApprovalOnce(answer("apr_configured", "https://platform.example.test/device/approve/apr_configured"), { noShip: false }, DESKTOP, "darwin");

    expect(opened).toEqual(["https://console.extension.dev/acme/web/approvals/apr_home", "https://platform.example.test/device/approve/apr_configured"]);
  });
});
