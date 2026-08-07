// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant This is a PORT of @extension.dev/preview-verdict's grammar, not a
   second opinion about what a verdict is, and src/__tests__/verdict-contract.test.ts
   is what keeps the two honest.

   Sharing the module itself is not available: that package is private to the
   monorepo (C11) and this one publishes to npm, so a dependency on it would
   404 for every reader outside the company. The store-md port answered the
   same boundary the same way, so the same instrument is used: the vocabulary,
   the check-declaration shape and the aggregation rule are asserted against
   the upstream package's own code whenever a monorepo checkout is reachable,
   and the pin is asserted non-degenerate when it is not.

   Three divergences are deliberate and are asserted as divergences rather than
   left to be discovered:

   1. A different contract name and a different registry. These checks judge a
      real browser over the DevTools protocol, not a preview envelope, so
      reusing the upstream's ids would break its own rule that an id is a
      promise about meaning. The two id spaces are asserted disjoint, and each
      check here names the preview check it is the live-browser counterpart of.

   2. A check is keyed by id AND subject. One stage routinely asserts
      surface-rendered over the popup and the options page in the same run,
      which the upstream verifier would read as a duplicate id whose gating is
      undecidable. Uniqueness is enforced over the pair instead.

   3. A document with no checks is inconclusive here, where the upstream rule
      computes a pass. Upstream that is safe because the CONSUMER recomputes
      coverage from its own pin and rejects the gap; this document has no such
      consumer, so an empty stage that reported a pass would be a false green
      with nothing downstream to catch it. */

export const ASSERT_CONTRACT_NAME = "extension.dev/assert-verdict";

export const ASSERT_CONTRACT_VERSION = 1;

export const OUTCOME_PASS = "pass";
export const OUTCOME_FAIL = "fail";
export const OUTCOME_INCONCLUSIVE = "inconclusive";
export const OUTCOME_SKIPPED = "skipped";

export type CheckOutcome =
  | typeof OUTCOME_PASS
  | typeof OUTCOME_FAIL
  | typeof OUTCOME_INCONCLUSIVE
  | typeof OUTCOME_SKIPPED;

export const CHECK_OUTCOMES: CheckOutcome[] = [
  OUTCOME_PASS,
  OUTCOME_FAIL,
  OUTCOME_INCONCLUSIVE,
  OUTCOME_SKIPPED,
];

export type CheckSeverity = "fail" | "warn" | "info";

export type VerdictOutcome =
  | typeof OUTCOME_PASS
  | typeof OUTCOME_FAIL
  | typeof OUTCOME_INCONCLUSIVE;

export interface AssertCheckDeclaration {
  readonly id: string;
  readonly since: number;
  readonly severity: CheckSeverity;
  readonly title: string;
  readonly reads: readonly string[];
  readonly previewCounterpart: string | null;
  readonly counterpartNote?: string;
}

/* @invariant Retired ids are never reused, for the reason the upstream registry
   gives: a consumer pinning a version bought the meaning of every id in it. */
export const ASSERT_RETIRED_IDS: readonly string[] = Object.freeze([]);

export const ASSERT_CHECKS: readonly AssertCheckDeclaration[] = Object.freeze([
  {
    id: "background-worker-booted",
    since: 1,
    severity: "fail",
    title: "the extension's background context started in the real browser",
    reads: [
      "manifest.background",
      "cdp.targets",
      "guestLoadOracle",
      "logs.context.background",
    ],
    previewCounterpart: "background-worker-ready",
  },
  {
    id: "surface-rendered",
    since: 1,
    severity: "fail",
    title: "the surface's document is open and something rendered into it",
    reads: ["manifest.surfaces", "cdp.targets", "page.renderEvidence"],
    previewCounterpart: "declared-surfaces-booted",
    counterpartNote:
      "the preview lane asks the surface to acknowledge itself from inside; this lane reads the real document's own body instead",
  },
  {
    id: "content-script-injected",
    since: 1,
    severity: "fail",
    title: "the extension's content script ran on a named page",
    reads: ["manifest.content_scripts", "logs.context.content"],
    previewCounterpart: null,
    counterpartNote:
      "the preview lane declares no content-script check, and this one can only ever pass on evidence the script itself wrote",
  },
  {
    id: "storage-key-present",
    since: 1,
    severity: "fail",
    title: "chrome.storage holds the key, and the value it was expected to hold",
    reads: ["act.storage.get"],
    previewCounterpart: null,
    counterpartNote:
      "the preview lane's emulated storage is not the browser's, so there is nothing there to be the counterpart of",
  },
  {
    id: "console-errors-empty",
    since: 1,
    severity: "fail",
    title: "the session's own log timeline was read and held no error",
    reads: ["session.logs", "session.readyContract"],
    previewCounterpart: "frame-errors-empty",
    counterpartNote:
      "both replace a count of zero with a read of the messages, because a zero is also what a dead log channel reports",
  },
]);

const BY_ID = new Map(ASSERT_CHECKS.map((check) => [check.id, check]));

export function assertCheckById(id: string): AssertCheckDeclaration | null {
  return BY_ID.get(id) ?? null;
}

export interface CheckResult {
  id: string;
  subject: string | null;
  since: number;
  severity: CheckSeverity;
  outcome: CheckOutcome;
  detail: string;
  evidence: Record<string, unknown> | null;
  settledBy?: string;
}

function declarationFor(id: string): AssertCheckDeclaration {
  const declaration = assertCheckById(id);
  if (!declaration) {
    throw new Error(
      `${id} is not a declared check; mint it in ASSERT_CHECKS before a verdict can carry it`,
    );
  }
  return declaration;
}

function result(
  id: string,
  subject: string | null,
  outcome: CheckOutcome,
  detail: string,
  evidence?: Record<string, unknown>,
  settledBy?: string,
): CheckResult {
  const declaration = declarationFor(id);
  return {
    id,
    subject,
    since: declaration.since,
    severity: declaration.severity,
    outcome,
    detail,
    evidence: evidence ?? null,
    ...(settledBy ? { settledBy } : {}),
  };
}

export function passCheck(
  id: string,
  subject: string | null,
  detail: string,
  evidence?: Record<string, unknown>,
): CheckResult {
  return result(id, subject, OUTCOME_PASS, detail, evidence);
}

export function failCheck(
  id: string,
  subject: string | null,
  detail: string,
  evidence?: Record<string, unknown>,
): CheckResult {
  return result(id, subject, OUTCOME_FAIL, detail, evidence);
}

/* @invariant An inconclusive check cannot be built without naming the evidence
   that would settle it. The upstream contract makes inconclusive gate exactly
   as hard as a failure unless a consumer opts in; a caller who cannot say what
   would settle a question is describing a shrug, and a shrug that gates is
   indistinguishable from a bug in the tool. */
export function inconclusiveCheck(
  id: string,
  subject: string | null,
  detail: string,
  settledBy: string,
  evidence?: Record<string, unknown>,
): CheckResult {
  return result(id, subject, OUTCOME_INCONCLUSIVE, detail, evidence, settledBy);
}

export function checkKey(check: CheckResult): string {
  return check.subject ? `${check.id}:${check.subject}` : check.id;
}

/* @invariant The same rule the upstream verifier applies: a failure outranks an
   unresolved check, an unresolved check outranks a pass, and a pass is only
   what is left when nothing else is present. Empty is inconclusive here, which
   is divergence 3 at the head of this file. */
export function verdictOutcome(checks: CheckResult[]): VerdictOutcome {
  if (checks.length === 0) return OUTCOME_INCONCLUSIVE;
  if (checks.some((check) => check.outcome === OUTCOME_FAIL)) {
    return OUTCOME_FAIL;
  }
  if (
    checks.some(
      (check) =>
        check.outcome === OUTCOME_INCONCLUSIVE ||
        check.outcome === OUTCOME_SKIPPED,
    )
  ) {
    return OUTCOME_INCONCLUSIVE;
  }
  return OUTCOME_PASS;
}

export interface AssertVerdict {
  contract: typeof ASSERT_CONTRACT_NAME;
  contractVersion: number;
  producer: { name: string; version?: string } | null;
  subject: Record<string, unknown> | null;
  generatedAt: string;
  outcome: VerdictOutcome;
  passed: boolean;
  checks: CheckResult[];
  failures: string[];
  inconclusive: string[];
}

export interface VerdictInput {
  checks: CheckResult[];
  producer?: { name: string; version?: string };
  subject?: Record<string, unknown>;
  generatedAt?: string;
}

export function assertVerdict(input: VerdictInput): AssertVerdict {
  const checks = input.checks;
  const seen = new Set<string>();
  for (const check of checks) {
    const key = checkKey(check);
    if (seen.has(key)) {
      throw new Error(
        `${key} appears more than once in one verdict, so which one gates is undecidable`,
      );
    }
    seen.add(key);
  }
  const outcome = verdictOutcome(checks);
  return {
    contract: ASSERT_CONTRACT_NAME,
    contractVersion: ASSERT_CONTRACT_VERSION,
    producer: input.producer ?? null,
    subject: input.subject ?? null,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    outcome,
    passed: outcome === OUTCOME_PASS,
    checks,
    failures: checks
      .filter((check) => check.outcome === OUTCOME_FAIL)
      .map((check) => `${checkKey(check)}: ${check.detail}`),
    inconclusive: checks
      .filter(
        (check) =>
          check.outcome === OUTCOME_INCONCLUSIVE ||
          check.outcome === OUTCOME_SKIPPED,
      )
      .map((check) => `${checkKey(check)}: ${check.detail}`),
  };
}

export function verdictSentence(verdict: AssertVerdict): string {
  if (verdict.checks.length === 0) {
    return "No expectation was stated, so nothing was judged and this is not a pass.";
  }
  const passed = verdict.checks.filter(
    (check) => check.outcome === OUTCOME_PASS,
  ).length;
  const parts = [`${passed}/${verdict.checks.length} passed`];
  if (verdict.failures.length > 0) {
    parts.push(`${verdict.failures.length} failed`);
  }
  if (verdict.inconclusive.length > 0) {
    parts.push(
      `${verdict.inconclusive.length} inconclusive, meaning this platform cannot cover the question today: not a pass, not a bug in the extension, and each one carries the evidence that would settle it in settledBy`,
    );
  }
  return `${parts.join(", ")}.`;
}
