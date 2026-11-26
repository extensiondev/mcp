import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logsPath, readyContractPath } from "../lib/session-paths";
import { readyContract, safariDevContract } from "./fixtures/engine-answers";
import {
  readWebDriverSession,
  sameDocument,
  WebDriverClient,
} from "../lib/webdriver";
import * as assertTool from "../tools/assert";
import * as evalTool from "../tools/eval";
import * as logsTool from "../tools/logs";
import * as openTool from "../tools/open";
import * as waitTool from "../tools/wait";
import { ignoreGlobMatcher } from "../lib/ignore-glob";
import { cutAt, dropTrailing } from "../lib/linear-text";
import { urlPatternMatcher } from "../lib/cdp-targets";
import { parseChromeWebStoreMd } from "../lib/chromewebstore-md";
import { matchPatternCovers } from "../lib/match-patterns";
import { patternMatches } from "../lib/network-stubs";
import { gitignored, parseGitignore } from "../lib/source-archive";
import { matchesResourcePattern } from "../tools/assert-page-world-reads";
import { matchPatternRegexSource } from "../tools/inspect-gecko";
import { resolveApiBase } from "../lib/login-flow";
import { failedCheckSentence } from "../lib/store-connection";
import { geckoPanelClosed } from "../tools/open";

import type * as ActModule from "../lib/act";

const act = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      act.calls.push(cli);

      return JSON.stringify({ ok: true, command: cli[0], status: "ok", value: { via: "bridge", cli } });
    },
  };
});

const BROWSER = "safari";
const IGNORE_SCALE_BUDGET_MS = 30_000;

interface FakeSafari {
  port: number;
  calls: Array<{ method: string; route: string; body: unknown }>;
  url: string;
  roots: Array<{ owner: string }>;
  sessionEnded: boolean;
  close(): Promise<void>;
}

async function startFakeSafari(): Promise<FakeSafari> {
  const state: FakeSafari = {
    port: 0,
    calls: [],
    url: "https://start.test/",
    roots: [],
    sessionEnded: false,
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });

    req.on("end", () => {
      const route = String(req.url || "");
      const method = String(req.method || "");
      const body = raw ? JSON.parse(raw) : null;
      state.calls.push({ method, route, body });

      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ value }));
      };

      if (state.sessionEnded && route.startsWith("/session/S-9")) {
        return reply(404, {
          error: "invalid session id",
          message: "Session with id S-9 is not active",
        });
      }

      if (route === "/session/S-9/url" && method === "GET") {
        return reply(200, state.url);
      }

      if (route === "/session/S-9/url" && method === "POST") {
        const wanted = String((body as { url: string }).url);

        try {
          state.url = new URL(wanted).href ? wanted : state.url;
        } catch {
          return reply(400, {
            error: "invalid argument",
            message: "Could not parse requested URL",
          });
        }

        return reply(200, null);
      }

      if (route === "/session/S-9/execute/sync") {
        const script = String((body as { script: string }).script);

        if (script.includes("data-extension-root")) {
          return reply(200, {
            roots: state.roots.length,
            owners: state.roots.map((r) => r.owner),
            url: state.url,
            title: "Fake",
          });
        }

        if (script.includes("throw")) {
          return reply(500, {
            error: "javascript error",
            message: "boom from the page",
          });
        }

        return reply(200, { echoed: script });
      }

      reply(404, { error: "unknown command", message: route });
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );

  const address = server.address();
  state.port = typeof address === "object" && address ? address.port : 0;
  state.close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));

  return state;
}

describe("Safari sessions over the dev window's WebDriver connection", () => {
  let project: string;
  let safari: FakeSafari;

  beforeEach(async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-safari-"));
    safari = await startFakeSafari();
    const manifestDir = path.join(project, "dist", BROWSER);
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, "manifest.json"),
      JSON.stringify({
        name: "Demo",
        version: "1.0.0",
        manifest_version: 3,
        content_scripts: [
          { matches: ["https://example.test/*"], js: ["content.js"] },
        ],
      }),
    );
  });

  afterEach(async () => {
    await safari.close();
    fs.rmSync(project, { recursive: true, force: true });
  });

  function sessionFields(): Record<string, unknown> {
    return {
      runId: "run-safari",
      extensionId: "dev.extensionjs.Demo.Extension",
      distPath: path.join(project, "dist", BROWSER),
      manifestPath: path.join(project, "dist", BROWSER, "manifest.json"),
      logsPath: logsPath(project, BROWSER),
    };
  }

  function writeContract(contract: Record<string, unknown>): void {
    const file = readyContractPath(project, BROWSER);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(contract));
  }

  function writeReady(extra: Record<string, unknown>): void {
    writeContract(readyContract("dev", BROWSER, { ...sessionFields(), ...extra }));
  }

  function withWindow(): void {
    writeContract(
      safariDevContract({ port: safari.port, sessionId: "S-9" }, sessionFields()),
    );
  }

  function writeLogs(events: Array<Record<string, unknown>>): void {
    const file = logsPath(project, BROWSER);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
  }

  it("reads the session only when ready.json carries both fields (a port alone is a hand-cut contract no engine writes)", () => {
    writeReady({});
    expect(readWebDriverSession(project, BROWSER)).toBeNull();
    writeReady({ webdriverPort: safari.port });
    expect(readWebDriverSession(project, BROWSER)).toBeNull();
    withWindow();
    expect(readWebDriverSession(project, BROWSER)).toEqual({
      port: safari.port,
      sessionId: "S-9",
    });
  });

  it("compares documents without their hash, query, or trailing slash", () => {
    expect(sameDocument("https://a.test/x/?q=1#h", "https://a.test/x")).toBe(
      true,
    );

    expect(sameDocument("https://a.test/x", "https://a.test/y")).toBe(false);
    expect(sameDocument(null, "https://a.test/")).toBe(false);
  });

  it.each([
    ["a resource pattern", (glob: string, text: string) => matchesResourcePattern(glob, text)],
    ["a tab address pattern", (glob: string, text: string) => urlPatternMatcher(glob)(text)],
    ["a network stub pattern", (glob: string, text: string) => patternMatches(glob, text)],
    ["a match pattern path", (glob: string, text: string) => matchPatternCovers(`https://a.test/${glob}`, `https://a.test/${text}`)],
    ["a Firefox tab picker pattern", (glob: string, text: string) => new RegExp(matchPatternRegexSource(`https://a.test/${glob}`)).test(`https://a.test/${text}`)],
    ["a Firefox tab picker pattern with no scheme", (glob: string, text: string) => new RegExp(matchPatternRegexSource(glob)).test(text)],
  ])("899: matches %s with many wildcards against long hostile text inside the budget, with the answer the open chain gave", (_name, matches) => {
    const started = performance.now();

    expect(matches("*a*b", `${"a".repeat(60_000)}!`)).toBe(false);
    expect(matches("*a*a*a*a*a*a*b", `${"a".repeat(60_000)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(400);

    expect(matches("*a*a*b", "xayazb")).toBe(true);
    expect(matches("a*b*c", "a-b-b-c")).toBe(true);
    expect(matches("a*b*c", "a-c-b")).toBe(false);
    expect(matches("a**b", "ab")).toBe(true);
    expect(matches("*", "anything")).toBe(true);
    expect(matches("a*", "ba")).toBe(false);
  });

  it("899: reads a hostile ignore line and a hostile listing file inside the budget", () => {
    const size = 50_000;
    const started = performance.now();

    expect(parseGitignore(`${" ".repeat(size)}x\nbuild/  \nkeep\\ \n`)).toHaveLength(3);
    expect(parseChromeWebStoreMd(`## Store Listing\n\n**Support URL / Email**\na@${".".repeat(size)}@\n`).listing.supportEmail).toBeUndefined();
    expect(parseChromeWebStoreMd(`## Store Listing\n\n**Detailed Description**\nx${" ".repeat(size)}y\n`).listing.fullDescription).toHaveLength(size + 2);
    expect(performance.now() - started).toBeLessThan(400);

    const rules = parseGitignore("build/  \nkeep\\ \n*.log\n");

    expect(gitignored("build", true, rules)).toBe(true);
    expect(gitignored("keep ", false, rules)).toBe(true);
    expect(gitignored("a.log", false, rules)).toBe(true);
    expect(parseChromeWebStoreMd("## Store Listing\n\n**Support URL / Email**\nada@example.com\n").listing.supportEmail).toBe("ada@example.com");

    for (const refused of ["ada@example", "ada@.com", "ada@example.", "a@b@c.d", "@example.com", "ada @example.com"]) {
      expect(parseChromeWebStoreMd(`## Store Listing\n\n**Support URL / Email**\n${refused}\n`).listing.supportEmail, refused).toBeUndefined();
    }
  });

  it("901: reads a hostile .gitignore against long paths inside the budget", () => {
    const deep = `${"a/".repeat(30)}y`;
    const run = `${"a".repeat(34)}c`;
    const started = performance.now();
    const modest = parseGitignore(`${"**/".repeat(9)}x\n${"*a".repeat(10)}b\nq${"**a".repeat(10)}b\n`);

    expect(modest).toHaveLength(3);
    expect(gitignored(deep, false, modest)).toBe(false);
    expect(gitignored(run, false, modest)).toBe(false);
    expect(gitignored(`q${run}`, false, modest)).toBe(false);
    expect(performance.now() - started).toBeLessThan(400);

    const again = performance.now();
    const hostile = parseGitignore(
      [`${"**/".repeat(400)}x`, `${"*a".repeat(400)}b`, `q${"**a".repeat(400)}b`, `${"**/*a".repeat(300)}/b`, `${"*".repeat(100_000)}b`, `${"[!b]*".repeat(300)}b`, `${"?*".repeat(300)}b`, "[z-a]", `[${"a-".repeat(2_000)}]`].join("\n"),
    );

    expect(hostile).toHaveLength(9);

    for (const subject of [`${"a/".repeat(400)}y`, `${"a".repeat(900)}c`, `q${"a".repeat(900)}c`, `${"a/a".repeat(300)}c`]) {
      expect(gitignored(subject, false, hostile), subject.slice(0, 12)).toBe(false);
    }

    expect(performance.now() - again).toBeLessThan(400);
    expect(gitignored(`${"a/".repeat(400)}x`, false, hostile)).toBe(true);
    expect(gitignored(`${"a".repeat(900)}b`, false, hostile)).toBe(true);
  });

  it("901: answers every ignore pattern as the regular expression builder did, over a generated corpus", () => {
    const special = /[.*+?^${}()|[\]\\/]/g;

    const before = (pattern: string, anchored: boolean): RegExp => {
      let out = "";

      for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i]!;

        if (ch === "*") {
          if (pattern[i + 1] === "*") {
            if (pattern[i + 2] === "/") {
              out += "(?:.*/)?";
              i += 2;
            } else {
              out += ".*";
              i += 1;
            }
          } else {
            out += "[^/]*";
          }
        } else if (ch === "?") {
          out += "[^/]";
        } else if (ch === "[") {
          const end = pattern.indexOf("]", i + 1);

          if (end > i + 1) {
            const body = pattern.slice(i + 1, end);
            out += `[${(body.startsWith("!") ? `^${body.slice(1)}` : body).replace(/\\/g, "\\\\")}]`;
            i = end;
          } else {
            out += "\\[";
          }
        } else if (ch === "\\" && i + 1 < pattern.length) {
          out += pattern[i + 1]!.replace(special, "\\$&");
          i += 1;
        } else {
          out += ch.replace(special, "\\$&");
        }
      }

      return anchored ? new RegExp(`^${out}$`) : new RegExp(`(?:^|/)${out}$`);
    };

    let seed = 901;

    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;

      return seed / 0x80000000;
    };

    const pick = (from: string[]): string => from[Math.floor(random() * from.length)]!;
    const pieces = ["a", "a", "b", "c", "/", "/", "*", "*", "**", "**/", "/**", "?", ".", "[ab]", "[!a]", "[^a]", "[a-c]", "[c-a]", "[!]", "[]", "[", "]", "[a\\]", "[--b]", "[a-]", "\\*", "\\a", "\\", "!", "-", "é", "+"];
    const letters = ["a", "a", "b", "c", "/", "/", ".", "*", "[", "]", "\\", "-", "é", "+", "!"];
    let cases = 0;
    let matched = 0;
    let unbuildable = 0;
    const differing: string[] = [];

    for (let round = 0; round < 6_000; round += 1) {
      let pattern = "";
      const subjects: string[] = [];

      for (let i = Math.floor(random() * 7); i >= 0; i -= 1) pattern += pick(pieces);

      for (let n = 0; n < 6; n += 1) {
        let subject = "";

        for (let i = Math.floor(random() * 9); i > 0; i -= 1) subject += pick(letters);

        subjects.push(subject);
      }

      subjects.push(pattern.replace(/\*\*\/|\*|\?|\[[^\]]*\]|\\/g, "a"), pattern.replace(/\*\*\/|\*|\?|\\/g, ""));

      for (const anchored of [true, false]) {
        const now = ignoreGlobMatcher(pattern, anchored);
        let was: RegExp;

        try {
          was = before(pattern, anchored);
        } catch {
          unbuildable += 1;

          for (const subject of subjects) expect(typeof now(subject)).toBe("boolean");

          continue;
        }

        for (const subject of subjects) {
          const expected = was.test(subject);

          cases += 1;
          if (expected) matched += 1;
          if (now(subject) !== expected && differing.length < 8) differing.push(JSON.stringify([pattern, anchored, subject, expected]));
        }
      }
    }

    expect(differing).toEqual([]);
    expect(cases).toBeGreaterThan(80_000);
    expect(matched).toBeGreaterThan(4_000);
    expect(unbuildable).toBeGreaterThan(50);
  });

  it("902: answers 100 ordinary ignore lines over 20,000 paths as the walker did, at a fraction of what walking every path costs", () => {
    const names = ["node_modules", "dist", "build", "out", "coverage", "tmp", "cache", "logs", "vendor", "target", "bin", "obj", "public", "static", "generated", "fixtures", "snapshots", "reports", "bundles", "artifacts"];
    const kinds = ["log", "tmp", "map", "bak", "swp", "pyc", "class", "o", "tgz", "zip", "pem", "cache", "orig", "rej", "lock", "pid", "seed", "gz", "tsbuildinfo", "sqlite"];
    const lines = [
      ...names.map((name, i) => (i % 2 ? `${name}/` : name)),
      ...kinds.map((kind) => `*.${kind}`),
      ...names.map((name) => `/${name}-root`),
      ...kinds.map((kind, i) => `.${kind}${i % 2 ? "*" : "rc"}`),
      "src/*.map",
      "docs/**/draft.md",
      "**/scratch",
      "packages/*/dist",
      "apps/**/*.gen.ts",
      "*.py[cod]",
      "npm-debug.log*",
      "!keep.log",
      "!packages/core/dist",
      "file?.txt",
      "img[0-9].png",
      "a**z.bin",
      "[!a]bc.dat",
      "\\#notes",
      "report-*-final.csv",
      "**/deep/**/leaf.txt",
      "/top/*/inner/*.json",
      "*~",
      ".#*",
      "x/**",
    ];
    const rules = parseGitignore(lines.join("\n"));
    const roots = ["src", "packages/core", "packages/app", "apps/web", "docs", "docs/guide", "top/a/inner", "x", "deep/one/two", "lib"];
    const files = ["index.ts", "a.log", "keep.log", "x.map", "draft.md", "scratch", "dist", "file7.txt", "img4.png", "aqz.bin", "xbc.dat", "#notes", "report-q3-final.csv", "leaf.txt", "data.json", "note~", ".#lock", "page.gen.ts", "mod.pyc", "README.md", ".logrc", ".tmpfile", "npm-debug.log.1", "main.tsx", "styles.css"];
    const paths: string[] = [];

    for (let i = 0; paths.length < 20_000; i += 1) {
      const folder = `${roots[i % roots.length]}/m${i % 97}/n${i % 13}`;

      paths.push(`${folder}/${files[i % files.length]!.replace(/^(?=[a-z]+\.tsx?$)/, i % 3 ? `u${i}-` : "")}`);
    }

    expect(rules).toHaveLength(100);
    expect(paths).toHaveLength(20_000);

    let ignored = 0;
    let sum = 0;

    paths.forEach((file, i) => {
      if (!gitignored(file, false, rules)) return;

      ignored += 1;
      sum += i;
    });

    expect([ignored, sum]).toEqual([13_600, 135_986_800]);

    const walked = parseGitignore(Array.from({ length: 100 }, (_, i) => `**/q${i}*/**`).join("\n"));
    const sample = paths.slice(0, 300);

    const fastest = (set: typeof rules): number => {
      let best = Infinity;

      for (let round = 0; round < 3; round += 1) {
        const started = performance.now();

        for (const file of sample) gitignored(file, false, set);

        best = Math.min(best, performance.now() - started);
      }

      return best;
    };

    expect(walked).toHaveLength(100);
    expect(sample.some((file) => gitignored(file, false, walked))).toBe(false);

    const walkedTook = fastest(walked);
    const ordinaryTook = fastest(rules);

    expect(ordinaryTook * 5, `100 ordinary lines took ${ordinaryTook.toFixed(1)} ms over 300 paths, and 100 lines that walk every path took ${walkedTook.toFixed(1)} ms`).toBeLessThan(walkedTook);
  }, IGNORE_SCALE_BUDGET_MS);

  it("901: keeps negation, anchoring, directory-only lines, escapes and a nested file's base", () => {
    const rules = [...parseGitignore("# note\n*.log\n!keep.log\n/root.txt\nout/\ndocs/**/draft.md\n**/tmp\nsrc/*.map\n\\#hash\n\\!bang\nwith\\ space\nimg[0-9].png\n[z-a].txt\n"), ...parseGitignore("*.gen.ts\n/only-here\n", "packages/app")];
    const ignored = (file: string, directory = false): boolean => gitignored(file, directory, rules);

    expect(rules).toHaveLength(14);
    expect(["a.log", "deep/er/a.log", "root.txt", "docs/draft.md", "docs/a/b/draft.md", "tmp", "a/b/tmp", "src/x.map", "#hash", "!bang", "with space", "a/img7.png", "packages/app/x.gen.ts", "packages/app/src/x.gen.ts", "packages/app/only-here"].filter((file) => !ignored(file))).toEqual([]);
    expect(["keep.log", "deep/keep.log", "sub/root.txt", "out", "a/docs/x/draft.md", "src/deep/x.map", "tmpfile", "hash", "imgA.png", "z.txt", "x.gen.ts", "packages/other/x.gen.ts", "packages/app/src/only-here"].filter((file) => ignored(file))).toEqual([]);
    expect(ignored("out", true)).toBe(true);
    expect(ignored("a/out", true)).toBe(true);
  });

  it("899: leaves no trailing-run or cut pattern in shipped source", () => {
    const srcDir = path.resolve(__dirname, "..");
    const slow = /\.replace\(\/(?!\^)[^/\n]*(?:\\\/[^/\n]*)*\+\$\/[a-z]*,|\[\?#\]\.\*\$\/|\.join\("\.\*"\)|\/g, "\.\*"\)/;
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.name === "__tests__" ? [] : entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []));
    const carrying = walk(srcDir)
      .filter((file) => slow.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(srcDir, file).split(path.sep).join("/"))
      .sort();

    expect(carrying).toEqual(["lib/package-address.ts"]);
  });

  it("897: reads a long hostile address in linear time, in every helper that cuts or trims one", () => {
    const size = 100_000;
    const started = performance.now();

    expect(sameDocument(`https://a.test/x${"#".repeat(size)}\n`, "https://a.test/x")).toBe(true);
    expect(sameDocument(`${"/".repeat(size)}x`, "https://a.test/x")).toBe(false);
    expect(cutAt(`a${"?#".repeat(size)}\nb`, "?#")).toBe("a");
    expect(dropTrailing(`${"/".repeat(size)}x`, "/")).toHaveLength(size + 1);
    expect(dropTrailing(`${"\t".repeat(size)}x`, ".", { whitespace: true })).toHaveLength(size + 1);
    expect(resolveApiBase(`https://a.test${"/".repeat(size)}x${"/".repeat(size)}`)).toBe(`https://a.test${"/".repeat(size)}x`);
    expect(failedCheckSentence(`${". ".repeat(size)}x`)).toContain("x");
    expect(geckoPanelClosed("no ".repeat(size))).toBe(false);
    expect(performance.now() - started).toBeLessThan(400);

    expect(cutAt("https://a.test/x?q=1#h", "#")).toBe("https://a.test/x?q=1");
    expect(cutAt("https://a.test/x", "?#")).toBe("https://a.test/x");
    expect(dropTrailing("https://a.test///", "/")).toBe("https://a.test");
    expect(dropTrailing("It failed. . \n", ".", { whitespace: true })).toBe("It failed");
    expect(geckoPanelClosed("E_X there is no extension sidebar context here")).toBe(true);
    expect(geckoPanelClosed("E_X the sidebar is not open")).toBe(true);
    expect(geckoPanelClosed("E_X sidebar context, and no more")).toBe(false);
  });

  it("evaluates in the page over the recorded session", async () => {
    withWindow();
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        context: "page",
        expression: "1 + 1",
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("evaluated");
    expect(parsed.value.context).toBe("page");
    expect(parsed.value.result).toEqual({ echoed: "return (1 + 1);" });
  });

  it("evaluates in the page over the recorded session when no context is given, and says so, without riding the background", async () => {
    withWindow();
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        expression: "1 + 1",
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("evaluated");
    expect(parsed.value.context).toBe("page");
    expect(parsed.value.result).toEqual({ echoed: "return (1 + 1);" });
    expect(parsed.warnings.join("\n")).toContain("No context given: on Safari this tool reaches page contexts only");
    expect(parsed.warnings.join("\n")).toContain("not in the background");
    expect(act.calls.filter((c) => c[0] === "eval")).toHaveLength(0);
  });

  it("navigates first when eval names a url the window is not on", async () => {
    withWindow();
    await evalTool.handler({
      projectPath: project,
      browser: BROWSER,
      context: "page",
      expression: "document.title",
      url: "https://example.test/page",
    });

    expect(
      safari.calls.some(
        (c) =>
          c.method === "POST" &&
          c.route === "/session/S-9/url" &&
          (c.body as { url: string }).url === "https://example.test/page",
      ),
    ).toBe(true);
  });

  function pageEval(url: string) {
    return evalTool
      .handler({
        projectPath: project,
        browser: BROWSER,
        context: "page",
        expression: "document.title",
        url,
      })
      .then((raw) => JSON.parse(raw));
  }

  function navigations(): string[] {
    return safari.calls
      .filter((c) => c.method === "POST" && c.route === "/session/S-9/url")
      .map((c) => (c.body as { url: string }).url);
  }

  it("navigates to a host-and-port url as http, the pattern Chromium and Firefox accept", async () => {
    withWindow();
    const parsed = await pageEval("127.0.0.1:8765");

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("evaluated");
    expect(navigations()).toEqual(["http://127.0.0.1:8765/"]);
  });

  it("evaluates in place when the window already shows a page the host-and-port url matches", async () => {
    withWindow();
    safari.url = "http://127.0.0.1:8765/demo.html";
    const parsed = await pageEval("127.0.0.1:8765");

    expect(parsed.ok).toBe(true);
    expect(parsed.value.url).toBe("http://127.0.0.1:8765/demo.html");
    expect(navigations()).toEqual([]);
  });

  it("evaluates in place on a match pattern that covers the page, and refuses one it cannot open", async () => {
    withWindow();
    safari.url = "http://127.0.0.1:8765/demo.html";
    const covered = await pageEval("*://127.0.0.1/*");

    expect(covered.ok).toBe(true);
    expect(navigations()).toEqual([]);

    const uncovered = await pageEval("*://example.test/*");

    expect(uncovered.ok).toBe(false);
    expect(uncovered.error.code).toBe("E_NO_MATCHING_TARGET");
    expect(uncovered.error.message).toContain("http://127.0.0.1:8765/demo.html");
    expect(navigations()).toEqual([]);
  });

  it("names an ended WebDriver session on a page eval instead of an internal error", async () => {
    withWindow();
    safari.sessionEnded = true;
    const parsed = await pageEval("127.0.0.1:8765");

    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("webdriver-session-ended");
    expect(parsed.error.code).toBe("E_WEBDRIVER_SESSION_ENDED");
    expect(parsed.error.message).toContain("S-9");
    expect(parsed.hint).toContain("enableExtension: true");
    expect(parsed.hint).toContain("no Settings trip");
    expect(parsed.hint).not.toContain("extension_stop");
  });

  it("repeats a page eval until it is truthy over the automation session", async () => {
    withWindow();
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        expression: "document.title",
        context: "page",
        url: "https://start.test/",
        until: { timeoutMs: 3000 },
      }),
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("condition-met");
    expect(parsed.value.result).toEqual({ echoed: "return (document.title);" });
  });

  function writeDetached(extra: Record<string, unknown> = {}): void {
    writeContract(
      safariDevContract(
        { port: safari.port, sessionId: "S-9" },
        {
          ...sessionFields(),
          executorAttachedAt: "2026-10-17T16:47:47.372Z",
          executorDetachedAt: "2026-10-17T16:48:17.376Z",
          runtime: "detached",
          ...extra,
        },
      ),
    );
  }

  function waitOnce() {
    return waitTool
      .handler({ projectPath: project, browser: BROWSER, timeoutMs: 1000 })
      .then((raw) => JSON.parse(raw));
  }

  it("reads a detached executor beside a live automation session as an asleep background", async () => {
    writeDetached();
    const parsed = await waitOnce();

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("background-asleep");
    expect(parsed.value.backgroundAsleep).toBe(true);
    expect(parsed.value.browserAttached).toBe(false);
    expect(parsed.value.executorDetachedAt).toBe("2026-10-17T16:48:17.376Z");
    expect(parsed.hint).not.toContain("extension_stop");
  });

  it("names an ended WebDriver session instead of a gone browser", async () => {
    writeDetached();
    safari.sessionEnded = true;
    const parsed = await waitOnce();

    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("webdriver-session-ended");
    expect(parsed.error.code).toBe("E_WEBDRIVER_SESSION_ENDED");
    expect(parsed.error.message).toContain("S-9");
    expect(parsed.error.message).not.toContain("the browser is gone");
    expect(parsed.hint).toContain('browser: "safari", replace: true and enableExtension: true');
  });

  it("still calls the browser gone when neither the driver nor a recorded pid answers", async () => {
    writeDetached({ browserPid: 999999 });
    await safari.close();
    const parsed = await waitOnce();

    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("browser-gone");
    expect(parsed.error.code).toBe("E_SESSION_EXITED");
  });

  it("sends content and background eval down the bridge, not the window, and refuses popup eval before either", async () => {
    withWindow();
    act.calls.length = 0;

    const content = JSON.parse(await evalTool.handler({ projectPath: project, browser: BROWSER, expression: "1", context: "content" }));
    const background = JSON.parse(await evalTool.handler({ projectPath: project, browser: BROWSER, expression: "1", context: "background" }));
    const popup = JSON.parse(await evalTool.handler({ projectPath: project, browser: BROWSER, expression: "1", context: "popup" }));

    expect(content.value.via).toBe("bridge");
    expect(background.value.via).toBe("bridge");
    expect(popup.status).toBe("safari-context-unreachable");
    expect(act.calls).toHaveLength(2);
    expect(safari.calls).toHaveLength(0);
  });

  it("sends an explicit page eval down the bridge when no window is recorded", async () => {
    writeReady({});
    act.calls.length = 0;
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        context: "page",
        expression: "1",
      }),
    );
    expect(parsed.value.via).toBe("bridge");
    expect(act.calls).toHaveLength(1);
  });

  it("reports a thrown expression as an eval failure, not a crash", async () => {
    withWindow();
    const parsed = JSON.parse(
      await evalTool.handler({
        projectPath: project,
        browser: BROWSER,
        context: "page",
        expression: "(() => { throw 1 })()",
      }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("eval-failed");
    expect(parsed.error.message).toContain("boom from the page");
  });

  it("reads the roots as soon as the navigated page shows one instead of waiting a fixed 1200 ms", async () => {
    withWindow();
    safari.roots = [
      { owner: "content_scripts/content-0::script-0@dev.extensionjs.Demo.Extension (TEAM)" },
    ];

    const started = Date.now();

    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "content-script-injected", url: "https://example.test/page" },
        ],
      }),
    );

    expect(parsed.value.checks[0].outcome).toBe("pass");
    expect(safari.calls.some((c) => c.route === "/session/S-9/url")).toBe(true);
    expect(Date.now() - started).toBeLessThan(600);
  });

  it("passes content-script-injected on a root owned by this extension", async () => {
    withWindow();
    safari.roots = [
      { owner: "content_scripts/content-0::script-0@dev.extensionjs.Demo.Extension (TEAM)" },
    ];

    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "content-script-injected", url: "https://example.test/page" },
        ],
      }),
    );
    const check = parsed.value.checks[0];
    expect(check.outcome).toBe("pass");
    expect(check.evidence.owners).toHaveLength(1);
    expect(
      safari.calls.some(
        (c) =>
          c.method === "POST" &&
          c.route === "/session/S-9/url" &&
          (c.body as { url: string }).url === "https://example.test/page",
      ),
    ).toBe(true);
  });

  it("stays inconclusive on a page with no owned root, naming the marker", async () => {
    withWindow();
    safari.roots = [{ owner: "someone-else@dev.other.Extension" }];
    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "content-script-injected", url: "https://example.test/page" },
        ],
      }),
    );
    const check = parsed.value.checks[0];
    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toContain("none of which names this extension");
    expect(check.settledBy).toContain("data-extension-root");
    expect(parsed.ok).toBe(false);
  });

  it("does not navigate when the window already shows the page", async () => {
    withWindow();
    safari.url = "https://example.test/page/";
    safari.roots = [{ owner: "x@dev.extensionjs.Demo.Extension" }];
    await assertTool.handler({
      projectPath: project,
      browser: BROWSER,
      expect: [
        { assert: "content-script-injected", url: "https://example.test/page" },
      ],
    });

    expect(
      safari.calls.filter(
        (c) => c.method === "POST" && c.route === "/session/S-9/url",
      ),
    ).toHaveLength(0);
  });

  it("passes content-script-injected on a bridge log line before touching the window", async () => {
    withWindow();
    writeLogs([
      { type: "header", runId: "run-safari", v: 1 },
      {
        context: "content",
        level: "log",
        seq: 1,
        url: "https://example.test/page",
        message: "[From the page context] Hello from content_scripts!",
        runId: "run-safari",
      },
    ]);

    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "content-script-injected", url: "https://example.test/page" },
        ],
      }),
    );
    expect(parsed.value.checks[0].outcome).toBe("pass");
    expect(parsed.value.checks[0].detail).toContain("log line");
    expect(safari.calls).toHaveLength(0);
  });

  it("passes background-worker-booted on a background line from the bridge", async () => {
    withWindow();
    writeLogs([
      { type: "header", runId: "run-safari", v: 1 },
      {
        context: "background",
        level: "log",
        seq: 1,
        message: "[From the background context] Hello",
        runId: "run-safari",
      },
    ]);

    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [{ assert: "background-worker-booted" }],
      }),
    );
    expect(parsed.value.checks[0].outcome).toBe("pass");
    expect(parsed.value.checks[0].detail).toContain("bridge");
  });

  it("stays inconclusive on Safari where no log line exists, naming the bridge", async () => {
    withWindow();
    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "background-worker-booted" },
          { assert: "console-errors-empty" },
        ],
      }),
    );
    const checks = parsed.value.checks as Array<{
      outcome: string;
      settledBy: string;
    }>;
    expect(checks.map((c) => c.outcome)).toEqual(["inconclusive", "inconclusive"]);
    for (const check of checks) expect(check.settledBy.length).toBeGreaterThan(10);
    expect(checks[0].settledBy).toContain("bridge");
    expect(safari.calls).toHaveLength(0);
  });

  it("reads storage-key-present over the bridge on Safari", async () => {
    withWindow();
    act.calls.length = 0;
    await assertTool.handler({
      projectPath: project,
      browser: BROWSER,
      expect: [{ assert: "storage-key-present", key: "settings" }],
    });

    expect(act.calls.some((cli) => cli[0] === "storage")).toBe(true);
    expect(safari.calls).toHaveLength(0);
  });

  it("explains a missing Safari log file in Safari's terms", async () => {
    withWindow();
    const parsed = JSON.parse(
      await logsTool.handler({ projectPath: project, browser: BROWSER }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("no-log-file");
    expect(parsed.error.code).toBe("E_LOGS_MISSING");
    expect(parsed.hint).toContain("bridge");
  });

  it("reads the bridge log file on Safari like any other engine", async () => {
    withWindow();
    writeLogs([
      { type: "header", runId: "run-safari", v: 1 },
      {
        context: "content",
        level: "log",
        seq: 1,
        url: "https://example.test/page",
        message: "hello from safari content",
        runId: "run-safari",
      },
    ]);

    const parsed = JSON.parse(
      await logsTool.handler({ projectPath: project, browser: BROWSER }),
    );
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed.value)).toContain("hello from safari content");
  });

  it("navigates the window through extension_open url", async () => {
    withWindow();
    const parsed = JSON.parse(
      await openTool.handler({
        projectPath: project,
        browser: BROWSER,
        url: "https://example.test/next",
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("navigated");
    expect(parsed.value.url).toBe("https://example.test/next");
  });

  it("reports the window gone when the driver stops answering", async () => {
    withWindow();
    await safari.close();
    const client = new WebDriverClient({
      port: safari.port,
      sessionId: "S-9",
    });
    expect(await client.alive()).toBe(false);
    const parsed = JSON.parse(
      await assertTool.handler({
        projectPath: project,
        browser: BROWSER,
        expect: [
          { assert: "content-script-injected", url: "https://example.test/page" },
        ],
      }),
    );
    expect(parsed.value.checks[0].outcome).toBe("inconclusive");
    expect(parsed.value.checks[0].detail).toContain("could not be read");
  });
});
