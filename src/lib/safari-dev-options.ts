// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { WEBKIT_FAMILY } from "./browser-family";
import { envelope } from "./envelope";

export const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

export const SAFARI_DEV_OPTION_SCHEMA = {
  appName: {
    type: "string",
    description:
      "Safari targets only: name of the generated macOS app, which also names the Xcode scheme and the .app on disk. Defaults to the manifest name.",
  },
  bundleId: {
    type: "string",
    description:
      "Safari targets only: a reverse-DNS bundle identifier you own, such as com.acme.readinglist. Without one the app is packaged under a generated dev.extensionjs.* identifier derived from the app name, which two projects with the same name share.",
  },
  developmentTeam: {
    type: "string",
    description:
      "Safari targets only: an Apple Developer team id to sign the app with. Without it the app is ad-hoc signed, which Safari loads locally once unsigned extensions are allowed, and Safari resets the extension's storage on every rebuild.",
  },
  macOsOnly: {
    type: "boolean",
    default: true,
    description:
      "Safari targets only: generate a macOS-only Xcode project. Pass false for a universal project that also targets iOS and iPadOS.",
  },
  forceRegenerate: {
    type: "boolean",
    default: false,
    description:
      "Safari targets only: regenerate the Xcode project even when the engine considers it up to date.",
  },
  enableExtension: {
    type: "boolean",
    default: false,
    description:
      "Safari targets only: let Extension.js turn the extension on in Safari Settings and allow it on other websites after the app opens, instead of printing the one-time setup steps for the person to click through. It drives Safari through macOS Accessibility, which needs a one-time grant for the terminal app that runs this server (System Settings > Privacy & Security > Accessibility); without the grant the engine falls back to the manual steps and the session stays compiled-not-attached until they are done.",
  },
} as const;

export interface SafariDevOptionArgs {
  appName?: string;
  bundleId?: string;
  developmentTeam?: string;
  macOsOnly?: boolean;
  forceRegenerate?: boolean;
  enableExtension?: boolean;
}

export function isSafariTarget(browser: string): boolean {
  return WEBKIT_FAMILY.has(browser);
}

export function safariDevOptionNames(args: SafariDevOptionArgs): string[] {
  return (
    [
      ["appName", args.appName],
      ["bundleId", args.bundleId],
      ["developmentTeam", args.developmentTeam],
      ["macOsOnly", args.macOsOnly],
      ["forceRegenerate", args.forceRegenerate === true ? true : undefined],
      ["enableExtension", args.enableExtension === true ? true : undefined],
    ] as Array<[string, unknown]>
  )
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);
}

export function safariDevOptionArgs(args: SafariDevOptionArgs): string[] {
  const cli: string[] = [];
  if (args.appName) cli.push("--app-name", args.appName);
  if (args.bundleId) cli.push("--bundle-id", args.bundleId);
  if (args.developmentTeam) cli.push("--development-team", args.developmentTeam);
  if (args.macOsOnly !== undefined) cli.push("--macos-only", String(args.macOsOnly));
  if (args.forceRegenerate) cli.push("--force-regenerate");
  if (args.enableExtension) cli.push("--enable-extension");

  return cli;
}

export function safariDevOptionRefusal(
  command: string,
  browser: string,
  args: SafariDevOptionArgs,
): string | null {
  const names = safariDevOptionNames(args);

  if (names.length > 0 && !isSafariTarget(browser)) {
    return envelope({
      ok: false,
      command,
      status: "safari-only-option",
      error: {
        code: "E_SAFARI_ONLY_OPTION",
        message:
          `${names.join(", ")} configure the Safari app and mean nothing for a ${browser} session. ` +
          "Nothing was started, so the options were not silently ignored.",
      },
      value: { browser, options: names },
      hint: `Pass browser: "safari" to run the Safari app, or drop these options to run ${browser}.`,
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
      value: { browser, bundleId: args.bundleId },
      hint: 'Use an identifier under a domain you own, for example "com.acme.readinglist".',
    });
  }

  return null;
}

const MANUAL_STEPS =
  "the one-time setup in a regular Safari window (a trip to Settings from the automation window ends the WebDriver session): Safari > Settings > Developer > Allow unsigned extensions when the app is ad-hoc signed, Safari > Settings > Extensions > turn the extension on, Safari > Settings > Websites > the extension > For other websites > Allow";

export function notAttachedHint(browser: string, enableExtension: boolean): string {
  if (!isSafariTarget(browser)) {
    return "This is usually transient: call extension_wait again. If it persists, stop and restart the session with extension_dev (a restart reliably reattaches); extension_doctor reports the executor leg.";
  }

  if (enableExtension) {
    return (
      "The extension is not enabled in Safari yet. This session was started with enableExtension: true, so Extension.js is turning it on through Safari Settings, which needs a one-time macOS Accessibility grant for the terminal app that runs this server (System Settings > Privacy & Security > Accessibility); without the grant the engine prints the manual steps instead. " +
      `Read extension_logs for the engine's enable lines, grant Accessibility and call extension_dev again with replace: true, or do ${MANUAL_STEPS}; then call extension_wait again. This is not a transient attach failure.`
    );
  }

  return (
    "The extension is not enabled in Safari yet: the session built and opened the Safari app, but a Safari extension attaches only once it is turned on in Safari Settings, which the engine does not do unless asked. " +
    `Either call extension_dev again with enableExtension: true and replace: true to let Extension.js turn it on (one-time macOS Accessibility grant for the terminal app that runs this server), or do ${MANUAL_STEPS}; then call extension_wait again. This is not a transient attach failure.`
  );
}
