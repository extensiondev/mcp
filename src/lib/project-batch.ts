// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const MAX_BATCH_PROJECTS = 20;

export const MAX_PROJECT_SLUG_LENGTH = 48;

export const MAX_WORKSPACE_SLUG_LENGTH = 64;

export const PLATFORM_CREATES_PER_HOUR = 10;

export const DEFAULT_CREATE_PROJECTS_PER_APPROVAL = 10;

export interface BatchCapability {
  createProjectsPerApproval: number;
  loginProjectsPerApproval: number;
}

function capFrom(value: unknown, fallback: number): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) return fallback;

  return Math.min(count, MAX_BATCH_PROJECTS);
}

/* @invariant THE PLATFORM SAYS WHETHER IT TAKES A LIST, AND HOW LONG A LIST,
 * AND THIS CLIENT BELIEVES IT BEFORE SPENDING A DEVICE CODE. The login config
 * a call already reads carries `batchOnboarding` on a platform that accepts
 * `projects`. A platform without it predates the list: sent one, it answers
 * with its refusal for a malformed single project, a sentence no client can
 * tell from any other, at the price of one of ten device codes. So absence is
 * read as "no", here, before any code is asked for.
 *
 * The caps are the platform's to state. The create cap ruled on 2026-10-05 is
 * ten per approval, and ten is the fallback when the platform advertises the
 * capability without a usable number, so a garbled field can never read as
 * "no limit". A number above twenty is held to twenty, the most this client
 * will ever put in one list, and the platform checks every list again.
 */
export function readBatchCapability(config: unknown): BatchCapability | null {
  const raw = (config as { batchOnboarding?: unknown } | null)?.batchOnboarding;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;

  return {
    createProjectsPerApproval: capFrom(
      record.createProjectsPerApproval,
      DEFAULT_CREATE_PROJECTS_PER_APPROVAL,
    ),
    loginProjectsPerApproval: capFrom(
      record.loginProjectsPerApproval,
      MAX_BATCH_PROJECTS,
    ),
  };
}

export const BATCH_UNSUPPORTED_MESSAGE =
  "This platform does not advertise batch onboarding, so a list of projects was not sent and no device code was spent.";

const PROJECT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isExactProjectSlug(slug: string): boolean {
  return slug.length <= MAX_PROJECT_SLUG_LENGTH && PROJECT_SLUG.test(slug);
}

export interface ProjectBatch {
  workspace: string;
  slugs: string[];
  refs: string[];
}

export type ProjectBatchParse =
  | { ok: true; batch: ProjectBatch }
  | { ok: false; message: string };

/* @invariant THESE ARE THE PLATFORM'S RULES FOR A LIST, CHECKED HERE SO THE
 * REASON ARRIVES BEFORE A DEVICE CODE IS SPENT. One approval names one
 * workspace and at most twenty projects, each by the exact slug the platform
 * registers (lowercase letters and digits joined by single dashes, at most
 * forty-eight characters), with no name twice. The platform refuses a list
 * that breaks any of them whole, and its refusal costs one of the ten device
 * codes an address may start in ten minutes, so the same refusal is given
 * here first and names the entry that caused it. This is a courtesy and not
 * the gate: the platform checks every rule again, and a rule relaxed here
 * would only move the refusal one request later.
 */
export function parseProjectBatch(input: unknown): ProjectBatchParse {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      message: "projects must be an array of '<workspace>/<project>' names.",
    };
  }

  if (input.length < 1 || input.length > MAX_BATCH_PROJECTS) {
    return {
      ok: false,
      message: `projects must name between 1 and ${MAX_BATCH_PROJECTS} projects; got ${input.length}. One approval covers at most ${MAX_BATCH_PROJECTS}, so split a longer list into separate calls.`,
    };
  }

  const refs: string[] = [];
  const slugs: string[] = [];
  let workspace = "";

  for (const entry of input) {
    const raw = typeof entry === "string" ? entry.trim() : "";

    if (!/^[^/]+\/[^/]+$/.test(raw)) {
      return {
        ok: false,
        message: `Every entry in projects must be '<workspace>/<project>'; got ${JSON.stringify(entry)}.`,
      };
    }

    const slash = raw.indexOf("/");
    const entryWorkspace = raw.slice(0, slash).trim().toLowerCase();
    const slug = raw.slice(slash + 1).trim().toLowerCase();

    if (!entryWorkspace || entryWorkspace.length > MAX_WORKSPACE_SLUG_LENGTH) {
      return {
        ok: false,
        message: `The workspace in '${raw}' must be a slug of at most ${MAX_WORKSPACE_SLUG_LENGTH} characters.`,
      };
    }

    if (!isExactProjectSlug(slug)) {
      return {
        ok: false,
        message: `'${raw}' does not name a project by its exact slug. A batch takes each project slug exactly as the platform registers it: lowercase letters and digits joined by single dashes, at most ${MAX_PROJECT_SLUG_LENGTH} characters. The console address bar shows it as console.extension.dev/<workspace>/<project>.`,
      };
    }

    if (workspace && entryWorkspace !== workspace) {
      return {
        ok: false,
        message: `One approval covers one workspace: '${raw}' is in '${entryWorkspace}' but the list started in '${workspace}'. Make one call per workspace.`,
      };
    }

    workspace = entryWorkspace;

    if (slugs.includes(slug)) {
      return {
        ok: false,
        message: `'${entryWorkspace}/${slug}' is named twice in projects. Name each project once.`,
      };
    }

    slugs.push(slug);
    refs.push(`${entryWorkspace}/${slug}`);
  }

  return { ok: true, batch: { workspace, slugs, refs } };
}

export function sameProjectSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;

  const wanted = new Set(a.map((value) => value.toLowerCase()));

  return b.every((value) => wanted.has(value.toLowerCase()));
}

export function createRateLimitNote(): string {
  return `The platform limits create requests to ${PLATFORM_CREATES_PER_HOUR} per hour for one approving account, counted before the existence check (so a request for a project that already exists counts), and a second limiter answers the same RATE_LIMITED code at a higher rate. Requests the same account already made in the last hour count against it; the platform's own retry-after is relayed when it sends one.`;
}

export function createCapNote(cap: number): string {
  return `One approval creates at most ${cap} projects on this platform. Send the first ${cap}; the next ${cap} can start in a new call, with its own approval, once the hourly creation limit allows.`;
}
