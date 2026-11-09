// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { ConnectStore } from "./connect-session";

const STORE_KEY_PAGE_NOTES: Record<ConnectStore, string> = {
  chrome: "",
  firefox:
    'AMO shows the JWT secret only when it generates the pair; if you do not hold it in a password manager, the button to press on the key page is "Revoke and regenerate credentials", which voids the pair every other tool holds, and the new pair must be pasted into the connect page right away.',
  edge: "",
  safari:
    'On the App Store key page, press the "+" beside "Active" (not Edit, which only revokes keys), name the key, give it App Manager access and use "Download API Key" in that dialog, because the .p8 is offered once; the Issuer ID is at the top of that page and the Key ID is in the new row.',
};

export function storeKeyPageNote(store: ConnectStore): string {
  return STORE_KEY_PAGE_NOTES[store];
}

export function withStoreKeyPageNote(store: ConnectStore, sentences: string): string {
  const note = storeKeyPageNote(store);

  return note ? `${sentences} ${note}` : sentences;
}
