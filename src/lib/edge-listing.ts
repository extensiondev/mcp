// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const EDGE_CRX_ID = /^[a-p]{32}$/;

export function edgeListingUrlOf(raw: unknown): string {
  const value = str(raw);
  if (EDGE_CRX_ID.test(value)) return `https://microsoftedge.microsoft.com/addons/detail/${value}`;

  const match = value.match(/^https:\/\/microsoftedge\.microsoft\.com\/addons\/detail\/(?:[^/?#]+\/)?([a-p]{32})\/?(?:[?#].*)?$/);

  return match ? `https://microsoftedge.microsoft.com/addons/detail/${match[1]}` : "";
}

/* @invariant AN EDGE LINK THE STORE ANSWERS 404 FOR IS NEVER RELAYED. Edge
 * Add-ons keys a listing by the crx id; a link built from the Partner Center
 * product id is dead (Rebeccat, 2026-10-26), and older records and platforms
 * still carry it. An Edge storeUrl reads as the canonical crx id link, else
 * the configured listing, else nothing.
 */
export function repairEdgeStoreUrl(raw: unknown, configured?: unknown): string {
  return edgeListingUrlOf(raw) || edgeListingUrlOf(configured);
}
