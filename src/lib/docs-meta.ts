// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { TOOL_TWINS } from "./tool-twins";

export type DocsTier = "build" | "run" | "see" | "test" | "act" | "browsers" | "platform";

export interface ToolDocsMeta {
  tier: DocsTier;
  gate: string;
  samplePrompt: string;
}

const NONE = "none";
const SESSION = "a live dev or start session";
const CONTROL = "a dev session, which carries control unless started with allowControl: false";
const EVAL = "a session started with allowEval: true on extension_dev";
const CHROMIUM_SESSION = "a live Chromium dev or start session with its debug port; no allowEval";
const PLATFORM = "the server started with --features=local,platform";
const LOGIN = `${PLATFORM}, and a login`;
const EXTRAS = "the server started with extras in --features, as in --features=local,platform,extras";

export const TOOL_DOCS: Record<string, ToolDocsMeta> = {
  extension_create: { tier: "build", gate: NONE, samplePrompt: "Create a new tab extension with React in ./my-newtab" },
  extension_templates: { tier: "build", gate: NONE, samplePrompt: "Which templates have a side panel? Show me the source of the best one" },
  extension_docs_search: { tier: "build", gate: NONE, samplePrompt: "How does Firefox handle the sidebar API? Search the docs before you answer" },
  extension_add_feature: { tier: "build", gate: NONE, samplePrompt: "Add an options page to this extension" },
  extension_build: { tier: "build", gate: NONE, samplePrompt: "Build this extension for Chrome and Firefox" },
  extension_dev: { tier: "run", gate: NONE, samplePrompt: "Run my extension in Chrome and let me act on it" },
  extension_start: { tier: "run", gate: NONE, samplePrompt: "Launch the production build in Edge" },
  extension_try: { tier: "run", gate: `${PLATFORM}; a public project needs no login, a private one a login for it`, samplePrompt: "Try cezaraugusto/rebeccat for me and show me what it does" },
  extension_wait: { tier: "run", gate: `${EXTRAS}; ${SESSION}`, samplePrompt: "Wait until the dev session is ready, then tell me the ports" },
  extension_stop: { tier: "run", gate: SESSION, samplePrompt: "Stop the running session and close its browser" },
  extension_manifest_validate: { tier: "see", gate: NONE, samplePrompt: "Will this manifest load on Firefox and Safari?" },
  extension_analyze: { tier: "see", gate: EXTRAS, samplePrompt: "What is in the built extension and is anything too big for the store?" },
  extension_inspect: { tier: "see", gate: SESSION, samplePrompt: "Read the DOM the content script injected on the cart page, shadow roots included" },
  extension_dom_snapshot: { tier: "see", gate: CONTROL, samplePrompt: "Snapshot the popup and tell me what it rendered" },
  extension_screenshot: { tier: "see", gate: SESSION, samplePrompt: "Open the popup and take a screenshot of it for the store listing" },
  extension_list_extensions: { tier: "see", gate: `${EXTRAS}; ${SESSION}`, samplePrompt: "Which extensions are loaded in the dev browser right now?" },
  extension_logs: { tier: "see", gate: SESSION, samplePrompt: "Show me every log line since the session started, in order" },
  extension_doctor: { tier: "see", gate: SESSION, samplePrompt: "The session looks stuck. Diagnose it" },
  extension_theme_verify: { tier: "see", gate: EXTRAS, samplePrompt: "Does this theme manifest paint the colors it declares?" },
  extension_assert: { tier: "test", gate: SESSION, samplePrompt: "Check that the worker booted, the popup rendered and the console is clean" },
  extension_network: { tier: "test", gate: `${EXTRAS}; ${SESSION} on a Chromium browser`, samplePrompt: "Make the API answer 500 and show me what the popup renders" },
  extension_eval: { tier: "act", gate: EVAL, samplePrompt: "Evaluate chrome.runtime.id in the background and in the popup" },
  extension_storage: { tier: "act", gate: `${EXTRAS}; ${CONTROL}`, samplePrompt: "Read chrome.storage.local and set settings.theme to dark" },
  extension_reload: { tier: "act", gate: `${EXTRAS}; ${CONTROL}`, samplePrompt: "Reload the extension and confirm the worker came back" },
  extension_open: { tier: "act", gate: CONTROL, samplePrompt: "Open the side panel, then trigger the action button" },
  extension_element: { tier: "act", gate: CHROMIUM_SESSION, samplePrompt: "Click the Save button in the popup, then read the status line" },
  extension_browsers: { tier: "browsers", gate: EXTRAS, samplePrompt: "Which browsers are installed here? Install Firefox if it is missing" },
  extension_auth: { tier: "platform", gate: PLATFORM, samplePrompt: "Log this machine in to the acme/newtab project on extension.dev" },
  extension_workspace_create: { tier: "platform", gate: PLATFORM, samplePrompt: "Create a workspace called acme on extension.dev" },
  extension_project_create: { tier: "platform", gate: PLATFORM, samplePrompt: "Create the extension.dev project for this build under acme" },
  extension_preview_web: { tier: "platform", gate: `${NONE} for the local preview; share:true needs ${PLATFORM}, and a login`, samplePrompt: "Share this build with my designer" },
  extension_shares: { tier: "platform", gate: `${LOGIN}; a revoke waits for a workspace member's approval`, samplePrompt: "List every link I have shared and revoke the oldest one" },
  extension_publish: { tier: "platform", gate: `${LOGIN}; sync-captures needs a workspace owner's approval, and a link to a private project a workspace member's`, samplePrompt: "Send the latest build to my testers" },
  extension_release_promote: { tier: "platform", gate: `${LOGIN}; every release, cut and rollback needs a workspace owner's approval`, samplePrompt: "Release build 3f2a1c to Preview" },
  extension_submit: { tier: "platform", gate: `${LOGIN}; dryRun: false, cancel, rollout, release, publish, sync-listing and configure-store need a workspace owner's approval`, samplePrompt: "Dry run a Chrome and Firefox store submission of the latest build" },
  extension_submit_check: { tier: "platform", gate: `${LOGIN}; never sends: asking for the approval of a submit, publish, cancel, rollout, release, derived sync-listing or public configure-store executes nothing, and the approved call runs through extension_submit`, samplePrompt: "Is my extension ready for the Chrome Web Store?" },
  extension_builds: { tier: "platform", gate: LOGIN, samplePrompt: "Why did the last build fail? Show me the Firefox log" },
  extension_builds_act: { tier: "platform", gate: `${LOGIN}; a public channel audience needs a workspace owner's approval; delete-channel stays in the console`, samplePrompt: "Rebuild the last commit for Stable" },
  extension_release_status: { tier: "platform", gate: LOGIN, samplePrompt: "Was the last Chrome submission approved?" },
  extension_approvals: { tier: "platform", gate: `${LOGIN}; revoke needs a token a workspace owner minted`, samplePrompt: "I approved that App Review submission by mistake, revoke it" },
  extension_workspace: { tier: "platform", gate: `${LOGIN} of any project in the workspace; settings and set-visibility need that project's own login; a public visibility needs a workspace owner's approval`, samplePrompt: "How many builds has my workspace used this month, and which projects failed their last build?" },
};

const TWIN_PROMPTS: Record<string, string> = {
  extension_storage_read: "Read chrome.storage.local and tell me the saved theme",
  extension_storage_write: "Set settings.theme to dark in chrome.storage.local",
  extension_network_read: "Which requests hit the stubbed API so far?",
  extension_network_stub: "Make the API answer 500 and show me what the popup renders",
  extension_shares_read: "List every link I have shared",
  extension_shares_manage: "Revoke the oldest link I shared",
  extension_approvals_read: "Which approvals am I still waiting on?",
  extension_approvals_revoke: "I approved that App Review submission by mistake, revoke it",
  extension_workspace_read: "How many builds has my workspace used this month, and which projects failed their last build?",
  extension_workspace_configure: "Make the newtab project public",
  extension_auth_read: "Which extension.dev logins are stored on this machine?",
  extension_auth_login: "Log this machine in to the acme/newtab project on extension.dev",
  extension_browsers_read: "Which browsers are installed here?",
  extension_browsers_install: "Install Firefox for the dev session",
  extension_submit_read: "Is my extension ready for the Chrome Web Store?",
  extension_builds_read: "Why did the last build fail? Show me the Firefox log",
  extension_builds_download: "Download the last Chrome build to this machine",
  extension_element_read: "Read the status line of the popup",
  extension_element_act: "Click the Save button in the popup",
};

for (const twin of TOOL_TWINS) {
  const base = TOOL_DOCS[twin.of]!;
  const gate = twin.group === "extras" && !base.gate.includes("extras") ? `${EXTRAS}; ${base.gate}` : base.gate;

  TOOL_DOCS[twin.name] = { ...base, gate, samplePrompt: TWIN_PROMPTS[twin.name] ?? base.samplePrompt };
}
