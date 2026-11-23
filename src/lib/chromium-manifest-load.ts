// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const CHROMIUM_MANIFEST_ERRORS_URL =
  "https://source.chromium.org/chromium/chromium/src/+/main:extensions/common/manifest_constants.h";
export const CHROMIUM_ICON_KEY_MAX = 2048;
export const CHROMIUM_CHROME_STYLE_FROM_MANIFEST = 3;
export const CHROMIUM_ACTION_FROM_MANIFEST = 3;

export type ChromiumRefusedKeys = { keys: string[]; reason: string };

/* @invariant
 * A KEY IS LISTED HERE ONLY AFTER A REAL CHROMIUM REFUSED TO LOAD IT.
 *
 * Firefox and Safari ignore a manifest key they do not know, so a build is
 * green and a Firefox walk passes while Chrome and Edge refuse the whole
 * extension. Each refusal below is Chromium's own error string, read from
 * `manifest_constants.h` with the handler that raises it
 * (`options_page_info.cc`, `manifest_handler_helpers.cc`), and was loaded
 * unpacked on 2026-11-15 in Chromium 143 and Microsoft Edge 157, which both
 * left the extension out: `options_ui.chrome_style` under Manifest V3 with
 * either value, and a key of `icons` or of an `action.default_icon` object
 * that is not a whole pixel size ("any", "16.5", "0" and "4096" are refused,
 * "+16" loads, and a `default_icon` given as one path string loads).
 * `action` is read from Manifest V3 only: on 2026-11-23 the same four keys
 * under `action.default_icon` of a Manifest V2 extension raised no icon
 * error in Chrome for Testing 133, 141, 143, 151 and 156, which installed
 * it disabled (133) or refused it as "Cannot install extension because it
 * uses an unsupported manifest version" beside a Manifest V2 extension with
 * no `action` at all, so the key is never the reason there (ledger 1064).
 * The WebExtensions group asks Chrome to turn both into warnings (issues 1135
 * and 1136 of w3c/webextensions); when Chromium does, the entry leaves this
 * list.
 */
export function chromiumRefusedKeys(manifest: Record<string, unknown>): ChromiumRefusedKeys[] {
  const row = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const out: ChromiumRefusedKeys[] = [];
  const optionsUi = row(manifest.options_ui);
  const refusedSizes = (icons: unknown) =>
    Object.keys(row(icons)).filter((key) => {
      const size = /^[+-]?\d+$/.test(key) ? Number(key) : 0;

      return !(size > 0 && size <= CHROMIUM_ICON_KEY_MAX);
    });
  const iconKeys = refusedSizes(manifest.icons);
  const actionIconKeys =
    Number(manifest.manifest_version) >= CHROMIUM_ACTION_FROM_MANIFEST ? refusedSizes(row(manifest.action).default_icon) : [];

  if (Number(manifest.manifest_version) >= CHROMIUM_CHROME_STYLE_FROM_MANIFEST && "chrome_style" in optionsUi) {
    out.push({
      keys: ["options_ui.chrome_style"],
      reason: `options_ui.chrome_style is set to ${JSON.stringify(optionsUi.chrome_style)}, and Chromium answers "The chrome_style option cannot be used with manifest version 3." for any value, false included; delete the key`,
    });
  }

  if (iconKeys.length) {
    out.push({
      keys: iconKeys.map((key) => `icons.${key}`),
      reason: `icons has ${iconKeys.length === 1 ? "the key" : "the keys"} ${iconKeys.map((key) => `"${key}"`).join(", ")}, and Chromium answers "Invalid key in icons" for a key that is not a whole pixel size from 1 to ${CHROMIUM_ICON_KEY_MAX}; keep sizes such as "16", "48" and "128" and move anything else out of icons`,
    });
  }

  if (actionIconKeys.length) {
    out.push({
      keys: actionIconKeys.map((key) => `action.default_icon.${key}`),
      reason: `action.default_icon has ${actionIconKeys.length === 1 ? "the key" : "the keys"} ${actionIconKeys.map((key) => `"${key}"`).join(", ")}, and Chromium refuses the extension over an icon key that is not a whole pixel size from 1 to ${CHROMIUM_ICON_KEY_MAX}; keep sizes such as "16" and "32" there`,
    });
  }

  return out;
}
