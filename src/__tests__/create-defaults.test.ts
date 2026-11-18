import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

import { ENGINE_BIN_ENV, ENGINE_DIR_ENV } from "../lib/engine-override";
import { PINNED_COMMIT } from "../lib/template-artifact-source";
import { parseStoreMd } from "../lib/store-md";
import { reviewerNoteBuildLine } from "../lib/store-md-toolchain";
import { scaffoldScripts } from "./fixtures/scaffolder-answers";

let scaffoldTarget = "";
let withGit = false;
let withScripts = false;
let recordRef: string | null = null;
let refSeen: string | undefined;
let withStoreMd = false;
let depsLeftOut = false;

const SAMPLE_STORE_MD = `# Store metadata

## Listing

- Name: javascript

## Firefox Add-ons

### Reviewer notes

TODO the steps a reviewer follows to exercise the extension, with test
credentials when sign-in is required. Keep the build paragraph below: AMO
wants a reproducible build for a bundled package.

Build from source with Node 22.12.0 and npm 10.9.0 (replace both with the
output of node --version and npm --version on the machine that built the
upload): run npm install, then npx extension build --browser firefox. The
upload is dist/firefox, byte for byte. Upload the repository at the built
commit as the source archive.

### Release notes

TODO what changed for users in this version, in their words.
`;

vi.mock("extension-create", () => ({
  extensionCreate: vi.fn(async (_input: string, opts: { template: string; logger?: { log: (line: string) => void } }) => {
    opts.logger?.log("probe is ready.\n\nNext steps:\n  1. cd probe\n  2. npm install\n  3. npm run dev");

    const monorepo = opts.template.includes("monorepo");
    const manifestDir = monorepo ? path.join(scaffoldTarget, "packages", "extension", "src") : scaffoldTarget;
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, "manifest.json"), "{}");
    if (withGit) fs.mkdirSync(path.join(scaffoldTarget, ".git"));
    if (withStoreMd) fs.writeFileSync(path.join(scaffoldTarget, "STORE.md"), SAMPLE_STORE_MD);

    refSeen = process.env.EXTENSION_CREATE_TEMPLATE_REF;

    if (recordRef) {
      fs.writeFileSync(
        path.join(scaffoldTarget, ".extension-create.json"),
        JSON.stringify({ template: opts.template, source: "codeload", ref: recordRef }),
      );
    }

    if (withScripts) {
      fs.writeFileSync(
        path.join(scaffoldTarget, "package.json"),
        JSON.stringify({
          name: path.basename(scaffoldTarget),
          scripts: scaffoldScripts(opts.template),
          ...(withStoreMd ? { devDependencies: { extension: "^4.1.39" } } : {}),
        }),
      );

      if (monorepo) {
        fs.writeFileSync(
          path.join(scaffoldTarget, "packages", "extension", "package.json"),
          JSON.stringify({ name: "extension" }),
        );
      }
    }

    return {
      projectPath: scaffoldTarget,
      projectName: path.basename(scaffoldTarget),
      template: opts.template,
      depsInstalled: !depsLeftOut,
      packageManager: "bun",
    };
  }),
}));

const create = await import("../tools/create");

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-create-defaults-"));
  tmpDirs.push(dir);

  return dir;
}

const savedEnv = {
  ref: process.env.EXTENSION_CREATE_TEMPLATE_REF,
  dir: process.env[ENGINE_DIR_ENV],
  bin: process.env[ENGINE_BIN_ENV],
};

afterEach(() => {
  withGit = false;
  withScripts = false;
  recordRef = null;
  refSeen = undefined;

  for (const [key, value] of [
    ["EXTENSION_CREATE_TEMPLATE_REF", savedEnv.ref],
    [ENGINE_DIR_ENV, savedEnv.dir],
    [ENGINE_BIN_ENV, savedEnv.bin],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  withStoreMd = false;
  depsLeftOut = false;

  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_create defaultsApplied", () => {
  it("answers the project path once and marks an explicit parentDir as explicit", async () => {
    const parent = tmpDir();
    scaffoldTarget = path.join(parent, "probe");

    const result = JSON.parse(
      await create.handler({ projectName: "probe", parentDir: parent }),
    );

    expect(result.value.projectPath).toBe(scaffoldTarget);
    expect(result.value.resolvedPath).toBeUndefined();
    expect(result.value.defaultsApplied.parentDir).toContain(parent);
    expect(result.value.defaultsApplied.parentDir).toContain("(explicit)");
    expect(result.value.defaultsApplied.gitInit).toBe(false);
  });

  it("names the server-cwd default when parentDir is omitted", async () => {
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.value.defaultsApplied.parentDir).toContain(process.cwd());
    expect(result.value.defaultsApplied.parentDir).toContain(
      "default: the MCP server process cwd",
    );
  });

  it("reports the auto-detected package manager and the chrome default", async () => {
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.value.defaultsApplied.packageManager).toContain("bun");
    expect(result.value.defaultsApplied.packageManager).toContain("auto-detected");
    expect(result.value.defaultsApplied.browser).toContain("chrome");
    expect(result.value.defaultsApplied.browser).toContain("default");
    expect(result.value.scripts).toEqual({});
  });

  it("names the folder each engine script writes, once per script", async () => {
    withScripts = true;
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.value.scripts).toEqual({
      dev: "dist/chromium",
      start: "dist/chromium",
      build: "dist/chromium",
      "build:chrome": "dist/chrome",
      "build:firefox": "dist/firefox",
      "build:edge": "dist/edge",
    });

    expect(result.value.nextSteps.join(" ")).not.toContain("bun run dev");
    expect(result.value.manualAlternative).toContain("bun run dev");
  });

  it("says the scaffold is verified without a build and that extension_dev is the next step", async () => {
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));
    const steps: string[] = result.value.nextSteps;

    expect(steps[0]).toBe("The scaffold is complete and verified: it needs no build to check, so do not run a build to verify it.");
    expect(result.value.manifestPath).toBe(path.join(scaffoldTarget, "manifest.json"));
    expect(steps[1]).toMatch(/^Ask the person "Want me to open it in Chrome so you can try it\?" and, on yes, call extension_dev yourself \(projectPath: /);
    expect(steps[1]).toContain(scaffoldTarget);
    expect(steps.join(" ")).not.toMatch(/run build/);
    expect(create.schema.description).toMatch(/verified, so the next step is extension_dev, not a build\./);
  });

  it("resolves a monorepo script's folder under the package the engine builds", async () => {
    withScripts = true;
    scaffoldTarget = path.join(tmpDir(), "mono");

    const result = JSON.parse(
      await create.handler({ projectName: "mono", template: "sidebar-monorepo-turborepo" }),
    );

    expect(result.value.scripts.build).toBe("packages/extension/dist/chromium");
    expect(result.value.scripts["build:chrome"]).toBe("packages/extension/dist/chrome");
  });

  it("writes the Node, package manager and Extension.js versions it runs on and the scaffold's Firefox build script into the STORE.md reviewer note, with no replace-both instruction (ledger 506)", async () => {
    withScripts = true;
    withStoreMd = true;
    scaffoldTarget = path.join(tmpDir(), "probe");
    const node = process.version.slice(1);

    const result = JSON.parse(await create.handler({ projectName: "probe" }));
    const storeMd = fs.readFileSync(path.join(scaffoldTarget, "STORE.md"), "utf8");
    const note = result.value.reviewerNoteToolchain;

    expect(storeMd).not.toContain("replace both");
    expect(storeMd).not.toContain("22.12.0");
    expect(storeMd).not.toContain("npx extension build --browser firefox");
    expect(note).toMatchObject({ node, extensionJs: "4.1.39", buildCommand: "bun run build:firefox", file: path.join(scaffoldTarget, "STORE.md") });
    expect(note.packageManager.name).toBe("bun");
    const opening = `Build from source with Node ${node}, bun`;

    expect(note.sentence.startsWith(opening)).toBe(true);
    expect(note.sentence.slice(opening.length)).toMatch(/^( \d+\.\d+\.\d+)? and Extension\.js 4\.1\.39: run bun install, then bun run build:firefox\.$/);
    expect(storeMd.replace(/\s+/g, " ")).toContain(`${note.sentence} The upload is dist/firefox, byte for byte.`);
    expect(storeMd.split("\n").every((line) => line.length <= 76)).toBe(true);
    expect(reviewerNoteBuildLine(parseStoreMd(storeMd).firefox!.approvalNotes!)).toMatchObject({ sample: false, node, extensionJs: "4.1.39", packageManager: { name: "bun" } });
  });

  it("answers no reviewerNoteToolchain when the scaffold wrote no STORE.md", async () => {
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.value.reviewerNoteToolchain).toBeUndefined();
  });

  it("tells the person in one sentence what STORE.md is, and says nothing of it when the scaffold wrote none (ledger 533)", async () => {
    withStoreMd = true;
    scaffoldTarget = path.join(tmpDir(), "probe");

    const withFile = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(withFile.value.sayToPerson).toBe("I also wrote a store listing draft (STORE.md). It is only used when you submit to a store and never ships in the extension.");
    expect(withFile.value.nextSteps.join(" ")).toContain("Say value.sayToPerson to the person as it is");

    withStoreMd = false;
    scaffoldTarget = path.join(tmpDir(), "probe");

    const without = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(without.value.sayToPerson).toBeUndefined();
    expect(JSON.stringify(without.value.nextSteps)).not.toContain("STORE.md");
  });

  it("admits when the scaffolder initialized a git repository", async () => {
    withGit = true;
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.value.defaultsApplied.gitInit).toBe(true);
  });

  it("keeps the engine's log out of warnings when install: false was asked, and carries it when an asked install did not happen", async () => {
    depsLeftOut = true;
    scaffoldTarget = path.join(tmpDir(), "probe");

    const asked = JSON.parse(await create.handler({ projectName: "probe", install: false }));

    expect(asked.value.depsInstalled).toBe(false);
    expect(asked.warnings.join("\n")).not.toContain("Next steps:");
    expect(asked.warnings.join("\n")).not.toContain("probe is ready.");
    expect(asked.value.nextSteps.join(" ")).toContain("Dependencies were not installed: run `bun install`");

    scaffoldTarget = path.join(tmpDir(), "probe");

    const failed = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(failed.value.depsInstalled).toBe(false);
    expect(failed.warnings.join("\n")).toContain("probe is ready.");
  });

  it("490 and 489: the ship step names extension_project_create straight from the scaffolded folder, no push, never the /new?template deploy link", async () => {
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe", template: "content-react" }));
    const steps: string[] = result.value.nextSteps;
    const ship = steps[steps.length - 1]!;

    expect(result.value.deployUrl).toBeUndefined();
    expect(result.value.ship).toBeUndefined();
    expect(ship).toMatch(/^To ship: extension_create scaffolds and runs locally, it does not host\./);
    expect(ship).toContain(`extension_project_create (project: '<workspace>/probe', projectPath: '${scaffoldTarget}')`);
    expect(ship).toContain("no GitHub push needed");
    expect(ship).toContain("repo: '<owner>/<repo>' instead of projectPath");
    expect(ship).not.toContain("push this directory");
    expect(ship).not.toContain("to deploy this template");
    expect(ship).not.toMatch(/Open https?:\/\//);
  });

  it("493: the scaffolder is handed the catalog's commit and the answer names the commit the scaffold record carries", async () => {
    delete process.env.EXTENSION_CREATE_TEMPLATE_REF;
    recordRef = PINNED_COMMIT;
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe", template: "content-react" }));

    expect(refSeen).toBe(PINNED_COMMIT);
    expect(process.env.EXTENSION_CREATE_TEMPLATE_REF).toBeUndefined();
    expect(result.value.sourceCommit).toBe(PINNED_COMMIT);
    expect(result.value.template).toBe("content-react");
    expect(result.warnings.join(" ")).not.toContain("while extension_templates describes");
  });

  it("493: a scaffold recorded at another commit is named beside the catalog's, and a person's own ref is kept", async () => {
    const theirs = "6443985200d0a27526662fc7be5d13fe66a0fa2b";
    process.env.EXTENSION_CREATE_TEMPLATE_REF = theirs;
    recordRef = theirs;
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe", template: "content-react" }));

    expect(refSeen).toBe(theirs);
    expect(process.env.EXTENSION_CREATE_TEMPLATE_REF).toBe(theirs);
    expect(result.value.sourceCommit).toBe(theirs);
    expect(result.warnings).toContainEqual(
      expect.stringContaining(`The scaffold came from extension-js/examples at ${theirs} while extension_templates describes ${PINNED_COMMIT}`),
    );
  });

  it("496: a dead EXTENSION_MCP_ENGINE_DIR turns the open step into fix or unset it, with the refusal's own words", async () => {
    const empty = tmpDir();
    process.env[ENGINE_DIR_ENV] = empty;
    delete process.env[ENGINE_BIN_ENV];
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));
    const steps: string[] = result.value.nextSteps;

    expect(result.ok).toBe(true);
    expect(steps[1]).toMatch(/^Fix or unset EXTENSION_MCP_ENGINE_DIR before extension_dev, extension_build or extension_start, which can only refuse until then: /);
    expect(steps[1]).toContain(`EXTENSION_MCP_ENGINE_DIR=${empty} names no engine bin`);
    expect(steps[1]).toContain("extension_doctor shows the paths it expects");
    expect(steps[1].indexOf("Fix or unset")).toBeLessThan(steps[1].indexOf("call extension_dev yourself"));
    expect(result.warnings).toContainEqual(expect.stringContaining(`EXTENSION_MCP_ENGINE_DIR=${empty} names no engine bin`));
  });

  it.each([
    ["a name that climbs out with ../", "../outside/probe"],
    ["a name that climbs out past a nested segment", "nested/../../probe"],
    ["an absolute name outside it", path.join(os.tmpdir(), "mcp-create-elsewhere", "probe")],
    ["an empty name", ""],
    ["a name that is parentDir itself", "."],
    ["a name that comes back to parentDir", "nested/.."],
  ])("refuses %s under an explicit parentDir and writes nothing", async (_what, projectName) => {
    const { extensionCreate } = await import("extension-create");
    const parent = path.join(tmpDir(), "parent");
    fs.mkdirSync(parent);
    scaffoldTarget = path.resolve(parent, projectName);
    vi.mocked(extensionCreate).mockClear();

    const result = JSON.parse(await create.handler({ projectName, parentDir: parent }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("invalid-arguments");
    expect(result.error.code).toBe("E_INPUT_VALIDATION");
    expect(result.error.message).toContain("projectName");
    expect(result.value.issues).toEqual([expect.objectContaining({ path: "projectName" })]);
    expect(result.hint).toContain(parent);
    expect(extensionCreate).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.dirname(parent))).toEqual(["parent"]);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("keeps a nested name that stays inside parentDir, and a bare name without parentDir as the engine takes it", async () => {
    const { extensionCreate } = await import("extension-create");
    const parent = tmpDir();
    scaffoldTarget = path.join(parent, "apps", "probe");
    vi.mocked(extensionCreate).mockClear();

    const nested = JSON.parse(await create.handler({ projectName: "apps/probe", parentDir: parent }));

    expect(nested.ok).toBe(true);
    expect(vi.mocked(extensionCreate).mock.calls[0][0]).toBe(path.join(parent, "apps", "probe"));

    scaffoldTarget = path.join(tmpDir(), "probe");
    vi.mocked(extensionCreate).mockClear();

    const bare = JSON.parse(await create.handler({ projectName: "../probe" }));

    expect(bare.ok).toBe(true);
    expect(vi.mocked(extensionCreate).mock.calls[0][0]).toBe("../probe");
  });

  it("916: a create answer says each fact once and stays under 2,500 characters before its warnings on a scaffold with scripts, a STORE.md and no install", async () => {
    withScripts = true;
    withStoreMd = true;
    depsLeftOut = true;
    const parent = tmpDir();
    scaffoldTarget = path.join(parent, "probe");

    const text = (await create.handler({ projectName: "probe", parentDir: parent, template: "typescript", install: false }))
      .split(JSON.stringify(parent).slice(1, -1))
      .join("/work")
      .split("\\\\")
      .join("/");
    const result = JSON.parse(text);
    const steps: string[] = result.value.nextSteps;

    expect(result.ok).toBe(true);
    const weight = JSON.stringify({ ...result, warnings: [] }).length;

    expect(weight, `${weight} characters`).toBeLessThanOrEqual(2_500);
    expect(JSON.stringify(steps).length).toBeLessThanOrEqual(1_100);
    expect(steps.filter((step) => step.includes("extension_project_create"))).toHaveLength(1);
    expect(JSON.stringify(result.value).split("extension_project_create")).toHaveLength(2);
    expect(JSON.stringify(steps)).not.toContain(PINNED_COMMIT);
    expect(JSON.stringify(steps)).not.toContain("manifest.json");
    expect(Object.values(result.value).filter((field) => field === "/work/probe")).toHaveLength(1);
    expect(steps.join(" ")).toMatch(/call extension_manifest_validate, and build with extension_build .* not a package script/);
  });

  it("documents the name alias and the cwd default in the schema itself", () => {
    const props = create.schema.inputSchema.properties;
    expect(props.projectName.description).toContain("Alias: name");
    expect(props.parentDir.description).toContain("MCP server process cwd");
    expect(create.schema.description).toContain("it may init git");
    expect(create.schema.description).not.toContain("`scripts`");
  });
});
