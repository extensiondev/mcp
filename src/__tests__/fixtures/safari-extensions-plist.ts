// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface PlistRowFixture {
  id: string;
  identity: string;
  enabled?: boolean;
  removedAt?: string;
  addedAt?: string;
}

export const TEAM = "JU3XAJJQ2G";

export const TEAM_SIGNED_CODESIGN = `Identifier=com.acme.visionario\nTeamIdentifier=${TEAM}\nAuthority=Apple Development: Acme (ABC123)\n`;

export const AD_HOC_CODESIGN = "Identifier=com.acme.visionario\nSignature=adhoc\nTeamIdentifier=not set\n";

function row(fixture: PlistRowFixture): string {
  const lines = [
    `\t<key>${fixture.id} (${fixture.identity})</key>`,
    "\t<dict>",
    "\t\t<key>AccessibleOrigins</key>",
    "\t\t<array/>",
    "\t\t<key>AddedDate</key>",
    `\t\t<date>${fixture.addedAt ?? "2026-11-06T17:55:22Z"}</date>`,
    ...(fixture.enabled === undefined
      ? []
      : ["\t\t<key>Enabled</key>", `\t\t<${fixture.enabled}/>`, "\t\t<key>EnabledModificationDate</key>", "\t\t<date>2026-11-06T18:25:36Z</date>"]),
    "\t\t<key>GrantedPermissionOrigins</key>",
    "\t\t<dict>",
    "\t\t\t<key>*://*/*</key>",
    "\t\t\t<date>4001-01-01T00:00:00Z</date>",
    "\t\t</dict>",
    "\t\t<key>GrantedPermissions</key>",
    "\t\t<dict>",
    "\t\t\t<key>storage</key>",
    "\t\t\t<date>4001-01-01T00:00:00Z</date>",
    "\t\t</dict>",
    "\t\t<key>HasAbilityToInjectContentIntoWebpages</key>",
    "\t\t<true/>",
    "\t\t<key>Permissions</key>",
    "\t\t<array>",
    "\t\t\t<string>storage</string>",
    "\t\t\t<string>tabs &amp; scripting</string>",
    "\t\t</array>",
    ...(fixture.removedAt ? ["\t\t<key>RemovedDate</key>", `\t\t<date>${fixture.removedAt}</date>`] : []),
    "\t</dict>",
  ];

  return `${lines.join("\n")}\n`;
}

export function extensionsPlistXml(rows: PlistRowFixture[]): string {
  const head = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
  ];

  return `${head.join("\n")}\n${rows.map(row).join("")}</dict>\n</plist>\n`;
}
