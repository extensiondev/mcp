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

  it("hashes the real path Chrome registers, resolving a symlinked ancestor of a folder that does not exist yet", () => {
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

  it("rewrites a startingUrl that names the plain build's id under either spelling of its path", () => {
    const root = tmpProject();
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    const link = path.join(root, "link");
    fs.symlinkSync(real, link);
    const literal = unpackedExtensionId(path.join(link, "dist", "chrome"));
    const registered = registeredExtensionId(path.join(link, "dist", "chrome"));
    expect(literal).not.toBe(registered);

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
