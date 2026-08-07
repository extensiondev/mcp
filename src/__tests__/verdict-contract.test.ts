import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ASSERT_CHECKS,
  ASSERT_CONTRACT_NAME,
  CHECK_OUTCOMES,
  assertVerdict,
  failCheck,
  inconclusiveCheck,
  passCheck,
  verdictOutcome,
  type CheckOutcome,
  type CheckResult,
} from "../lib/verdict";

const here = path.dirname(fileURLToPath(import.meta.url));
const pinFile = path.join(here, "fixtures", "preview-verdict.pin.json");

interface Pin {
  upstreamPackage: string;
  upstreamPath: string;
  outcomes: string[];
  verdictOutcomes: string[];
  checkDeclarationKeys: string[];
  checkResultKeys: string[];
  documentKeys: string[];
  aggregation: Array<{ outcomes: CheckOutcome[]; verdict: string }>;
  counterparts: Record<string, string | null>;
  divergences: string[];
}

const pin: Pin = JSON.parse(fs.readFileSync(pinFile, "utf8"));

/* @invariant THE UPSTREAM LEG NEVER SKIPS ITSELF INTO A GREEN.
 *
 * Same shape as store-md-contract.test.ts, and for the same reason. The
 * monorepo is detected by the file that DECLARES this package, its .gitmodules,
 * never by the upstream's own presence: declared and absent is a FAILURE that
 * names the missing path, while an ancestor that declares nothing is the
 * standalone package repo, where the pin is asserted non-degenerate instead of
 * quietly waved through.
 *
 * The pin deliberately does NOT hash the upstream file. store-md ports a parser
 * whose every byte decides an answer; what is ported here is a grammar, and the
 * upstream is a young package whose prose and evidence fields move weekly. A
 * byte hash would go red for a reworded title, which trains a reader to
 * regenerate the pin without reading it. What is pinned instead is the part a
 * consumer can be wrong about: the outcome vocabulary, the shape of a check and
 * of a document, and the aggregation rule, each asserted against the upstream's
 * OWN code rather than against a copy of its output.
 */
const SELF_SUBMODULE = "packages/public-extensiondev-mcp";

const findDeclaringRoot = (): string | null => {
  const packageRoot = path.resolve(here, "..", "..");
  for (let dir = path.dirname(packageRoot); ; dir = path.dirname(dir)) {
    const modules = path.join(dir, ".gitmodules");
    if (
      fs.existsSync(modules) &&
      fs.readFileSync(modules, "utf8").includes(`path = ${SELF_SUBMODULE}`)
    ) {
      return dir;
    }
    if (dir === path.parse(dir).root) return null;
  }
};

const monorepoRoot = findDeclaringRoot();
const upstreamFile = monorepoRoot
  ? path.join(monorepoRoot, pin.upstreamPath)
  : null;

interface UpstreamCheck {
  id: string;
  since: number;
  severity: string;
  title: string;
  reads: string[];
  deprecatedAt?: number;
}

interface Upstream {
  CONTRACT_NAME: string;
  CONTRACT_VERSION: number;
  OUTCOME_PASS: string;
  OUTCOME_FAIL: string;
  OUTCOME_INCONCLUSIVE: string;
  OUTCOME_SKIPPED: string;
  CHECKS: UpstreamCheck[];
  RETIRED_IDS: string[];
  requiredChecksForVersion: (version: number) => UpstreamCheck[];
  evaluateVerdict: (input: Record<string, unknown>) => Record<string, unknown>;
  verifyVerdict: (
    document: unknown,
    options?: Record<string, unknown>,
  ) => { accepted: boolean; outcome: string; rejections: Array<{ code: string }> };
}

const loadUpstream = async (): Promise<Upstream> =>
  (await import(/* @vite-ignore */ pathToFileURL(upstreamFile!).href)) as unknown as Upstream;

const someChecks = (outcomes: CheckOutcome[]): CheckResult[] =>
  outcomes.map((outcome, index) => {
    const id = ASSERT_CHECKS[index % ASSERT_CHECKS.length].id;
    const subject = `subject-${index}`;
    if (outcome === "pass") return passCheck(id, subject, "ok");
    if (outcome === "fail") return failCheck(id, subject, "not ok");
    const check = inconclusiveCheck(id, subject, "unknown", "do this");
    return outcome === "skipped" ? { ...check, outcome } : check;
  });

describe("the ported verdict grammar is internally sound", () => {
  it("declares every check with the pinned declaration keys", () => {
    expect(ASSERT_CHECKS.length).toBeGreaterThan(0);
    for (const check of ASSERT_CHECKS) {
      for (const key of pin.checkDeclarationKeys) {
        expect(Object.keys(check), `${check.id} is missing ${key}`).toContain(
          key,
        );
      }
      expect(check.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(check).toHaveProperty("previewCounterpart");
    }
  });

  it("carries the pinned outcome vocabulary and nothing else", () => {
    expect(CHECK_OUTCOMES).toEqual(pin.outcomes);
  });

  it("puts the pinned keys on every check result and on the document", () => {
    const results = [
      passCheck(ASSERT_CHECKS[0].id, null, "ok"),
      failCheck(ASSERT_CHECKS[1].id, "a", "no"),
      inconclusiveCheck(ASSERT_CHECKS[2].id, "b", "cannot say", "do this"),
    ];
    for (const result of results) {
      for (const key of pin.checkResultKeys) {
        expect(Object.keys(result)).toContain(key);
      }
    }
    const document = assertVerdict({ checks: results });
    for (const key of pin.documentKeys) {
      expect(Object.keys(document)).toContain(key);
    }
    expect(document.passed).toBe(document.outcome === "pass");
  });

  it("cannot build an inconclusive check without saying what would settle it", () => {
    const built = inconclusiveCheck(ASSERT_CHECKS[0].id, null, "why", "how");
    expect(built.settledBy).toBe("how");
  });

  it("refuses to mint a check the registry never declared", () => {
    expect(() => passCheck("invented-check", null, "ok")).toThrow(
      /not a declared check/,
    );
  });

  it("refuses a document that answers the same id and subject twice", () => {
    const id = ASSERT_CHECKS[0].id;
    expect(() =>
      assertVerdict({
        checks: [passCheck(id, "x", "ok"), failCheck(id, "x", "no")],
      }),
    ).toThrow(/undecidable/);
  });

  it("reads an empty stage as inconclusive, never as a pass", () => {
    const document = assertVerdict({ checks: [] });
    expect(document.outcome).toBe("inconclusive");
    expect(document.passed).toBe(false);
  });
});

describe("the ported grammar against @extension.dev/preview-verdict", () => {
  it("resolves the upstream file whenever this is a monorepo checkout", () => {
    if (!monorepoRoot) {
      expect(pin.outcomes.length).toBeGreaterThan(0);
      expect(Object.keys(pin.counterparts).sort()).toEqual(
        ASSERT_CHECKS.map((check) => check.id).sort(),
      );
      expect(pin.divergences.length).toBeGreaterThan(0);
      return;
    }
    expect(
      fs.existsSync(upstreamFile!),
      `${upstreamFile} is missing. This checkout declares ${SELF_SUBMODULE}, so ${pin.upstreamPackage} must be present for the verdict contract to mean anything.`,
    ).toBe(true);
  });

  it("agrees with the upstream on the outcome vocabulary", async () => {
    if (!monorepoRoot) return;
    const upstream = await loadUpstream();
    expect(
      [
        upstream.OUTCOME_PASS,
        upstream.OUTCOME_FAIL,
        upstream.OUTCOME_INCONCLUSIVE,
        upstream.OUTCOME_SKIPPED,
      ],
      "the upstream renamed an outcome; re-read it before touching the port",
    ).toEqual(pin.outcomes);
    expect(CHECK_OUTCOMES).toEqual(pin.outcomes);
  });

  it("declares its checks the way the upstream registry declares its own", async () => {
    if (!monorepoRoot) return;
    const upstream = await loadUpstream();
    expect(upstream.CHECKS.length).toBeGreaterThan(0);
    for (const check of upstream.CHECKS) {
      for (const key of pin.checkDeclarationKeys) {
        expect(
          Object.keys(check),
          `upstream check ${check.id} no longer carries ${key}, so the ported declaration shape has drifted`,
        ).toContain(key);
      }
    }
  });

  it("shapes a check result and a document the way the upstream evaluator does", async () => {
    if (!monorepoRoot) return;
    const upstream = await loadUpstream();
    const document = upstream.evaluateVerdict({ envelope: null }) as {
      checks: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    expect(document.checks.length).toBeGreaterThan(0);
    for (const key of pin.checkResultKeys) {
      expect(
        Object.keys(document.checks[0]),
        `the upstream check result no longer carries ${key}`,
      ).toContain(key);
    }
    for (const key of pin.documentKeys) {
      expect(
        Object.keys(document),
        `the upstream verdict document no longer carries ${key}`,
      ).toContain(key);
    }
  });

  /* @invariant The aggregation rule is compared against the upstream's OWN
     verifier rather than against a table someone typed, so "a failure outranks
     an unresolved check, an unresolved check outranks a pass" cannot drift on
     one side only. The upstream document is built over ITS required ids so its
     coverage rule is satisfied and the only thing being compared is the rule. */
  it("aggregates outcomes exactly as the upstream verifier recomputes them", async () => {
    if (!monorepoRoot) return;
    const upstream = await loadUpstream();
    const required = upstream.requiredChecksForVersion(
      upstream.CONTRACT_VERSION,
    );
    expect(required.length).toBeGreaterThan(pin.aggregation[0].outcomes.length);

    for (const row of pin.aggregation) {
      const checks = required.map((check, index) => ({
        id: check.id,
        since: check.since,
        severity: check.severity,
        outcome: row.outcomes[index] ?? "pass",
        detail: "fixture",
        evidence: null,
      }));
      const verified = upstream.verifyVerdict(
        {
          contract: upstream.CONTRACT_NAME,
          contractVersion: upstream.CONTRACT_VERSION,
          checks,
        },
        { expectVersion: upstream.CONTRACT_VERSION },
      );
      expect(
        verified.outcome,
        `upstream reads ${row.outcomes.join("+")} as ${verified.outcome}, the pin says ${row.verdict}`,
      ).toBe(row.verdict);
      expect(
        verdictOutcome(someChecks(row.outcomes)),
        `this port reads ${row.outcomes.join("+")} differently from the upstream`,
      ).toBe(row.verdict);
    }
  });

  it("keeps the two lanes' id spaces disjoint", async () => {
    if (!monorepoRoot) return;
    const upstream = await loadUpstream();
    const upstreamIds = new Set(upstream.CHECKS.map((check) => check.id));
    for (const check of ASSERT_CHECKS) {
      expect(
        upstreamIds.has(check.id),
        `${check.id} is declared by both lanes, and an id is a promise about one meaning`,
      ).toBe(false);
    }
  });

  it("names a live upstream check as each counterpart, or explains the absence", async () => {
    if (!monorepoRoot) return;
    const upstream = await loadUpstream();
    const byId = new Map(upstream.CHECKS.map((check) => [check.id, check]));
    expect(Object.keys(pin.counterparts).sort()).toEqual(
      ASSERT_CHECKS.map((check) => check.id).sort(),
    );
    for (const check of ASSERT_CHECKS) {
      expect(check.previewCounterpart).toBe(pin.counterparts[check.id]);
      if (check.previewCounterpart === null) {
        expect(
          check.counterpartNote,
          `${check.id} claims no preview counterpart and does not say why`,
        ).toBeTruthy();
        continue;
      }
      const counterpart = byId.get(check.previewCounterpart);
      expect(
        counterpart,
        `${check.id} points at the preview check ${check.previewCounterpart}, which that registry no longer declares`,
      ).toBeTruthy();
      expect(
        counterpart?.deprecatedAt,
        `${check.id} points at ${check.previewCounterpart}, which the preview lane deprecated; point it at the successor`,
      ).toBeUndefined();
      expect(upstream.RETIRED_IDS).not.toContain(check.previewCounterpart);
    }
  });

  /* @invariant Divergence 1, asserted rather than described. A document from
     this lane must be REJECTED by the upstream verifier, so no CI can pin the
     preview contract and be handed a live-browser verdict that satisfies it. */
  it("produces a document the upstream verifier refuses to accept as its own", async () => {
    if (!monorepoRoot) return;
    const upstream = await loadUpstream();
    const document = assertVerdict({
      checks: ASSERT_CHECKS.map((check) => passCheck(check.id, null, "ok")),
    });
    expect(document.contract).toBe(ASSERT_CONTRACT_NAME);
    expect(document.contract).not.toBe(upstream.CONTRACT_NAME);
    const verified = upstream.verifyVerdict(document, {
      expectVersion: upstream.CONTRACT_VERSION,
    });
    expect(verified.accepted).toBe(false);
    expect(verified.rejections.map((rejection) => rejection.code)).toContain(
      "contract-mismatch",
    );
  });
});
