// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { BUNDLE_ID_PATTERN, isSafariTarget } from "./safari-dev-options";
import { lastRecordedSigningIdentity } from "./safari-signing";

export const BUILD_BUDGET_MS = 180_000;
export const SAFARI_BUILD_BUDGET_MS = 1_200_000;

export const SAFARI_BUILD_OPTION_SCHEMA = {
  appName: {
    type: "string",
    description:
      "Safari: app name.",
  },
  bundleId: {
    type: "string",
    description:
      "Safari: your reverse-DNS bundle id.",
  },
  developmentTeam: {
    type: "string",
    description:
      "Safari: Apple team id; \"\" for ad-hoc.",
  },
  macOsOnly: {
    type: "boolean",
    default: true,
    description:
      "Safari: false adds iOS and iPadOS.",
  },
  forceRegenerate: {
    type: "boolean",
    default: false,
    description:
      "Safari: regenerate the Xcode project.",
  },
} as const;

export interface SafariBuildArgs {
  appName?: string;
  bundleId?: string;
  developmentTeam?: string;
  macOsOnly?: boolean;
  forceRegenerate?: boolean;
}

export function safariBuildRefusal(command: string, browser: string, args: SafariBuildArgs, start: number): string | null {
  const safariOnly = (
    [
      ["appName", args.appName],
      ["bundleId", args.bundleId],
      ["developmentTeam", args.developmentTeam],
      ["macOsOnly", args.macOsOnly],
      ["forceRegenerate", args.forceRegenerate === true ? true : undefined],
    ] as Array<[string, unknown]>
  )
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);

  if (safariOnly.length > 0 && !isSafariTarget(browser)) {
    return envelope({
      ok: false,
      command,
      status: "safari-only-option",
      error: {
        code: "E_SAFARI_ONLY_OPTION",
        message:
          `${safariOnly.join(", ")} configure the Safari web-extension conversion and mean nothing for a ${browser} build. ` +
          "Nothing was built, so the options were not silently ignored.",
      },
      value: { browser, options: safariOnly, duration: Date.now() - start },
      hint: `Pass browser: "safari" to package a Safari app, or drop these options to build for ${browser}.`,
    });
  }

  if (args.bundleId !== undefined && !BUNDLE_ID_PATTERN.test(args.bundleId)) {
    return envelope({
      ok: false,
      command,
      status: "invalid-bundle-id",
      error: {
        code: "E_INVALID_BUNDLE_ID",
        message:
          `bundleId ${JSON.stringify(args.bundleId)} is not an identifier the engine accepts. ` +
          "Expected dot-separated segments of letters, digits and hyphens (the engine's own rule); a reverse-DNS name under a domain you own is what Apple expects at submission.",
      },
      value: { browser, bundleId: args.bundleId, duration: Date.now() - start },
      hint: 'Use an identifier under a domain you own, for example "com.acme.readinglist".',
    });
  }

  return null;
}

export interface SafariBuildTeam {
  team: string;
  kept: boolean;
}

export function safariBuildTeam(projectPath: string, browser: string, requested: string | undefined): SafariBuildTeam {
  if (requested !== undefined || !isSafariTarget(browser)) return { team: (requested ?? "").trim(), kept: false };

  const last = lastRecordedSigningIdentity(projectPath, browser);

  return last?.startsWith("team:") ? { team: last.slice("team:".length), kept: true } : { team: "", kept: false };
}

export function keptTeamNote(team: string): string {
  return `No developmentTeam was passed, so this build kept team ${team}, the team the project's last Safari app was signed with: an ad-hoc build would be a new extension to Safari and undo the enable state a dev session set up. Pass developmentTeam: "" to build ad-hoc on purpose.`;
}

export function safariBuildCliArgs(args: SafariBuildArgs, team: string): string[] {
  const cli: string[] = [];
  if (args.appName) cli.push("--app-name", args.appName);
  if (args.bundleId) cli.push("--bundle-id", args.bundleId);
  if (team) cli.push("--development-team", team);
  if (args.macOsOnly !== undefined) cli.push("--macos-only", String(args.macOsOnly));
  if (args.forceRegenerate) cli.push("--force-regenerate");

  return cli;
}

export function buildBudgetMs(browser: string): number {
  return isSafariTarget(browser) ? SAFARI_BUILD_BUDGET_MS : BUILD_BUDGET_MS;
}

export function buildTimeoutWords(browser: string, budgetMs: number, signal: string | null | undefined): { message: string; hint: string } {
  const seconds = Math.round(budgetMs / 1000);

  if (isSafariTarget(browser)) {
    return {
      message:
        `This server stopped the Safari build after ${budgetMs} ms (${signal ?? "a signal"}); the engine and xcodebuild did not fail, they ran out of the time this server gave them. ` +
        "Any \"BUILD INTERRUPTED\" or \"Build failed\" line in the output is xcodebuild and the engine reporting that stop, not a compile error.",
      hint: `A Safari build gets ${seconds} s here, sized for a first (cold) Xcode run that compiles its module caches. Check for a still-running xcodebuild before retrying; a retry that races it writes the same app twice.`,
    };
  }

  return {
    message: `This server stopped the build after ${budgetMs} ms (${signal ?? "a signal"}); the engine did not fail, it ran out of the time it was given. A first build that installs dependencies can take longer than that, and the engine process may still be running.`,
    hint: `This tool's budget for a ${browser} build is ${seconds} s. Check for a still-running extension build process (it may finish on its own) before retrying; a retry that races it writes the same dist twice.`,
  };
}
