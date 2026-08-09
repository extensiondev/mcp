import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_COMMIT = "f7f4e6efb56a7e5ae08d58dbff3972d94af7d021";

let scaffoldTarget = "";
let writeManifest = true;

vi.mock("extension-create", () => ({
  extensionCreate: vi.fn(async (_input: string, opts: { template: string }) => {
    fs.mkdirSync(scaffoldTarget, { recursive: true });
    if (writeManifest) {
      fs.writeFileSync(path.join(scaffoldTarget, "manifest.json"), "{}");
    }
    return {
      projectPath: scaffoldTarget,
      projectName: path.basename(scaffoldTarget),
      template: opts.template,
      depsInstalled: true,
      packageManager: "pnpm",
    };
  }),
}));

const create = await import("../tools/create");
const { resetSessionIdentityForTests } = await import(
  "../lib/session-identity"
);

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-create-seed-"));
  tmpDirs.push(dir);
  return dir;
}

type Capture = { url: string; body: Record<string, unknown> };

let captures: Capture[] = [];

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "EXTENSION_DEV_API_URL",
  "EXTENSION_DEV_NO_TELEMETRY",
  "DO_NOT_TRACK",
  "EXTENSION_DEV_POSTHOG_KEY",
  "EXTENSION_TEMPLATES_COMMIT",
];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.EXTENSION_TEMPLATES_COMMIT = TEST_COMMIT;
  captures = [];
  writeManifest = true;
  resetSessionIdentityForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      captures.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  resetSessionIdentityForTests();
});

async function seedCaptures(): Promise<Capture[]> {
  await vi.waitFor(
    () => {
      const seeds = captures.filter((c) => c.body.event === "draft_seeded");
      expect(seeds.length).toBeGreaterThan(0);
      return seeds;
    },
    { timeout: 2000, interval: 10 },
  );
  return captures.filter((c) => c.body.event === "draft_seeded");
}

describe("extension_create seeds the creation funnel", () => {
  it("emits draft_seeded once with the mcp entry and the template ref", async () => {
    const parent = tmpDir();
    scaffoldTarget = path.join(parent, "probe");

    const result = JSON.parse(
      await create.handler({
        projectName: "probe",
        parentDir: parent,
        template: "react",
      }),
    );
    expect(result.ok).toBe(true);

    const seeds = await seedCaptures();
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.url).toBe("https://us.i.posthog.com/capture/");
    expect(seeds[0]!.body.properties).toMatchObject({
      seed_source: "template",
      seed_slug: "react",
      seed_ref: `react@${TEST_COMMIT}`,
      entry: "mcp",
      environment: "production",
      emitted_from: "node",
      source: "@extension.dev/mcp",
      $process_person_profile: false,
    });
  });

  it("names the default template when the caller passed none", async () => {
    const parent = tmpDir();
    scaffoldTarget = path.join(parent, "probe");

    await create.handler({ projectName: "probe", parentDir: parent });

    const seeds = await seedCaptures();
    expect(seeds[0]!.body.properties).toMatchObject({
      seed_slug: "typescript",
      seed_ref: `typescript@${TEST_COMMIT}`,
    });
  });

  it("does not seed a scaffold that produced no manifest", async () => {
    writeManifest = false;
    const parent = tmpDir();
    scaffoldTarget = path.join(parent, "probe");

    const result = JSON.parse(
      await create.handler({ projectName: "probe", parentDir: parent }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_SCAFFOLD_INCOMPLETE");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(captures.filter((c) => c.body.event === "draft_seeded")).toHaveLength(
      0,
    );
  });

  it("does not seed when the caller opted out of telemetry", async () => {
    process.env.EXTENSION_DEV_NO_TELEMETRY = "1";
    const parent = tmpDir();
    scaffoldTarget = path.join(parent, "probe");

    const result = JSON.parse(
      await create.handler({ projectName: "probe", parentDir: parent }),
    );

    expect(result.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(captures.filter((c) => c.body.event === "draft_seeded")).toHaveLength(
      0,
    );
  });
});
