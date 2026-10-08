// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

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
const PLATFORM = "the server started with --features=local,platform";
const LOGIN = `${PLATFORM}, and a login`;

export const TOOL_DOCS: Record<string, ToolDocsMeta> = {
  extension_create: { tier: "build", gate: NONE, samplePrompt: "Create a new tab extension with React in ./my-newtab" },
  extension_templates: { tier: "build", gate: NONE, samplePrompt: "Which templates have a side panel? Show me the source of the best one" },
  extension_docs_search: { tier: "build", gate: NONE, samplePrompt: "How does Firefox handle the sidebar API? Search the docs before you answer" },
  extension_add_feature: { tier: "build", gate: NONE, samplePrompt: "Add an options page to this extension" },
  extension_build: { tier: "build", gate: NONE, samplePrompt: "Build this extension for Chrome and Firefox" },
  extension_dev: { tier: "run", gate: NONE, samplePrompt: "Run my extension in Chrome and let me act on it" },
  extension_start: { tier: "run", gate: NONE, samplePrompt: "Launch the production build in Edge" },
  extension_wait: { tier: "run", gate: SESSION, samplePrompt: "Wait until the dev session is ready, then tell me the ports" },
  extension_stop: { tier: "run", gate: SESSION, samplePrompt: "Stop the running session and close its browser" },
  extension_manifest_validate: { tier: "see", gate: NONE, samplePrompt: "Will this manifest load on Firefox and Safari?" },
  extension_analyze: { tier: "see", gate: NONE, samplePrompt: "What is in the built extension and is anything too big for the store?" },
  extension_inspect: { tier: "see", gate: SESSION, samplePrompt: "Read the DOM the content script injected on the cart page, shadow roots included" },
  extension_dom_snapshot: { tier: "see", gate: CONTROL, samplePrompt: "Snapshot the popup and tell me what it rendered" },
  extension_list_extensions: { tier: "see", gate: SESSION, samplePrompt: "Which extensions are loaded in the dev browser right now?" },
  extension_logs: { tier: "see", gate: SESSION, samplePrompt: "Show me every log line since the session started, in order" },
  extension_doctor: { tier: "see", gate: SESSION, samplePrompt: "The session looks stuck. Diagnose it" },
  extension_theme_verify: { tier: "see", gate: NONE, samplePrompt: "Does this theme manifest paint the colors it declares?" },
  extension_assert: { tier: "test", gate: SESSION, samplePrompt: "Check that the worker booted, the popup rendered and the console is clean" },
  extension_eval: { tier: "act", gate: EVAL, samplePrompt: "Evaluate chrome.runtime.id in the background and in the popup" },
  extension_storage: { tier: "act", gate: CONTROL, samplePrompt: "Read chrome.storage.local and set settings.theme to dark" },
  extension_reload: { tier: "act", gate: CONTROL, samplePrompt: "Reload the extension and confirm the worker came back" },
  extension_open: { tier: "act", gate: CONTROL, samplePrompt: "Open the side panel, then trigger the action button" },
  extension_browsers: { tier: "browsers", gate: NONE, samplePrompt: "Which browsers are installed here? Install Firefox if it is missing" },
  extension_auth: { tier: "platform", gate: PLATFORM, samplePrompt: "Log this machine in to the acme/newtab project on extension.dev" },
  extension_workspace_create: { tier: "platform", gate: PLATFORM, samplePrompt: "Create a workspace called acme on extension.dev" },
  extension_project_create: { tier: "platform", gate: PLATFORM, samplePrompt: "Create the extension.dev project for this build under acme" },
  extension_preview_web: { tier: "platform", gate: `${PLATFORM}; sharing needs a login`, samplePrompt: "Share this build with my designer" },
  extension_shares: { tier: "platform", gate: LOGIN, samplePrompt: "List every link I have shared and revoke the oldest one" },
  extension_publish: { tier: "platform", gate: LOGIN, samplePrompt: "Give me the shareable URL of the latest build" },
  extension_release_promote: { tier: "platform", gate: LOGIN, samplePrompt: "Promote build 3f2a1c to the beta channel" },
  extension_submit: { tier: "platform", gate: `${LOGIN}; dryRun: false needs the workspace owner's token`, samplePrompt: "Dry run a Chrome and Firefox store submission of the latest build" },
  extension_release_status: { tier: "platform", gate: LOGIN, samplePrompt: "Was the last Chrome submission approved?" },
};
