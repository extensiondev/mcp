// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import { linkItemSentences, nextStep } from "./store-connection";

import type { ItemLinkUrls, NextStep } from "./store-connection";

export const LINK_ITEM_POINTER =
  "Say value.sayToPerson to the owner as it is: one step is theirs, creating the Chrome Web Store item with the package it names and pasting the item's dashboard address on the link page it names.";

export interface LinkItemAnswer {
  sayToPerson: string;
  nextStep: NextStep;
  hint: string;
}

export function linkItemAnswer(urls: ItemLinkUrls): LinkItemAnswer {
  return {
    sayToPerson: linkItemSentences(urls),
    nextStep: nextStep("link-item", LINK_ITEM_POINTER, urls.linkItemUrl),
    hint: LINK_ITEM_POINTER,
  };
}
