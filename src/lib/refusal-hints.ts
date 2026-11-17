// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { ErrorCode } from "./envelope";

/* @invariant EVERY REFUSAL CARRIES error.code AND A NON-EMPTY error.hint
 * THAT NAMES WHAT TO CHANGE OR WHICH TOOL TO CALL NEXT (Cezar's ruling of
 * 2026-11-17, ledger 912). A call site that knows the case writes its own
 * hint, in error.hint or in the frame's hint, and that one wins. This table
 * is the floor under every site that writes none: one sentence or two per
 * code, true whatever tool answered, and short because it is paid on every
 * refusal. It is a Record over the ErrorCode union, so a code added to the
 * union without a line here does not compile. `{command}` is replaced by
 * the tool that answered. A code that is not in the union reached this
 * server from the project's Extension.js engine, whose list moves with its
 * version; ENGINE_CODE_HINT answers for those. Before 912 the lab's matrix
 * counted 2,166 E_INPUT_VALIDATION, 241 E_BAD_REQUEST and 152
 * E_SESSION_NOT_FOUND refusals with a code and no hint.
 */
export const REFUSAL_HINTS: Record<ErrorCode, string> = {
  E_ACTION_NOT_REPLAYED: 'The click was not replayed. Run the code its listener calls with extension_eval (context: "background").',
  E_AMBIGUOUS_TARGET: "Pass targetId with the one you mean from matchingTargets, or a url that matches only that page.",
  E_ASSERT_FAILED: "Fix what each failing check in value.checks names in its detail, then call extension_assert again.",
  E_APPROVAL_PENDING: "A person has not decided this approval yet. Ask them to decide it on its page, then call {command} again with the same approvalId.",
  E_APPROVAL_REJECTED: "This approval cannot run the act. Call {command} again with no approvalId to request a new one.",
  E_APPROVAL_REQUIRED: "A person must approve this act first. Give them the approval page this answer names, then call {command} again with its approvalId.",
  E_ARTIFACTS_UNVERIFIED: "Do not run the downloaded package: it is not the file the platform recorded. Call {command} again later to download it anew.",
  E_AUTH_DENIED: 'This login may not do this. extension_auth (action: "status") lists the logins on this machine; log in to the project with extension_auth (action: "login", project).',
  E_AUTH_EXPIRED: 'The stored login expired. Sign in again with extension_auth (action: "login"), then call {command} again.',
  E_AUTH_FAILED: 'The login did not complete. Start it again with extension_auth (action: "login").',
  E_AUTH_REQUIRED: 'No usable login is stored for this. Sign in with extension_auth (action: "login"), then call {command} again.',
  E_BAD_HOST_URL: "Pass host as a full http or https URL of the page that serves the preview.",
  E_BAD_MANIFEST: "Fix manifest.json where error.message points, then confirm with extension_manifest_validate.",
  E_BAD_REQUEST: "Nothing ran. Change the argument error.message names and call {command} again.",
  E_BRIDGE: "The extension's bridge did not answer. extension_doctor with the same projectPath says which leg of the session is down.",
  E_BROWSER_EXITED: "The browser is gone. Call extension_dev with replace: true to launch it again; extension_logs reads what it wrote first.",
  E_BROWSER_INSTALL: 'extension_browsers with action: "detect" says which binaries this machine already has; a system install may serve the session.',
  E_BROWSER_UNINSTALL: 'extension_browsers with action: "list" shows what is still in the managed cache.',
  E_BUILD_FAILED: "Fix the errors this answer carries, then call extension_build again.",
  E_BUILD_NOT_FOUND: 'extension_builds with action: "list" names the builds this project has; pass one of its ids.',
  E_BUILD_TIMEOUT: "The build did not finish inside this call. Call extension_build again; extension_doctor with no projectPath checks node and the CLI if it repeats.",
  E_CAPTURE_FAILED: "No image was captured. Open the page with extension_open, then call extension_screenshot again.",
  E_CAPTURE_TIMEOUT: "The capture ran out of time. Call extension_screenshot again once the page has finished loading.",
  E_CARRIER_IN_DIST: "Delete the paths error.message lists from the build output, then call extension_build again.",
  E_CDP: "The session's debug port did not answer. extension_doctor says whether the browser is still up; if it is, call {command} again.",
  E_CLI: "The Extension.js CLI failed before it answered. extension_doctor with the same projectPath reports the project's engine and its session.",
  E_COMMAND_UNSUPPORTED_FOR_TARGET: "This act has no route to that target in this browser. extension_dom_snapshot with listTargets: true lists the targets; pick another context or tab.",
  E_COMPILE: 'Fix the compile errors in error.message, then call extension_wait with for: "rebuild".',
  E_CONFIG: "The local file error.message names is unreadable. Fix or move it, then call {command} again.",
  E_CONSOLE_ONLY: "A person does this step in the extension.dev console. Give them the page this answer names.",
  E_CONTENT_WORLD_ORPHANED: 'Reload the tab so the content script runs again (extension_eval with context: "page" and location.reload()), then call {command} again.',
  E_CONTRACT_ERROR: "The session did not come up. Fix the cause in error.message, then call extension_dev again; extension_doctor checks each leg.",
  E_CONTROL_CHANNEL: "The session's control channel refused or dropped this call. extension_logs without follow still reads the log file; extension_doctor checks the channel.",
  E_CONTROL_DENIED: "The session runs with allowControl: false. Call extension_dev with replace: true and without it, then call {command} again.",
  E_CONTROL_ENVELOPE: "The project's Extension.js speaks another control envelope version than this server. extension_doctor reports both; update the project's engine.",
  E_CONTROL_UNAVAILABLE: "The extension's executor is not connected. Call extension_wait until the session is ready; extension_doctor names the leg that is down.",
  E_CREATE_STUCK: "The create may have landed. Read whether it exists in the extension.dev console before calling {command} again.",
  E_CSP_BLOCKS_EVAL: "A content security policy forbids eval in that context. Pass url so the tab is evaluated over the debugger, or read it with extension_dom_snapshot.",
  E_DEV_SESSION_DIST_SHARED: "Pass outDir to build beside the running session, or call extension_stop with this projectPath and browser first.",
  E_ELEMENT_AMBIGUOUS: "Narrow selector until it matches one element (an id or :nth-of-type).",
  E_ELEMENT_NOT_EDITABLE: "Pick a selector that matches an input, a textarea, a select or a contenteditable element.",
  E_ELEMENT_NOT_FOUND: 'extension_dom_snapshot with include: ["html"] shows the markup to pick a selector from; extension_element with action: "wait" waits for a late element.',
  E_ELEMENT_NOT_VISIBLE: 'Wait for the element with action: "wait", pick one that renders, or pass x and y.',
  E_ENGINE_TOO_OLD: "Update the project's Extension.js to the version extension_doctor says this server pins, then call {command} again.",
  E_ENTRYPOINT_MISSING: "Point each manifest entry error.message lists at a file that exists in the source, then call extension_build again.",
  E_EVAL: "The expression threw or could not run. Fix it where error.message points; extension_doctor says whether the session is still up.",
  E_EVAL_DISABLED: "Call extension_dev again with allowEval: true and replace: true, then extension_eval again.",
  E_EVAL_NOT_CLONEABLE: "Return plain data, or JSON.stringify of it, instead of a promise, a DOM node or a function.",
  E_EXTENSION_PAGE_UNREACHABLE: "No route reaches that extension page in this session. Open it in a tab with extension_open and its url, or use extension_dev, whose pages carry the relay.",
  E_EXTENSION_RELOADING: 'The extension is reloading. Call extension_wait with for: "rebuild", then call {command} again.',
  E_FIRST_COMPILE: "The first compile failed. Fix the errors in error.message, then call extension_dev again.",
  E_INPUT_VALIDATION: "Change the arguments value.issues names; value.args lists the required and optional arguments of {command}.",
  E_INTERNAL: "This is a fault in the server, not in the call. Read the state the call changes, call {command} again, and if it repeats report error.message at https://github.com/extensiondev/mcp/issues.",
  E_INVALID_BUNDLE_ID: 'Pass a reverse-domain bundle identifier under a domain you own, such as "com.acme.readinglist".',
  E_LOGS_MISSING: "No log file exists yet. Start a session with extension_dev, or pass the browser of the session that is running.",
  E_MANIFEST_BLOCKING: "Fix each manifest error in value.errors, then call extension_build again; extension_manifest_validate reads the same checks without building.",
  E_MANIFEST_NOT_FOUND: "Pass the projectPath whose root or src folder holds manifest.json; extension_create scaffolds a new project.",
  E_NAVIGATE_ERROR: "The browser did not load the address. Check url, and whether the session is up with extension_doctor.",
  E_NAVIGATE_FAILED: "The browser did not load the address. Check url, and whether the session is up with extension_doctor.",
  E_NETWORK: "The host error.message names could not be reached. Check the network, then call {command} again.",
  E_NOT_ATTACHED: "The extension compiled but its runtime never connected. extension_doctor names the leg that failed; extension_dev with replace: true launches the browser again.",
  E_NOT_IMPLEMENTED: "The project's engine has no implementation of this for the session's browser. Pass another browser, or use the route error.message names.",
  E_NO_BACKGROUND: "No background of this extension is running. Confirm the session is ready with extension_wait and that the manifest declares a background.",
  E_NO_CONTEXT_MENUS: 'Add "contextMenus" to the manifest permissions and rebuild.',
  E_NO_CONTROL_CHANNEL: "The session runs without its control channel. Call extension_dev with replace: true and without allowControl: false, then call {command} again.",
  E_NO_DIST: "No build output exists for this browser. Run extension_build first.",
  E_NO_EXTENSION_ID: "The session has not reported its extension id. Call extension_wait until it is ready, then call {command} again.",
  E_NO_LISTENER: "Register the listener at the top level of the service worker so it is there on every start; extension_logs shows the worker's startup.",
  E_NO_LOGIN_FOR_PROJECT: 'Log in to that project with extension_auth (action: "login", project), then call {command} again.',
  E_NO_MATCHING_TARGET: "No open page matches. extension_dom_snapshot with listTabs: true lists what is open; extension_open with url opens the page.",
  E_NO_REFERENCE_TEMPLATE: 'No template serves as the reference for this. extension_templates with action: "list" names the ones that exist.',
  E_NO_SESSION: "No dev session runs for this project and browser. Start one with extension_dev, or pass the browser of the session that is running.",
  E_NO_SURFACE_DOCUMENT: "The manifest declares no page for this surface. Declare it and rebuild, or pass a surface the manifest has.",
  E_NO_TARGET: "Nothing is open to act on. Open the page or surface with extension_open; extension_dom_snapshot with listTargets: true lists what is open.",
  E_NO_THEME: "Add a `theme` object with colors, tints, images or properties to the manifest.",
  E_PAGE_NOT_SCRIPTABLE: 'Pass context: "page" to read the tab over the debugger protocol, or pick a tab an extension may script.',
  E_PAGE_PAUSED: "A debugger paused the page. Ask the person to press Resume in that DevTools or close it, then call {command} again.",
  E_PARSE: "The file or answer error.message names is not valid JSON. Fix it, then call {command} again.",
  E_PLATFORM: "The platform refused or failed the request, for the reason in error.message. Read the state this call changes before repeating it.",
  E_PREVIEW_HOST_UNREACHABLE: "Start the host error.message names, or pass a host that is serving, then call {command} again.",
  E_PROFILE_LOCKED: "Another browser holds this profile. Call extension_stop with the same projectPath and browser, then extension_dev again.",
  E_PROJECT_AMBIGUOUS: 'Pass project as "<workspace>/<project>" to name the one you mean; extension_auth (action: "status") lists the logins.',
  E_RDP: "Firefox's debugger port did not answer. extension_doctor says whether the browser is still up; if it is, call {command} again.",
  E_SAFARI_APP_BUILDING: "The Safari app is still building. Call extension_wait with the same projectPath and browser, then call {command} again.",
  E_SAFARI_CONTEXT_UNREACHABLE: "On Safari, extension_eval reaches page contexts only. Read the extension's own contexts with extension_logs and its storage with extension_storage.",
  E_SAFARI_ONLY_OPTION: 'Pass browser: "safari" to use these options, or drop them.',
  E_SCAFFOLD_FAILED: "No usable project was scaffolded. Fix the cause in error.message (projectName, parentDir or template), then call extension_create again.",
  E_SCAFFOLD_INCOMPLETE: "Do not run this folder. Remove it and call extension_create again, or pick another template from extension_templates.",
  E_SERVER_STALE: "Run /mcp in the client and reconnect this server so it loads the build on disk, then call {command} again.",
  E_SESSION_AMBIGUOUS: "Pass browser to name which of this project's live sessions you mean.",
  E_SESSION_EXISTS: "A session already runs for this project and browser. Use it, or call {command} again with replace: true to stop it first.",
  E_SESSION_EXITED: "The session's process exited. Fix the cause error.message or extension_logs names, then call extension_dev again.",
  E_SESSION_NOT_FOUND: "No dev session is recorded for this projectPath and browser. Start one with extension_dev, or pass the browser of the session that is running.",
  E_STALE_CONTRACT: "The session record belongs to a session that is gone. Call extension_stop to clear it, then extension_dev to start a new one.",
  E_STOP_INCOMPLETE: "Not everything was stopped. Call extension_stop again; extension_doctor with the same projectPath says what is still up.",
  E_SURFACE_DID_NOT_OPEN: "Call extension_open again with asTab: true, which renders the surface in a tab.",
  E_SURFACE_NOT_CAPTURABLE: 'Capture this surface on a Chromium or Firefox session, or a web page here with context: "page".',
  E_TAB_NOT_FOUND: "Pass a tab id from extension_dom_snapshot with listTabs: true, or omit tab to use the active tab.",
  E_TARGET_NOT_FOUND: "extension_dom_snapshot with listTargets: true lists what is open; extension_open opens the page or surface first.",
  E_TEAM_UNKNOWN_TO_XCODE: "Sign in to that Apple team in Xcode (Settings, Accounts), or pass a team Xcode already lists.",
  E_TEMPLATE_FETCH: 'The template could not be downloaded. Check the network and call {command} again; extension_templates with action: "list" names the slugs.',
  E_TEMPLATE_NOT_FOUND: 'Call extension_templates with action: "list" and pass one of its slugs.',
  E_TOOL_DISABLED: "This server was started without this tool's feature group, or in no-ship mode. Change --features or drop --no-ship in its MCP config, or ask the user to.",
  E_UNHEALTHY: "Apply the remediation of each failing check in value.checks, then call extension_doctor again.",
  E_UNKNOWN_COMMAND: "Pass a name the manifest's `commands` declares.",
  E_UNKNOWN_TOOL: "Call one of the tools value.availableTools lists.",
  E_UNSPECIFIED: "The tool gave no error detail. Read status and value in this answer; extension_doctor with the same projectPath checks the session.",
  E_UNSUPPORTED_BROWSER: "This browser has no route for this call, for the reason in error.message. Pass another browser, or call the tool it names.",
  E_USER_GESTURE_REQUIRED: "The browser opens this surface only on a real click. Call extension_open again with asTab: true to render it in a tab.",
  E_WAIT_TIMEOUT: "The wait ended before the condition held. Call {command} again with a larger timeout, or read the current state first.",
  E_WEBDRIVER_SESSION_ENDED: 'Safari\'s automation window is gone. Call extension_dev with browser: "safari" and replace: true to open it again.',
};

export const ENGINE_CODE_HINT =
  "This code comes from the project's Extension.js engine and error.message is its diagnosis. extension_doctor with the same projectPath checks the session leg by leg.";

function known(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(REFUSAL_HINTS, code);
}

export function defaultRefusalHint(code: unknown, command: string): string {
  const text = typeof code === "string" && known(code) ? REFUSAL_HINTS[code] : ENGINE_CODE_HINT;

  return text.replaceAll("{command}", command);
}

function said(hint: unknown): string | null {
  return typeof hint === "string" && hint.trim() ? hint : null;
}

export function withRefusalHint<T extends { code?: unknown; hint?: unknown }>(error: T, command: string, frameHint?: unknown): T & { hint: string } {
  return { ...error, hint: said(error.hint) ?? said(frameHint) ?? defaultRefusalHint(error.code, command) };
}
