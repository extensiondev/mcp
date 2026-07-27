import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ENVELOPE_SCHEMA, ERROR_CODES, envelopeObject } from "../lib/envelope";
import { validateAgainstSchema } from "./envelope-validate";

const here = path.dirname(fileURLToPath(import.meta.url));
const contractDir = path.join(here, "contract");
const PIN_FILE = "envelope.pin.json";

interface Pin {
  cliPackage: string;
  cliVersion: string;
  upstreamPath: string;
  shippedPath: string;
  files: Record<string, string>;
}

const pin: Pin = JSON.parse(
  fs.readFileSync(path.join(contractDir, PIN_FILE), "utf8"),
);

const sha256 = (file: string): string =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const copiedFiles = fs
  .readdirSync(contractDir)
  .filter((name) => name !== PIN_FILE)
  .sort();

const schema = JSON.parse(
  fs.readFileSync(path.join(contractDir, "envelope.schema.json"), "utf8"),
);

// The CLI ships its own copy inside extension-develop once it carries phase 4.
// Until then the directory is simply absent, and the byte comparison skips.
const resolveShippedContract = (): string | null => {
  for (let dir = here; ; dir = path.dirname(dir)) {
    const candidate = path.join(
      dir,
      "node_modules",
      pin.cliPackage,
      pin.shippedPath,
    );
    if (fs.existsSync(candidate)) return candidate;
    if (dir === path.parse(dir).root) return null;
  }
};

const resolveEngineVersion = (): string | null => {
  for (let dir = here; ; dir = path.dirname(dir)) {
    const manifest = path.join(
      dir,
      "node_modules",
      pin.cliPackage,
      "package.json",
    );
    if (fs.existsSync(manifest)) {
      return JSON.parse(fs.readFileSync(manifest, "utf8")).version ?? null;
    }
    if (dir === path.parse(dir).root) return null;
  }
};

describe("the copied CLI contract is the same bytes on both sides", () => {
  it("copies at least the envelope schema", () => {
    expect(copiedFiles).toContain("envelope.schema.json");
    expect(copiedFiles.length).toBeGreaterThan(0);
  });

  for (const name of copiedFiles) {
    it(`carries the recorded sha256 for ${name}`, () => {
      const recorded = pin.files[name];
      expect(
        recorded,
        `${name} is not listed in ${PIN_FILE}; add its sha256 there`,
      ).toBeDefined();
      expect(
        sha256(path.join(contractDir, name)),
        `${name} was edited locally. Re-copy it from ${pin.cliPackage}@${pin.cliVersion} (${pin.upstreamPath}/${name}) and refresh ${PIN_FILE}.`,
      ).toBe(recorded);
    });
  }

  it("records no file it does not carry", () => {
    expect(Object.keys(pin.files).sort()).toEqual(copiedFiles);
  });

  it("names the CLI release the copy was cut from", () => {
    expect(pin.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    // Deliberately NOT read from package.json: MCP CI rewrites the engine pin
    // (`pnpm add extension-develop@<matrix>`) before it runs this suite.
    expect(fs.existsSync(path.join(contractDir, PIN_FILE))).toBe(true);
  });

  it("matches the contract the resolved engine ships, when it ships one", () => {
    const shipped = resolveShippedContract();
    if (!shipped) {
      console.warn(
        `[envelope-contract] ${pin.cliPackage} ships no ${pin.shippedPath}/ yet, so the upstream byte comparison is skipped. Remove this skip once the CLI stable that carries the machine contract is pinned.`,
      );
      return;
    }
    const engineVersion = resolveEngineVersion();
    for (const name of copiedFiles) {
      const upstream = path.join(shipped, name);
      if (!fs.existsSync(upstream)) continue;
      const same = sha256(upstream) === pin.files[name];
      if (engineVersion === pin.cliVersion) {
        expect(
          same,
          `${name} drifted from ${pin.cliPackage}@${engineVersion}. Re-copy it and refresh ${PIN_FILE}.`,
        ).toBe(true);
      } else if (!same) {
        console.warn(
          `[envelope-contract] ${name} differs from ${pin.cliPackage}@${engineVersion}, which is not the pinned ${pin.cliVersion}. CI runs a version matrix, so this is a warning, not a failure.`,
        );
      }
    }
  });
});

describe("this package produces what the copied schema describes", () => {
  it("declares the same schema version the CLI does", () => {
    expect(schema.properties.schema.const).toBe(ENVELOPE_SCHEMA);
  });

  it("requires the keys every tool must emit", () => {
    expect(schema.required).toEqual([
      "schema",
      "ok",
      "command",
      "status",
      "value",
      "error",
      "warnings",
    ]);
  });

  it("accepts every error code this package can emit", () => {
    const pattern = new RegExp(
      schema.properties.error.oneOf[1].properties.code.pattern,
    );
    for (const code of ERROR_CODES) {
      expect(pattern.test(code), `${code} is not a legal error code`).toBe(true);
    }
  });

  it("validates a success frame and a failure frame", () => {
    expect(
      validateAgainstSchema(
        envelopeObject({
          ok: true,
          command: "extension_build",
          status: "built",
          value: { browser: "chromium" },
        }),
        schema,
      ),
    ).toEqual([]);

    expect(
      validateAgainstSchema(
        envelopeObject({
          ok: false,
          command: "extension_dev",
          status: "compile-failed",
          error: { code: "E_FIRST_COMPILE", message: "Compile failed" },
          hint: "Fix the error and run extension_dev again.",
          warnings: ["one warning"],
        }),
        schema,
      ),
    ).toEqual([]);
  });

  it("rejects a frame that skips a required key or invents a code", () => {
    expect(
      validateAgainstSchema({ schema: 1, ok: true, command: "x" }, schema)
        .length,
    ).toBeGreaterThan(0);
    expect(
      validateAgainstSchema(
        {
          schema: 1,
          ok: false,
          command: "x",
          status: "y",
          value: null,
          error: { code: "not_a_code", message: "m" },
          warnings: [],
        },
        schema,
      ).length,
    ).toBeGreaterThan(0);
  });
});
