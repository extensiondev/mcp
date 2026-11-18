import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import {
  controlledCopyPath,
  controlledIdentity,
  identityWarnings,
  registeredDirectoryPath,
  registeredExtensionId,
  resolveLoadedId,
} from "../lib/controlled-identity";
import { unpackedExtensionId } from "../lib/extension-identity";

import { FIELD_NOTES_ID, FIELD_NOTES_KEY } from "./fixtures/keyed-manifest";

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-controlled-identity-"));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ID = /^[a-p]{32}$/;

describe("the controlled copy's id comes from the folder the engine loads", () => {
  it("names dist/extension-js/<browser>/controlled under the project, never .extension-js", () => {
    const project = tmpProject();
    const copyPath = controlledCopyPath(project, "chrome");

    expect(copyPath).toBe(path.join(project, "dist", "extension-js", "chrome", "controlled"));

    const identity = controlledIdentity({ projectPath: project, browser: "chrome", outputPath: null, allowControl: true });
    expect(identity.copyPath).toBe(copyPath);
    expect(identity.copyId).toBe(unpackedExtensionId(registeredDirectoryPath(copyPath)));
    expect(identity.copyId).not.toBe(unpackedExtensionId(path.join(project, ".extension-js", "chrome", "controlled")));
    expect(identity.copyId).not.toBe(identity.plainId);
  });

  it.skipIf(process.platform === "win32")("hashes the real path Chrome registers on POSIX, resolving a symlinked ancestor of a folder that does not exist yet (Chrome on Windows registers the path as given)", () => {
    const root = tmpProject();
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    const link = path.join(root, "link");
    fs.symlinkSync(real, link);
    const missing = path.join(link, "dist", "extension-js", "chrome", "controlled");
    const realRoot = fs.realpathSync.native(real);

    expect(registeredDirectoryPath(missing)).toBe(path.join(realRoot, "dist", "extension-js", "chrome", "controlled"));
    expect(registeredExtensionId(missing)).toBe(unpackedExtensionId(path.join(realRoot, "dist", "extension-js", "chrome", "controlled")));
    expect(registeredExtensionId(missing)).not.toBe(unpackedExtensionId(missing));
  });

  it("hashes the path as given on Windows, where Chrome registers a folder without resolving links or short names", () => {
    const root = tmpProject();
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    const link = path.join(root, "link");
    fs.symlinkSync(real, link);
    const missing = path.join(link, "dist", "extension-js", "chrome", "controlled");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      expect(registeredDirectoryPath(missing)).toBe(path.resolve(missing));
      expect(registeredExtensionId(missing)).toBe(unpackedExtensionId(path.resolve(missing)));
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("rewrites a startingUrl that names the plain build's id under either spelling of its path", () => {
    const root = tmpProject();
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    const link = path.join(root, "link");
    fs.symlinkSync(real, link);
    const literal = unpackedExtensionId(path.join(link, "dist", "chrome"));
    const registered = registeredExtensionId(path.join(link, "dist", "chrome"));
    expect(literal === registered).toBe(process.platform === "win32");

    for (const id of [literal, registered]) {
      const identity = controlledIdentity({
        projectPath: link,
        browser: "chrome",
        outputPath: null,
        allowControl: true,
        startingUrl: `chrome://extensions/?options=${id}`,
      });

      expect(identity.rewroteStartingUrl).toBe(true);
      expect(identity.startingUrl).toBe(`chrome://extensions/?options=${identity.copyId}`);
    }
  });
});

describe("the loaded id is the browser's answer, else the copy's folder, never the plain build's derived id", () => {
  function identityFor(project: string) {
    return controlledIdentity({ projectPath: project, browser: "chrome", outputPath: null, allowControl: true });
  }

  it("replaces a derived contract id that is the plain build's with the copy's id", () => {
    const identity = identityFor(tmpProject());
    const loaded = resolveLoadedId(identity, { extensionId: identity.plainId, extensionIdSource: "derived" });

    expect(loaded).toEqual({ extensionId: identity.copyId, source: "copy-folder", replacedPlainId: true });
  });

  it("keeps the id the browser answered even when it differs from the predicted copy id", () => {
    const identity = identityFor(tmpProject());
    const answered = "dpnieppbnngfepobhbkmnjjgneiciafo";
    const loaded = resolveLoadedId(identity, { extensionId: answered, extensionIdSource: "browser" });

    expect(loaded).toEqual({ extensionId: answered, source: "browser", replacedPlainId: false });
    expect(resolveLoadedId(identity, { extensionId: answered, extensionIdSource: "packager" }).source).toBe("browser");
  });

  it("keeps a derived contract id that already names the copy", () => {
    const identity = identityFor(tmpProject());
    const loaded = resolveLoadedId(identity, { extensionId: identity.copyId!, extensionIdSource: "derived" });

    expect(loaded).toEqual({ extensionId: identity.copyId, source: "contract", replacedPlainId: false });
  });

  it("predicts from the copy's folder when the contract has no id yet", () => {
    const identity = identityFor(tmpProject());

    expect(resolveLoadedId(identity, null)).toEqual({ extensionId: identity.copyId, source: "copy-folder", replacedPlainId: false });
    expect(resolveLoadedId(identity, { extensionId: "not-an-id" })).toEqual({ extensionId: identity.copyId, source: "copy-folder", replacedPlainId: false });
  });

  it("passes a plain run's contract id through untouched", () => {
    const identity = controlledIdentity({ projectPath: tmpProject(), browser: "chrome", outputPath: null, allowControl: false });

    expect(identity.copyId).toBeNull();
    expect(resolveLoadedId(identity, { extensionId: identity.plainId, extensionIdSource: "derived" })).toEqual({
      extensionId: identity.plainId,
      source: "contract",
      replacedPlainId: false,
    });

    expect(resolveLoadedId(identity, null)).toEqual({ extensionId: undefined, source: null, replacedPlainId: false });
    expect(identityWarnings(identity, resolveLoadedId(identity, null))).toEqual([]);
  });
});

describe("the identity warning names two different ids", () => {
  it("names the copy's id against the plain build's and says when it was predicted over a plain contract id", () => {
    const identity = controlledIdentity({ projectPath: tmpProject(), browser: "chrome", outputPath: null, allowControl: true });
    const loaded = resolveLoadedId(identity, { extensionId: identity.plainId, extensionIdSource: "derived" });
    const warnings = identityWarnings(identity, loaded).filter((line): line is string => Boolean(line));

    expect(warnings[0]).toContain(`this session's extension id is ${identity.copyId}, not the ${identity.plainId} that dist/<browser> gets`);
    expect(identity.copyId).toMatch(ID);
    expect(identity.copyId).not.toBe(identity.plainId);
    expect(warnings[1]).toContain(`still carried the plain build's id ${identity.plainId}`);
    expect(warnings[1]).toContain(`${identity.copyId} is predicted from the copy's folder`);
    expect(warnings[1]).toContain("extension_wait");
  });

  it("names the browser's answer and tells a rewritten startingUrl to use it when the prediction missed", () => {
    const identity = controlledIdentity({
      projectPath: tmpProject(),
      browser: "chrome",
      outputPath: null,
      allowControl: true,
      startingUrl: "chrome://extensions/?options=PLACEHOLDER",
    });
    const withPlain = { ...identity, rewroteStartingUrl: true };
    const answered = "dpnieppbnngfepobhbkmnjjgneiciafo";
    const warnings = identityWarnings(withPlain, resolveLoadedId(withPlain, { extensionId: answered, extensionIdSource: "browser" })).filter(
      (line): line is string => Boolean(line),
    );

    expect(warnings[0]).toContain(`this session's extension id is ${answered}, not the ${identity.plainId}`);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain(`but the contract recorded ${answered}`);

    const predicted = identityWarnings(withPlain, resolveLoadedId(withPlain, { extensionId: identity.copyId!, extensionIdSource: "browser" })).filter(
      (line): line is string => Boolean(line),
    );
    expect(predicted).toHaveLength(2);
    expect(predicted[1]).toContain(`it was rewritten to ${identity.copyId} so it opens on this run`);
  });
});

describe("a build whose manifest carries a key is one extension id, plain or copied (ledger 936)", () => {
  function keyedProject(withCopy: boolean): string {
    const project = tmpProject();
    const folders = [path.join(project, "dist", "chrome"), ...(withCopy ? [controlledCopyPath(project, "chrome")] : [])];

    for (const folder of folders) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Field Notes", version: "2.4.0", key: FIELD_NOTES_KEY }));
    }

    return project;
  }

  it("names the key's id for the plain build and for the copy, before and after the engine writes the copy", () => {
    for (const withCopy of [false, true]) {
      const identity = controlledIdentity({ projectPath: keyedProject(withCopy), browser: "chrome", outputPath: null, allowControl: true });

      expect(identity).toMatchObject({ plainId: FIELD_NOTES_ID, plainIds: [FIELD_NOTES_ID], copyId: FIELD_NOTES_ID, keyId: FIELD_NOTES_ID });
    }
  });

  it("prints no folder warning, and answers the key's id over a derived contract id", () => {
    const identity = controlledIdentity({ projectPath: keyedProject(true), browser: "chrome", outputPath: null, allowControl: true });

    for (const contract of [null, { extensionId: registeredExtensionId(identity.copyPath!), extensionIdSource: "derived" }, { extensionId: FIELD_NOTES_ID, extensionIdSource: "derived" }]) {
      const loaded = resolveLoadedId(identity, contract);

      expect(loaded).toEqual({ extensionId: FIELD_NOTES_ID, source: "manifest-key", replacedPlainId: false });
      expect(identityWarnings(identity, loaded)).toEqual([]);
    }

    const answered = resolveLoadedId(identity, { extensionId: FIELD_NOTES_ID, extensionIdSource: "browser" });

    expect(answered).toEqual({ extensionId: FIELD_NOTES_ID, source: "browser", replacedPlainId: false });
    expect(identityWarnings(identity, answered)).toEqual([]);
  });

  it("leaves a startingUrl that names the key's id as written", () => {
    const startingUrl = `chrome-extension://${FIELD_NOTES_ID}/newtab.html`;
    const identity = controlledIdentity({ projectPath: keyedProject(false), browser: "chrome", outputPath: null, allowControl: true, startingUrl });

    expect(identity.startingUrl).toBe(startingUrl);
    expect(identity.rewroteStartingUrl).toBe(false);
  });

  it("keeps the folder rule for the copy when the copy's manifest carries no key", () => {
    const project = keyedProject(false);
    const copy = controlledCopyPath(project, "chrome");
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Field Notes", version: "2.4.0" }));

    const identity = controlledIdentity({ projectPath: project, browser: "chrome", outputPath: null, allowControl: true });

    expect(identity).toMatchObject({ plainId: FIELD_NOTES_ID, copyId: registeredExtensionId(copy), keyId: null });
  });
});
