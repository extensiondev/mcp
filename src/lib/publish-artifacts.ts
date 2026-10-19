// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { describeBrowserHealth, everyArtifactFailed, integrityWasChecked, type BuildHealth } from "./build-health";

function titleOf(browser: string): string {
  return browser ? browser[0].toUpperCase() + browser.slice(1) : browser;
}

function listed(names: string[]): string {
  const titled = names.map(titleOf);
  if (titled.length <= 1) return titled.join("");

  return `${titled.slice(0, -1).join(", ")} and ${titled[titled.length - 1]}`;
}

export function artifactsValue(health: BuildHealth): Record<string, unknown> {
  if (!health.checked) return { checked: false, reason: health.reason };

  return {
    checked: integrityWasChecked(health),
    good: health.good,
    failed: health.failed,
    unchecked: health.unchecked,
    browsers: Object.fromEntries(
      health.browsers.map((b) => [
        b.browser,
        { status: b.status, integrity: b.integrity, ...(b.failedChecks.length ? { failedChecks: b.failedChecks } : {}) },
      ]),
    ),
  };
}

export function refuseUnverified(
  health: Extract<BuildHealth, { checked: true }>,
  args: { project?: string },
  minted: { settingsUrl: string | null } | null,
): string {
  const verdicts = health.browsers.map(describeBrowserHealth).join("; ");
  const rebuild = `extension_builds (action: 'rebuild', buildId: '${health.buildId}'${
    args.project ? `, project: '${args.project}'` : ""
  })`;

  return envelope({
    ok: false,
    command: "extension_publish",
    status: "publish-refused",
    error: {
      code: "E_ARTIFACTS_UNVERIFIED",
      name: "PublishRefused",
      message: `Build ${health.buildId} was not published: the platform's own checks reject the artifact of every browser it built (${verdicts}). A tester would get downloads and run commands that cannot work.`,
    },
    value: { buildSha: health.buildId, artifacts: artifactsValue(health) },
    hint: `Rebuild with ${rebuild}, wait until extension_builds (action: 'get') reports integrity passed for the browsers you want to share, then publish that build. To hand out this build anyway, call extension_publish again with force: true.${
      minted
        ? ` The platform had already minted a build link before the check; it is withheld here and listed in the console Settings, Share links section${
            minted.settingsUrl ? ` (${minted.settingsUrl})` : ""
          }, where it can be revoked.`
        : " No link was minted."
    }`,
  });
}

function partialNote(health: Extract<BuildHealth, { checked: true }>): string {
  const verdicts = health.browsers
    .filter((b) => b.usable === false)
    .map(describeBrowserHealth)
    .join("; ");
  const one = health.failed.length === 1;

  return `${everyArtifactFailed(health) ? "Published with force: true although" : "Published, but"} the platform's checks reject the ${listed(health.failed)} artifact${
    one ? "" : "s"
  } of this build (${verdicts}), so ${one ? "that browser is" : "those browsers are"} left out of previewCommands. Rebuild with extension_builds (action: 'rebuild', buildId: '${health.buildId}') for a build that works in ${
    one ? "it" : "them"
  }.`;
}

export function applyArtifactHealth(
  data: Record<string, unknown>,
  health: BuildHealth | null,
): { note: string | null; failed: Set<string> } {
  const failed = new Set(health?.checked ? health.failed.map((b) => b.toLowerCase()) : []);

  if (!health) return { note: null, failed };

  data.artifacts = artifactsValue(health);

  if (data.previewCommands && typeof data.previewCommands === "object" && failed.size > 0) {
    data.previewCommands = Object.fromEntries(
      Object.entries(data.previewCommands as Record<string, unknown>).filter(([browser]) => !failed.has(browser.toLowerCase())),
    );
  }

  if (!health.checked) {
    return {
      note: `Integrity was not checked: the build's per-browser status and integrity could not be read (${health.reason}), so whether its downloads work is unknown. extension_builds (action: 'get') reads them.`,
      failed,
    };
  }

  if (health.failed.length > 0) {
    const goodFor = [...health.good, ...health.unchecked];

    data.tellThem = goodFor.length
      ? `${String(data.tellThem)} Use it for ${listed(goodFor)} only: the ${listed(health.failed)} download did not pass the platform's checks.`
      : `${String(data.tellThem)} This build did not pass the platform's checks for any browser (${listed(health.failed)}), so its downloads may not install.`;

    return { note: partialNote(health), failed };
  }

  if (!integrityWasChecked(health)) {
    return {
      note: "Integrity was not checked: the platform reported no integrity result for this build's artifacts (an older platform, or a build made before the checks), so whether its downloads work is unknown.",
      failed,
    };
  }

  if (health.unchecked.length > 0) {
    return {
      note: `Integrity was not checked for ${listed(health.unchecked)}: the platform reported no readable integrity result for ${
        health.unchecked.length === 1 ? "that artifact" : "those artifacts"
      }.`,
      failed,
    };
  }

  return { note: null, failed };
}
