import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface CliResponse {
  code: number;
  stdout: string;
  stderr: string;
}

const cliCalls: string[][] = [];
let cliResponder: ((args: string[]) => CliResponse) | null = null;

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);
      return (
        cliResponder?.(args) ?? { code: 0, stdout: "", stderr: "" }
      );
    },
  };
});

const engineVersion = await import("../lib/engine-version");
const build = await import("../tools/build");

/* @invariant Two fixtures because two generations of engine word the refusal
   differently. The lowercase commander line is what every pre-redesign engine
   actually prints and stays as the old-engine simulation. The styled line with
   the glyph prefix and the remedy after it is what the redesigned CLI prints
   for an unknown option, held here so the matcher cannot quietly narrow back
   to one phrasing. */
const UNKNOWN_OUTPUT = "error: unknown option '--output'";
const UNKNOWN_OUTPUT_REDESIGNED =
  "⏵⏵⏵ Unknown option --output.\nRun extension build --help to see the options.";

const MANIFEST = {
  manifest_version: 3,
  name: "Reading List",
  version: "1.0.0",
  description: "A reading list",
};

const tmpDirs: string[] = [];

function projectWithLocalEngine(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-probe-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify(MANIFEST),
  );
  const bin = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(
    bin,
    process.platform === "win32" ? "extension.cmd" : "extension",
  );
  fs.writeFileSync(exe, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(exe, 0o755);
  const dist = path.join(dir, "dist", "chrome");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(MANIFEST));
  return dir;
}

function persistSummary(dir: string, summary: Record<string, unknown>): void {
  const target = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, "build-summary.json");
  fs.writeFileSync(file, JSON.stringify(summary));
  const ahead = new Date(Date.now() + 2000);
  fs.utimesSync(file, ahead, ahead);
}

/* @invariant Every pre-capabilities engine these helpers simulate must refuse
   `capabilities` the way a real one does, with a non-zero exit and no schema-1
   frame, or the tests would quietly stop exercising the fallback chain they
   exist to pin. */
const CAPABILITIES_UNKNOWN: CliResponse = {
  code: 1,
  stdout: "",
  stderr: "error: unknown command 'capabilities'",
};

const CAPABILITIES_ROSTER = [
  "build",
  "capabilities",
  "create",
  "dev",
  "doctor",
  "eval",
  "inspect",
  "install",
  "logs",
  "open",
  "preview",
  "publish",
  "reload",
  "start",
  "storage",
  "telemetry",
];

function capabilitiesFrame(
  version: string,
  roster: string[] = CAPABILITIES_ROSTER,
): string {
  return JSON.stringify({
    schema: 1,
    ok: true,
    command: "capabilities",
    status: "ok",
    value: {
      name: "extension",
      version,
      envelopeSchema: 1,
      readySchemaVersion: 2,
      outputJsonCommands: roster,
    },
    error: null,
    warnings: [],
  });
}

function engine(version: string, onBuild: CliResponse) {
  return (args: string[]): CliResponse => {
    if (args[0] === "capabilities") return CAPABILITIES_UNKNOWN;
    if (args[0] === "--version") {
      return { code: 0, stdout: `${version}\n`, stderr: "" };
    }
    return onBuild;
  };
}

function engineBelowTheFloor(version: string, onBuild: CliResponse) {
  return (args: string[]): CliResponse => {
    if (args[0] === "capabilities") return CAPABILITIES_UNKNOWN;
    if (args[0] === "--version") {
      return { code: 0, stdout: `${version}\n`, stderr: "" };
    }
    if (args.includes("--output")) {
      return { code: 1, stdout: "", stderr: UNKNOWN_OUTPUT };
    }
    return onBuild;
  };
}

function engineWithCapabilities(
  version: string,
  onBuild: CliResponse,
  roster: string[] = CAPABILITIES_ROSTER,
) {
  return (args: string[]): CliResponse => {
    if (args[0] === "capabilities") {
      return { code: 0, stdout: `${capabilitiesFrame(version, roster)}\n`, stderr: "" };
    }
    if (args[0] === "--version") {
      return { code: 0, stdout: `${version}\n`, stderr: "" };
    }
    return onBuild;
  };
}

const PROBE_ARGS = new Set(["--version", "capabilities"]);
const buildCalls = () => cliCalls.filter((args) => !PROBE_ARGS.has(args[0]));
const probeCalls = () => cliCalls.filter((args) => args[0] === "--version");
const capabilityCalls = () =>
  cliCalls.filter((args) => args[0] === "capabilities");

const run = async (args: Parameters<typeof build.handler>[0]) =>
  JSON.parse(await build.handler(args));

beforeEach(() => {
  engineVersion.resetEngineVersionCache();
});

afterEach(() => {
  cliCalls.length = 0;
  cliResponder = null;
  engineVersion.resetEngineVersionCache();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("compareVersions follows semver precedence on real engine shapes", () => {
  const cmp = (a: string, b: string) => engineVersion.compareVersions(a, b);

  it("orders the releases this engine actually tagged", () => {
    expect(cmp("4.0.16", "4.0.17")).toBeLessThan(0);
    expect(cmp("4.0.17", "4.0.18")).toBeLessThan(0);
    expect(cmp("3.18.1", "4.0.16")).toBeLessThan(0);
    expect(cmp("4.0.17", "4.0.17")).toBe(0);
  });

  it("does not compare version strings lexically", () => {
    expect(cmp("4.0.9", "4.0.17")).toBeLessThan(0);
    expect(cmp("3.18.1", "3.9.0")).toBeGreaterThan(0);
  });

  it("ranks a canary above the release it follows", () => {
    const canary = "4.0.19-canary.1785200797.ce99a79e";
    expect(cmp(canary, "4.0.17")).toBeGreaterThan(0);
    expect(cmp(canary, "4.0.18")).toBeGreaterThan(0);
    expect(cmp(canary, "3.18.1")).toBeGreaterThan(0);
    expect(cmp(canary, "4.0.19")).toBeLessThan(0);
  });

  it("ranks a prerelease below its own release", () => {
    expect(cmp("4.0.17-canary.1", "4.0.17")).toBeLessThan(0);
    expect(cmp("4.0.17-canary.1", "4.0.17-canary.2")).toBeLessThan(0);
    expect(cmp("4.0.17-canary.2", "4.0.17-canary.10")).toBeLessThan(0);
  });

  it("orders numeric identifiers that collide as doubles", () => {
    expect(Number("9007199254740993") - Number("9007199254740992")).toBe(0);
    expect(
      cmp("4.0.19-canary.9007199254740993", "4.0.19-canary.9007199254740992"),
    ).toBeGreaterThan(0);
    expect(
      cmp("4.0.19-canary.9007199254740992", "4.0.19-canary.9007199254740993"),
    ).toBeLessThan(0);
  });

  it("ranks numeric identifiers below alphanumeric ones", () => {
    expect(cmp("4.0.19-canary.1", "4.0.19-canary.alpha")).toBeLessThan(0);
    expect(cmp("4.0.19-canary", "4.0.19-canary.1")).toBeLessThan(0);
  });

  it("ignores build metadata and a leading v", () => {
    expect(cmp("v4.0.17", "4.0.17")).toBe(0);
    expect(cmp("4.0.17+build.5", "4.0.17")).toBe(0);
  });

  it("answers null rather than guessing at an unparseable version", () => {
    expect(cmp("latest", "4.0.17")).toBeNull();
    expect(cmp("4.0", "4.0.17")).toBeNull();
    expect(cmp("", "4.0.17")).toBeNull();
  });
});

describe("parseVersion only trusts a line that is a version", () => {
  it("reads the bare version the CLI prints", () => {
    expect(engineVersion.parseVersion("4.0.18\n")).toBe("4.0.18");
    expect(
      engineVersion.parseVersion("4.0.19-canary.1785200797.ce99a79e\n"),
    ).toBe("4.0.19-canary.1785200797.ce99a79e");
  });

  it("refuses a version quoted inside a sentence", () => {
    expect(
      engineVersion.parseVersion(
        "Extension.js requires Node 22.12.0 or newer, found 20.11.1.",
      ),
    ).toBeNull();
  });
});

describe("refusedTheOutputFlag reads both generations of the refusal", () => {
  const refused = engineVersion.refusedTheOutputFlag;

  it("matches the pre-redesign commander phrasing", () => {
    expect(refused(UNKNOWN_OUTPUT)).toBe(true);
  });

  it("matches the redesigned styled phrasing", () => {
    expect(refused(UNKNOWN_OUTPUT_REDESIGNED)).toBe(true);
  });

  it("ignores a refusal of a flag the caller chose", () => {
    expect(refused("error: unknown option '--macos-only'")).toBe(false);
    expect(
      refused(
        "⏵⏵⏵ Unknown option --macos-only.\nRun extension build --help to see the options.",
      ),
    ).toBe(false);
  });

  it("ignores a failure that merely mentions the word output", () => {
    expect(
      refused("ERROR in ./src/output.js: cannot resolve --output-path"),
    ).toBe(false);
  });
});

describe("the build probes the engine before it spends a compile", () => {
  it("skips the flag entirely when the probe says the engine is too old", async () => {
    const dir = projectWithLocalEngine();
    persistSummary(dir, { browser: "chrome", size: 1234, warnings: [] });
    cliResponder = engineBelowTheFloor("4.0.16", {
      code: 0,
      stdout: "",
      stderr: "",
    });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(probeCalls()).toHaveLength(1);
    expect(buildCalls()).toHaveLength(1);
    expect(buildCalls()[0]).not.toContain("--output");
  });

  it("warns about the old engine without claiming a second build", async () => {
    const dir = projectWithLocalEngine();
    persistSummary(dir, { browser: "chrome", size: 1234, warnings: [] });
    cliResponder = engineBelowTheFloor("4.0.16", {
      code: 0,
      stdout: "",
      stderr: "",
    });

    const result = await run({ projectPath: dir, browser: "chrome" });
    const warned = (result.warnings ?? []).join(" ");

    expect(warned).toContain("older than the one this server expects");
    expect(warned).toContain("4.0.16");
    expect(warned).toContain("4.0.17");
    expect(warned).toContain("nothing was built twice");
    expect(warned).not.toContain("a second time");
    expect(warned).not.toContain("stop paying for the second build");
  });

  it("sends the flag when the probe says the engine is new enough", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engine("4.0.19-canary.1785200797.ce99a79e", {
      code: 0,
      stdout: "",
      stderr: "",
    });

    await run({ projectPath: dir, browser: "chrome" });

    expect(buildCalls()).toHaveLength(1);
    expect(buildCalls()[0]).toContain("--output");
  });

  it("treats the floor release itself as new enough", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engine("4.0.17", { code: 0, stdout: "", stderr: "" });

    await run({ projectPath: dir, browser: "chrome" });

    expect(buildCalls()[0]).toContain("--output");
  });

  it("falls through to the retry when the probe cannot be read", async () => {
    const dir = projectWithLocalEngine();
    persistSummary(dir, { browser: "chrome", size: 1234, warnings: [] });
    cliResponder = (args) => {
      if (args[0] === "--version") {
        return { code: 1, stdout: "", stderr: "spawn ENOENT" };
      }
      return args.includes("--output")
        ? { code: 1, stdout: "", stderr: UNKNOWN_OUTPUT }
        : { code: 0, stdout: "", stderr: "" };
    };

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(buildCalls()).toHaveLength(2);
    expect(buildCalls()[0]).toContain("--output");
    expect(buildCalls()[1]).not.toContain("--output");
    expect((result.warnings ?? []).join(" ")).toContain(
      "stop paying for the second build",
    );
  });

  it("falls through to the retry when the version is unparseable", async () => {
    const dir = projectWithLocalEngine();
    persistSummary(dir, { browser: "chrome", size: 1234, warnings: [] });
    cliResponder = (args) => {
      if (args[0] === "--version") {
        return { code: 0, stdout: "unknown\n", stderr: "" };
      }
      return args.includes("--output")
        ? { code: 1, stdout: "", stderr: UNKNOWN_OUTPUT }
        : { code: 0, stdout: "", stderr: "" };
    };

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(buildCalls()).toHaveLength(2);
  });

  it("retries a refusal worded the redesigned way just like the old one", async () => {
    const dir = projectWithLocalEngine();
    persistSummary(dir, { browser: "chrome", size: 1234, warnings: [] });
    cliResponder = (args) => {
      if (args[0] === "capabilities") return CAPABILITIES_UNKNOWN;
      if (args[0] === "--version") {
        return { code: 0, stdout: "unknown\n", stderr: "" };
      }
      return args.includes("--output")
        ? { code: 1, stdout: "", stderr: UNKNOWN_OUTPUT_REDESIGNED }
        : { code: 0, stdout: "", stderr: "" };
    };

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(buildCalls()).toHaveLength(2);
    expect(buildCalls()[0]).toContain("--output");
    expect(buildCalls()[1]).not.toContain("--output");
  });

  it("still reports a real compile failure rather than probing it away", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineBelowTheFloor("4.0.16", {
      code: 1,
      stdout: "",
      stderr: "Module not found: ./nope.js",
    });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_BUILD_FAILED");
    expect(buildCalls()).toHaveLength(1);
  });
});

describe("an engine that answers capabilities is judged from its own roster", () => {
  it("reads the version and the roster from one exec and never asks --version", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineWithCapabilities("4.0.20", {
      code: 0,
      stdout: "",
      stderr: "",
    });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(capabilityCalls()).toHaveLength(1);
    expect(probeCalls()).toHaveLength(0);
    expect(buildCalls()).toHaveLength(1);
    expect(buildCalls()[0]).toContain("--output");
  });

  it("answers resolvedEngineVersion from the envelope's own version", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineWithCapabilities("4.0.20", {
      code: 0,
      stdout: "",
      stderr: "",
    });

    const version = await engineVersion.resolvedEngineVersion(dir);

    expect(version).toBe("4.0.20");
    expect(capabilityCalls()).toHaveLength(1);
    expect(probeCalls()).toHaveLength(0);
  });

  /* @invariant The roster outranks the floor table. A version far above every
     floor whose roster does not name the command must still be judged
     unsupported, because the roster is read off the engine's live
     registrations and the table is kept by hand in this repository. */
  it("lets the roster overrule a version the floor table would wave through", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineWithCapabilities(
      "9.9.9",
      { code: 0, stdout: "", stderr: "" },
      ["capabilities", "doctor"],
    );

    const verdict = await engineVersion.outputJsonVerdict("build", dir);

    expect(verdict.supported).toBe(false);
    expect(verdict.version).toBe("9.9.9");
  });

  it("judges the act family by every verb it covers", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineWithCapabilities("4.0.20", {
      code: 0,
      stdout: "",
      stderr: "",
    });

    const verdict = await engineVersion.outputJsonVerdict("act", dir);

    expect(verdict.supported).toBe(true);
  });

  it("downgrades the act family when the roster drops one verb", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineWithCapabilities(
      "4.0.20",
      { code: 0, stdout: "", stderr: "" },
      CAPABILITIES_ROSTER.filter((name) => name !== "reload"),
    );

    const verdict = await engineVersion.outputJsonVerdict("act", dir);

    expect(verdict.supported).toBe(false);
  });

  it("caches the capabilities answer for a burst of builds", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineWithCapabilities("4.0.20", {
      code: 0,
      stdout: "",
      stderr: "",
    });

    await run({ projectPath: dir, browser: "chrome" });
    await run({ projectPath: dir, browser: "chrome" });

    expect(capabilityCalls()).toHaveLength(1);
    expect(buildCalls()).toHaveLength(2);
  });

  it("falls back to the version probe when the command is unknown", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = engineBelowTheFloor("4.0.16", {
      code: 0,
      stdout: "",
      stderr: "",
    });
    persistSummary(dir, { browser: "chrome", size: 1234, warnings: [] });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(capabilityCalls()).toHaveLength(1);
    expect(probeCalls()).toHaveLength(1);
    expect(buildCalls()[0]).not.toContain("--output");
  });

  it("does not believe an exit-zero frame that is not the capabilities answer", async () => {
    const dir = projectWithLocalEngine();
    cliResponder = (args) => {
      if (args[0] === "capabilities") {
        return {
          code: 0,
          stdout: JSON.stringify({
            schema: 1,
            ok: true,
            command: "build",
            status: "ok",
            value: null,
            error: null,
            warnings: [],
          }),
          stderr: "",
        };
      }
      if (args[0] === "--version") {
        return { code: 0, stdout: "4.0.18\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const verdict = await engineVersion.outputJsonVerdict("build", dir);

    expect(verdict.supported).toBe(true);
    expect(verdict.version).toBe("4.0.18");
    expect(probeCalls()).toHaveLength(1);
  });
});

describe("the verdict is cached so a build does not pay for a probe", () => {
  it("probes once for two builds of the same project", async () => {
    const dir = projectWithLocalEngine();
    persistSummary(dir, { browser: "chrome", size: 1234, warnings: [] });
    cliResponder = engineBelowTheFloor("4.0.16", {
      code: 0,
      stdout: "",
      stderr: "",
    });

    await run({ projectPath: dir, browser: "chrome" });
    await run({ projectPath: dir, browser: "chrome" });

    expect(probeCalls()).toHaveLength(1);
    expect(buildCalls()).toHaveLength(2);
    for (const call of buildCalls()) expect(call).not.toContain("--output");
  });

  it("keys the cache on the resolved binary, not on the project", async () => {
    const older = projectWithLocalEngine();
    const newer = projectWithLocalEngine();
    persistSummary(older, { browser: "chrome", size: 1, warnings: [] });
    cliResponder = (args) => {
      if (args[0] === "--version") {
        const forOlder = cliCalls
          .filter((c) => c[0] === "--version")
          .length === 1;
        return {
          code: 0,
          stdout: forOlder ? "4.0.16\n" : "4.0.18\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    await run({ projectPath: older, browser: "chrome" });
    await run({ projectPath: newer, browser: "chrome" });

    expect(probeCalls()).toHaveLength(2);
    expect(buildCalls()[0]).not.toContain("--output");
    expect(buildCalls()[1]).toContain("--output");
  });

  it("re-probes once the cached verdict has expired", async () => {
    const dir = projectWithLocalEngine();
    persistSummary(dir, { browser: "chrome", size: 1234, warnings: [] });
    cliResponder = engine("4.0.16", { code: 0, stdout: "", stderr: "" });

    await engineVersion.resolvedEngineVersion(dir);
    expect(probeCalls()).toHaveLength(1);

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      await engineVersion.resolvedEngineVersion(dir);
    } finally {
      Date.now = realNow;
    }

    expect(probeCalls()).toHaveLength(2);
  });

  /* @invariant
   * The expected version is read from the pin, never retyped beside it.
   *
   * With no project-local binary the invocation is `npx extension@<spec>`, so
   * the version about to run is already in the argument and no probe is needed.
   * Writing that version into the assertion as a literal made this test fail
   * the moment the pin moved from a canary to its release, reporting a broken
   * probe when the only thing that had changed was a dependency bump. Reading
   * the same source the code reads keeps the test about the behaviour.
   */
  it("answers the npx fallback from the pinned spec without spawning", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-probe-npx-"));
    tmpDirs.push(dir);
    const pinned = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, "..", "..", "package.json"),
        "utf8",
      ),
    ).dependencies["extension-develop"];

    const version = await engineVersion.resolvedEngineVersion(dir);

    expect(probeCalls()).toHaveLength(0);
    expect(version).toBe(pinned);
  });
});
