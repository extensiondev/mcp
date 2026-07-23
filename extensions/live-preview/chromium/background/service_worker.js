(()=>{"use strict";JSON.stringify({contentSettings:["contentSettings"],debugger:["debugger"],declarativeNetRequest:["declarativeNetRequest","declarativeNetRequestWithHostAccess"],fontSettings:["fontSettings"],identity:["identity"],idle:["idle"],instanceID:["gcm"],management:["management"],mdns:["mdns"],power:["power"],printerProvider:["printerProvider"],printing:["printing"],privacy:["privacy"],proxy:["proxy"],sidePanel:["sidePanel"],tabCapture:["tabCapture"],tabGroups:["tabGroups"],topSites:["topSites"],tts:["tts"],userScripts:["userScripts"],webNavigation:["webNavigation"],webRequest:["webRequest"]}),JSON.stringify(["getSelf","getPermissionWarningsByManifest","uninstallSelf","installReplacementWebApp"]),JSON.stringify({"system.cpu":["system.cpu"],"system.memory":["system.memory"],"system.storage":["system.storage"],"system.display":["system.display"]}),JSON.stringify(["extension","i18n","runtime","scripting","storage"]);let e={storage:["storage"],notifications:["notifications"],contextMenus:["contextMenus"],downloads:["downloads"],cookies:["cookies"],bookmarks:["bookmarks"],history:["history"],alarms:["alarms"],offscreen:["offscreen"],scripting:["scripting","activeTab"]};function t(t,r){let o=t.split(".")[0]??"",s=e[o];return!s||null===r||s.some(e=>r.has(e))?null:`Extension.dev preview: chrome.${o} needs the "${s.join('" or "')}" permission, which this extension's manifest does not declare.`}function r(e,t,r){let o=t.id===e.activeTabId;return{id:t.id,index:r,windowId:e.id,url:t.url,title:t.title,active:o,highlighted:o,selected:o,pinned:t.pinned??!1,discarded:t.discarded??!1,groupId:t.tabGroupId??-1,status:t.discarded?"unloaded":"complete",incognito:!1}}let o=new Set(["storage.setAccessLevel","storage.get","storage.set","storage.remove","storage.clear","tabs.create","tabs.update","tabs.remove","tabs.move","tabs.discard","tabs.goBack","tabs.goForward","tabs.group","tabs.ungroup","tabGroups.query","tabGroups.get","tabGroups.update","tabGroups.move","tabs.get"]);async function s(e){let{data:t,windows:o,getStorage:s,setStorage:n,removeStorageKeys:a,clearStorage:i,onStorageChanged:l,onCreateTab:c,onUpdateTab:d,onRemoveTab:u,onMoveTab:g,onDiscardTab:m,onGroupTabs:p,onUngroupTabs:h,onQueryTabGroups:f,onGetTabGroup:w,onUpdateTabGroup:b,onMoveTabGroup:y,onTabGoBack:x,onTabGoForward:v,onSetStorageAccessLevel:k,respond:I}=e;switch(t.api){case"storage.setAccessLevel":{let[e,r]=t.args,o=e?.accessLevel;if("TRUSTED_CONTEXTS"!==o&&"TRUSTED_AND_UNTRUSTED_CONTEXTS"!==o)return void I({error:"Invalid access level."});await k?.(t.extensionId,r??"session",o),I({result:void 0});return}case"storage.get":{let[e,r]=t.args,o=s(t.extensionId,r??"local");if(!e)return void I({result:o});if(Array.isArray(e)){let t={};e.forEach(e=>{e in o&&(t[e]=o[e])}),I({result:t});return}if("string"==typeof e)return void I({result:e in o?{[e]:o[e]}:{}});if("object"==typeof e){let t={};Object.keys(e).forEach(r=>{t[r]=r in o?o[r]:e[r]}),I({result:t});return}I({result:o});return}case"storage.set":{let[e,r]=t.args,o=r??"local";if(e&&"object"==typeof e){let r=s(t.extensionId,o),a={};for(let t of Object.keys(e)){let o=r[t],s=e[t];if(JSON.stringify(o)===JSON.stringify(s))continue;let n={newValue:s};t in r&&(n.oldValue=o),a[t]=n}n(t.extensionId,e,o),l&&Object.keys(a).length>0&&l(t.extensionId,a,o)}I({result:!0});return}case"storage.remove":{let[e,r]=t.args,o=r??"local",n=(Array.isArray(e)?e:[e]).filter(Boolean).map(String),i=s(t.extensionId,o),c={};for(let e of n)e in i&&(c[e]={oldValue:i[e]});a(t.extensionId,n,o),l&&Object.keys(c).length>0&&l(t.extensionId,c,o),I({result:!0});return}case"storage.clear":{let[e]=t.args,r=e??"local",o=s(t.extensionId,r),n={};for(let e of Object.keys(o))n[e]={oldValue:o[e]};i(t.extensionId,r),l&&Object.keys(n).length>0&&l(t.extensionId,n,r),I({result:!0});return}case"tabs.create":{let[e]=t.args;I({result:await c(e?.url??"chrome://newtab")??!0});return}case"tabs.update":{let[e,r]=t.args;null!==e&&"object"==typeof e&&(r=e,e=void 0),I({result:await d(e,r??{})??!0});return}case"tabs.remove":{let[e]=t.args;u(e),I({result:void 0});return}case"tabs.move":{let[e,r]=t.args;I({result:await g?.(t.extensionId,e,r??{})});return}case"tabs.discard":{let[e]=t.args;I({result:await m?.(t.extensionId,e)});return}case"tabs.goBack":{let[e]=t.args;await x?.(t.extensionId,e),I({result:void 0});return}case"tabs.goForward":{let[e]=t.args;await v?.(t.extensionId,e),I({result:void 0});return}case"tabs.group":{let[e]=t.args;I({result:await p?.(t.extensionId,e??{})});return}case"tabs.ungroup":{let[e]=t.args;await h?.(t.extensionId,e),I({result:void 0});return}case"tabGroups.query":{let[e]=t.args;I({result:await f?.(t.extensionId,e)??[]});return}case"tabGroups.get":{let[e]=t.args;I({result:await w?.(t.extensionId,e)});return}case"tabGroups.update":{let[e,r]=t.args;I({result:await b?.(t.extensionId,e,r??{})});return}case"tabGroups.move":{let[e,r]=t.args;I({result:await y?.(t.extensionId,e,r??{})});return}case"tabs.get":{let[e]=t.args;for(let t of o)for(let o=0;o<t.tabs.length;o+=1){let s=t.tabs[o];if(s&&s.id===e)return void I({result:r(t,s,o)})}I({error:`No tab with id: ${String(e)}.`})}}}let n=new Set(["tabs.query","sidePanel.open","action.openPopup","runtime.openOptionsPage","devtools.panels.create","action.setPopup","action.getBadgeText","action.getBadgeBackgroundColor","action.getTitle","action.setBadgeText","action.setBadgeBackgroundColor","action.setTitle","action.setIcon"]);async function a(e){let{data:t,windows:o,onOpenSidePanel:s,onOpenActionPopup:n,onOpenOptionsPage:a,onDevtoolsPanelCreate:i,onSetActionPopup:l,onGetActionState:c,onSetBadgeText:d,onSetBadgeBackground:u,onSetActionTitle:g,onSetActionIcon:m,respond:p}=e;switch(t.api){case"tabs.query":{let[e]=t.args,s=o.find(e=>e.focused)??o[0],n=o;e?.windowId!==void 0?n=-2===e.windowId?s?[s]:[]:o.filter(t=>t.id===e.windowId):e?.currentWindow===!0||e?.lastFocusedWindow===!0?n=s?[s]:[]:e?.currentWindow===!1&&(n=o.filter(e=>e!==s));let a=e?.url?Array.isArray(e.url)?e.url:[e.url]:null;p({result:n.flatMap(t=>t.tabs.map((e,o)=>r(t,e,o)).filter(t=>e?.active===void 0||t.active===e.active).filter(t=>e?.pinned===void 0||t.pinned===e.pinned).filter(t=>e?.status===void 0||t.status===e.status).filter(t=>e?.discarded===void 0||t.discarded===e.discarded).filter(t=>e?.groupId===void 0||(t.groupId??-1)===e.groupId).filter(e=>!a||a.some(t=>(function(e,t){if(!e)return!1;if("<all_urls>"===t)return!0;let r=t.replace(/[.+?^${}()|[\]\\]/g,"\\$&");return RegExp(`^${r.replace(/\*/g,".*")}$`).test(e)})(e.url,t))))});return}case"sidePanel.open":s(t.extensionId),p({result:void 0});return;case"action.openPopup":n?.(t.extensionId),p({result:void 0});return;case"runtime.openOptionsPage":a?.(t.extensionId),p({result:void 0});return;case"devtools.panels.create":{let[e]=t.args;i?.(t.extensionId,e?.page??""),p({result:!0});return}case"action.setPopup":{let[e]=t.args;l?.(t.extensionId,e?.popup??""),p({result:void 0});return}case"action.getBadgeText":{let[e]=t.args,r=await c?.(t.extensionId,e?.tabId);p({result:r?.badgeText??""});return}case"action.getBadgeBackgroundColor":{let[e]=t.args,r=await c?.(t.extensionId,e?.tabId);p({result:r?.badgeColor??null});return}case"action.getTitle":{let[e]=t.args,r=await c?.(t.extensionId,e?.tabId);p({result:r?.title??""});return}case"action.setBadgeText":{let[e]=t.args;d(t.extensionId,e?.text,e?.tabId),p({result:!0});return}case"action.setBadgeBackgroundColor":{let[e]=t.args;u(t.extensionId,e?.color,e?.tabId),p({result:!0});return}case"action.setTitle":{let[e]=t.args;g(t.extensionId,e?.title,e?.tabId),p({result:!0});return}case"action.setIcon":{let[e]=t.args,r="string"==typeof e?.path?e.path:"object"==typeof e?.path?Object.values(e.path)[0]:void 0;m(t.extensionId,r),p({result:!0})}}}let i=new Set(["contextMenus.create","contextMenus.update","contextMenus.remove","contextMenus.removeAll","notifications.create","notifications.clear","notifications.update","notifications.getAll","downloads.search","downloads.cancel","downloads.pause","downloads.resume","downloads.erase","downloads.download"]);async function l(e){let{data:t,onCreateContextMenu:r,onUpdateContextMenu:o,onRemoveContextMenu:s,onClearContextMenus:n,onCreateNotification:a,onClearNotification:i,onUpdateNotification:l,onGetNotifications:c,onDownload:d,onSearchDownloads:u,onCancelDownload:g,onPauseDownload:m,onResumeDownload:p,onEraseDownloads:h,respond:f}=e;switch(t.api){case"contextMenus.create":{let[e]=t.args;f({result:await r(t.extensionId,e??{})});return}case"contextMenus.update":{let[e,r]=t.args;f({result:await o(t.extensionId,String(e??""),r??{})});return}case"contextMenus.remove":{let[e]=t.args;f({result:await s(t.extensionId,String(e??""))});return}case"contextMenus.removeAll":return void f({result:await n(t.extensionId)});case"notifications.create":{let[e,r]=t.args,o="string"==typeof e?e:void 0,s="string"==typeof e?r:e;f({result:await a(t.extensionId,o,s??{})});return}case"notifications.clear":{let[e]=t.args;f({result:await i(t.extensionId,String(e??""))});return}case"notifications.update":{let[e,r]=t.args;f({result:await l?.(t.extensionId,String(e??""),r??{})??!1});return}case"notifications.getAll":return void f({result:await c(t.extensionId)});case"downloads.search":{let[e]=t.args;f({result:await u?.(t.extensionId,e)??[]});return}case"downloads.cancel":{let[e]=t.args;await g?.(t.extensionId,e),f({result:void 0});return}case"downloads.pause":{let[e]=t.args;await m?.(t.extensionId,e),f({result:void 0});return}case"downloads.resume":{let[e]=t.args;await p?.(t.extensionId,e),f({result:void 0});return}case"downloads.erase":{let[e]=t.args;f({result:await h?.(t.extensionId,e)??[]});return}case"downloads.download":{let[e]=t.args;f({result:await d(t.extensionId,e??{})})}}}let c=new Set(["bookmarks.getTree","bookmarks.get","bookmarks.getChildren","bookmarks.search","bookmarks.create","bookmarks.update","bookmarks.remove","bookmarks.removeTree","bookmarks.move","history.search","history.getVisits","history.addUrl","history.deleteUrl","history.deleteRange","history.deleteAll","windows.get","windows.getAll","windows.getCurrent","windows.create","windows.update","windows.remove"]);async function d(e){let{data:t,windows:r,onGetWindow:o,onGetAllWindows:s,onCreateWindow:n,onUpdateWindow:a,onRemoveWindow:i,onGetBookmarkTree:l,onGetBookmarks:c,onGetBookmarkChildren:d,onSearchBookmarks:u,onCreateBookmark:g,onUpdateBookmark:m,onRemoveBookmark:p,onMoveBookmark:h,onSearchHistory:f,onGetHistoryVisits:w,onAddHistoryUrl:b,onDeleteHistoryUrl:y,onDeleteHistoryRange:x,onDeleteAllHistory:v,respond:k}=e;switch(t.api){case"bookmarks.getTree":return void k({result:await l(t.extensionId)});case"bookmarks.get":{let[e]=t.args,r=Array.isArray(e)?e:[e];k({result:await c(t.extensionId,r.filter(e=>null!=e).map(String))});return}case"bookmarks.getChildren":{let[e]=t.args;k({result:await d(t.extensionId,null==e?void 0:String(e))});return}case"bookmarks.search":{let[e]=t.args;k({result:await u(t.extensionId,e)});return}case"bookmarks.create":{let[e]=t.args;k({result:await g(t.extensionId,e??{})});return}case"bookmarks.update":{let[e,r]=t.args;k({result:await m(t.extensionId,String(e??""),r??{})});return}case"bookmarks.remove":{let[e]=t.args;k({result:await p(t.extensionId,String(e??""),!1)});return}case"bookmarks.removeTree":{let[e]=t.args;k({result:await p(t.extensionId,String(e??""),!0)});return}case"bookmarks.move":{let[e,r]=t.args;k({result:await h?.(t.extensionId,String(e??""),r??{})});return}case"history.search":{let[e]=t.args;k({result:await f(t.extensionId,e??{})});return}case"history.getVisits":{let[e]=t.args;k({result:await w(t.extensionId,e??{})});return}case"history.addUrl":{let[e]=t.args;await b(t.extensionId,e??{}),k({result:!0});return}case"history.deleteUrl":{let[e]=t.args;await y(t.extensionId,e??{}),k({result:!0});return}case"history.deleteRange":{let[e]=t.args;await x(t.extensionId,e??{}),k({result:!0});return}case"history.deleteAll":await v(t.extensionId),k({result:!0});return;case"windows.get":{let[e,r]=t.args;k({result:await o(t.extensionId,null==e?void 0:String(e),r)});return}case"windows.getAll":{let[e]=t.args;k({result:await s(t.extensionId,e)});return}case"windows.getCurrent":{let e=r.find(e=>e.focused)??r[0];k({result:e?{id:e.id,focused:!0,tabs:e.tabs}:null});return}case"windows.create":{let[e]=t.args;k({result:await n(t.extensionId,e?.url)});return}case"windows.update":{let[e,r]=t.args;k({result:await a(t.extensionId,null==e?void 0:String(e),r??{})});return}case"windows.remove":{let[e]=t.args;k({result:await i(t.extensionId,null==e?void 0:String(e))})}}}let u=new Set(["runtime.sendMessage","tabs.sendMessage","runtime.getContexts","permissions.contains","permissions.request","permissions.remove","permissions.getAll","offscreen.createDocument","offscreen.closeDocument","offscreen.hasDocument","cookies.get","cookies.getAll","cookies.set","cookies.remove","scripting.executeScript","scripting.insertCSS"]);async function g(e){let{data:t,onRuntimeMessage:r,onTabMessage:o,onGetRuntimeContexts:s,onContainsPermissions:n,onRequestPermissions:a,onRemovePermissions:i,onGetAllPermissions:l,onCreateOffscreenDocument:c,onCloseOffscreenDocument:d,onHasOffscreenDocument:u,onGetCookie:g,onGetAllCookies:m,onSetCookie:p,onRemoveCookie:h,onExecuteScript:f,onInsertCss:w,respond:b,source:y}=e;switch(t.api){case"runtime.sendMessage":{let[e]=t.args;b({result:await r(t.extensionId,e,y)});return}case"tabs.sendMessage":{let[e,r]=t.args;if(!o)return void b({error:"Could not establish connection. Receiving end does not exist."});b({result:await o(t.extensionId,e,r)});return}case"runtime.getContexts":return void b({result:await s(t.extensionId)});case"permissions.contains":{let[e]=t.args;b({result:await n(t.extensionId,e??{})});return}case"permissions.request":{let[e]=t.args;b({result:await a(t.extensionId,e??{})});return}case"permissions.remove":{let[e]=t.args;b({result:await i(t.extensionId,e??{})});return}case"permissions.getAll":return void b({result:await l(t.extensionId)});case"offscreen.createDocument":{let[e]=t.args,r=await c(t.extensionId,e??{});b({result:"boolean"!=typeof r||r});return}case"offscreen.closeDocument":{let e=await d(t.extensionId);b({result:"boolean"!=typeof e||e});return}case"offscreen.hasDocument":return void b({result:await u(t.extensionId)});case"cookies.get":{let[e]=t.args;b({result:await g(t.extensionId,e??{})});return}case"cookies.getAll":{let[e]=t.args;b({result:await m(t.extensionId,e??{})});return}case"cookies.set":{let[e]=t.args;b({result:await p(t.extensionId,e??{})});return}case"cookies.remove":{let[e]=t.args;b({result:await h(t.extensionId,e??{})});return}case"scripting.executeScript":{let[e]=t.args;b({result:await f(t.extensionId,e??{})});return}case"scripting.insertCSS":{let[e]=t.args;await w(t.extensionId,e??{}),b({result:!0})}}}async function m(e){let{data:r,respond:m,getDeclaredPermissions:p,getSessionStorageAccessLevel:h}=e;try{if(p){let e=t(r.api,p(r.extensionId));if(e)return void m({error:e})}if(r.untrustedContext&&r.api.startsWith("storage.")){let e="storage.clear"===r.api?r.args[0]:r.args[1],t=h?.(r.extensionId)??"TRUSTED_CONTEXTS";if("session"===e&&"TRUSTED_AND_UNTRUSTED_CONTEXTS"!==t)return void m({error:"Access to storage is not allowed from this context."})}if(o.has(r.api))return void await s(e);if(n.has(r.api))return void await a(e);if(i.has(r.api))return void await l(e);if(c.has(r.api))return void await d(e);if(u.has(r.api))return void await g(e);m({error:`Unsupported API: ${r.api}`})}catch(e){m({error:e instanceof Error?e.message:"Unknown error"})}}let p=e=>{let t=Number(e);return Number.isFinite(t)?t:void 0},h=e=>{let t=Number(e);return Number.isFinite(t)?t:void 0},f=new Set(["system.cpu.getInfo","system.memory.getInfo","system.storage.getInfo","system.storage.ejectDevice","system.display.getInfo","system.display.getDisplayLayout","system.display.setDisplayProperties","system.display.setDisplayLayout"]),w=["topSites","fontSettings","printing","power","tts","userScripts","debugger","system.network","enterprise.deviceAttributes","instanceID","identity","webNavigation","proxy.settings","contentSettings","tabCapture"].sort((e,t)=>t.length-e.length);function b(e){if(f.has(e))return"refused";for(let t of w)if(e===t||e.startsWith(`${t}.`))return"mocked";return"emulated"}let y=new TextEncoder;function x(e,t){return{path:e,bytes:y.encode(t),text:t}}let v={manifest_version:3,name:"Hello Emulator",version:"0.1.0",description:"Trace fixture exercising emulated, mocked, and refused chrome.* tiers.",permissions:["storage","tabs","notifications","system.cpu","bookmarks","history","cookies","alarms","topSites","fontSettings","power","tts","identity","webNavigation"],action:{default_title:"Hello Emulator",default_popup:"popup.html"},background:{service_worker:"background.js"}},k=`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        width: 300px;
        margin: 0;
        padding: 12px;
        font: 13px/1.45 system-ui, sans-serif;
        color: #1f1f1f;
        background: #fff;
      }
      h1 { font-size: 14px; margin: 0 0 8px; }
      button {
        display: block;
        width: 100%;
        margin: 4px 0;
        padding: 6px 8px;
        font: inherit;
        border: 1px solid #dadce0;
        border-radius: 6px;
        background: #f8f9fa;
        cursor: pointer;
        text-align: left;
      }
      button:hover { background: #f1f3f4; }
      #out {
        margin-top: 8px;
        padding: 8px;
        min-height: 48px;
        border-radius: 6px;
        background: #f1f3f4;
        font-family: ui-monospace, monospace;
        font-size: 11px;
        white-space: pre-wrap;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <h1>Hello Emulator</h1>
    <button id="count">storage.local: increment counter</button>
    <button id="tabs">tabs.query: current window</button>
    <button id="ping">runtime.sendMessage: ping background</button>
    <button id="notify">notifications.create</button>
    <button id="cpu">system.cpu.getInfo (expect graceful refusal)</button>
    <button id="battery"><strong>Run API battery</strong> (one call per namespace)</button>
    <div id="out">Click a button to call chrome.*</div>
    <script src="popup.js"></script>
  </body>
</html>
`,I=`const out = document.getElementById("out");
const show = (label, value) => {
  out.textContent = label + "\\n" + JSON.stringify(value, null, 2);
};
const showError = (label, error) => {
  out.textContent = label + " FAILED\\n" + (error?.message ?? String(error));
};

document.getElementById("count").addEventListener("click", async () => {
  try {
    const { count = 0 } = await chrome.storage.local.get("count");
    const next = count + 1;
    await chrome.storage.local.set({ count: next });
    show("storage.local", { count: next });
  } catch (error) {
    showError("storage.local", error);
  }
});

document.getElementById("tabs").addEventListener("click", async () => {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    show(
      "tabs.query",
      tabs.map((tab) => ({ id: tab.id, url: tab.url, active: tab.active })),
    );
  } catch (error) {
    showError("tabs.query", error);
  }
});

document.getElementById("ping").addEventListener("click", async () => {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "ping" });
    show("runtime.sendMessage", reply);
  } catch (error) {
    showError("runtime.sendMessage", error);
  }
});

document.getElementById("notify").addEventListener("click", async () => {
  try {
    const id = await chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.png",
      title: "Hello Emulator",
      message: "Notification from the emulated extension.",
    });
    show("notifications.create", { id });
  } catch (error) {
    showError("notifications.create", error);
  }
});

document.getElementById("cpu").addEventListener("click", async () => {
  try {
    const info = await chrome.system.cpu.getInfo();
    show("system.cpu.getInfo", info);
  } catch (error) {
    showError("system.cpu.getInfo", error);
  }
});

// The poke battery: one representative call per namespace, spanning all
// three tiers, so the coverage matrix fills from a single click. Each call
// runs in this real guest context through the real shim; failures are
// expected for the refused tier and counted, not hidden.
document.getElementById("battery").addEventListener("click", async () => {
  const calls = [
    ["storage.local.get", () => chrome.storage.local.get(null)],
    ["tabs.query", () => chrome.tabs.query({})],
    ["runtime.getPlatformInfo", () => chrome.runtime.getPlatformInfo()],
    ["alarms.getAll", () => chrome.alarms.getAll()],
    ["bookmarks.getTree", () => chrome.bookmarks.getTree()],
    ["history.search", () => chrome.history.search({ text: "" })],
    ["cookies.getAll", () => chrome.cookies.getAll({})],
    ["topSites.get", () => chrome.topSites.get()],
    ["fontSettings.getDefaultFontSize", () =>
      chrome.fontSettings.getDefaultFontSize({})],
    ["power.requestKeepAwake", () =>
      Promise.resolve(chrome.power.requestKeepAwake("display"))],
    ["tts.getVoices", () => chrome.tts.getVoices()],
    ["identity.getProfileUserInfo", () =>
      chrome.identity.getProfileUserInfo()],
    ["webNavigation.getAllFrames", () =>
      chrome.webNavigation.getAllFrames({ tabId: 1 })],
    ["system.network.getNetworkInterfaces", () =>
      chrome.system.network.getNetworkInterfaces()],
    ["system.cpu.getInfo", () => chrome.system.cpu.getInfo()],
  ];
  let ok = 0;
  const failed = [];
  for (const [name, call] of calls) {
    try {
      await call();
      ok++;
    } catch (error) {
      failed.push(name + ": " + (error && error.message));
    }
  }
  show("battery", {
    total: calls.length,
    ok,
    failed: failed.length ? failed : "none",
  });
});
`,S=`chrome.runtime.onInstalled.addListener(() => {
  console.log("[hello-emulator] installed");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ping") {
    sendResponse({ type: "pong", from: "background", at: Date.now() });
  }
  return true;
});
`;x("manifest.json",JSON.stringify(v,null,2)),x("popup.html",k),x("popup.js",I),x("background.js",S),v.name;let{PING:C,PONG:T,BRIDGE:A,SESSION:E,INJECT:D,EVENT_PORT:N,EVENT:M,TRACE:B}={PING:"extensiondev:ping",PONG:"extensiondev:pong",BRIDGE:"extensiondev:bridge",SESSION:"extensiondev:session",INJECT:"extensiondev:inject",EVENT_PORT:"extensiondev:events",EVENT:"extensiondev:event",TRACE:"extensiondev:trace"},R=function(e={}){let t=e.engine??"chromium-emulated",r=e.limit??500,o=e.now??(()=>new Date),s=o().toISOString(),n=[],a=new Set,i=0,l=e=>{for(let t of(n.push(e),n.length>r&&n.splice(0,n.length-r),a))t(e);return e};return{recordCall:(e,r,s,n)=>l({seq:i+=1,api:e,args:s??[],extensionId:r,at:o().toISOString(),tier:b(e),engine:t,policy:n}),recordOutcome(e){let r=n.find(t=>t.extensionId===e.extensionId&&t.api===e.api&&void 0===t.status&&void 0===t.requestId),s={requestId:e.requestId,lane:e.lane,status:void 0===e.error?"ok":"error",error:e.error,durationMs:e.durationMs};if(r){Object.assign(r,s),"real"===e.lane&&(r.tier="real");for(let e of a)e(r);return r}return l({seq:i+=1,api:e.api,args:e.args,extensionId:e.extensionId,at:o().toISOString(),tier:"real"===e.lane?"real":b(e.api),engine:t,...s})},events:()=>[...n],snapshot(){let e={real:0,emulated:0,mocked:0,refused:0},r=0;for(let t of n)e[t.tier??b(t.api)]+=1,"error"===t.status&&(r+=1);return{engine:t,startedAt:s,events:[...n],counts:{total:n.length,byTier:e,errors:r}}},subscribe:e=>(a.add(e),()=>a.delete(e)),clear(){n.length=0}}}({engine:"chromium-real"}),O=new Set;R.subscribe(e=>{for(let t of O)try{t.postMessage({type:B,event:e})}catch{}});let P=function(){let e={local:{},sync:{},session:{},managed:{}},t=e=>chrome.storage[e??"local"]??chrome.storage.local,r=t=>e[t??"local"]??e.local;for(let e of["local","sync","session","managed"])t(e).get(null).then(t=>{Object.assign(r(e),t)}).catch(()=>void 0);chrome.storage.onChanged.addListener((t,o)=>{if(!(o in e))return;let s=r(o);for(let[e,r]of Object.entries(t))void 0===r.newValue?delete s[e]:s[e]=r.newValue});let o=new Map;return{getStorage:(e,t)=>({...r(t)}),setStorage:(e,o,s)=>{Object.assign(r(s),o),t(s).set(o)},removeStorageKeys:(e,o,s)=>{let n=r(s);for(let e of o)delete n[e];t(s).remove(o)},clearStorage:(e,o)=>{let s=r(o);for(let e of Object.keys(s))delete s[e];t(o).clear()},onSetStorageAccessLevel:async(e,t,r)=>{if("session"!==t)return;o.set(e,r);let s=chrome.storage.session;await s.setAccessLevel?.({accessLevel:r}).catch(()=>void 0)},getSessionStorageAccessLevel:e=>o.get(e),onCreateTab:e=>chrome.tabs.create({url:e}),onUpdateTab:(e,t)=>{let r=p(e);return null!=r?chrome.tabs.update(r,t):chrome.tabs.update(t)},onRemoveTab:e=>{let t=p(e);null!=t&&chrome.tabs.remove(t)},onGetWindow:(e,t,r)=>{let o=h(t);return null==o?chrome.windows.getCurrent(r??{}):chrome.windows.get(o,r??{})},onGetAllWindows:(e,t)=>chrome.windows.getAll(t??{}),onCreateWindow:(e,t)=>chrome.windows.create({url:t}),onUpdateWindow:(e,t,r)=>{let o=h(t);return null==o?null:chrome.windows.update(o,r)},onRemoveWindow:async(e,t)=>{let r=h(t);return null!=r&&(await chrome.windows.remove(r),!0)},onOpenSidePanel:()=>{chrome.windows.getCurrent().then(e=>null!=e.id?chrome.sidePanel.open({windowId:e.id}):void 0).catch(()=>void 0)},onSetBadgeText:(e,t,r)=>{let o=p(r);chrome.action.setBadgeText(null!=o?{text:t??"",tabId:o}:{text:t??""})},onSetBadgeBackground:(e,t,r)=>{if(!t)return;let o=p(r);chrome.action.setBadgeBackgroundColor(null!=o?{color:t,tabId:o}:{color:t})},onSetActionTitle:(e,t,r)=>{let o=p(r);chrome.action.setTitle(null!=o?{title:t??"",tabId:o}:{title:t??""})},onGetActionState:async(e,t)=>{let r=p(t),o=null!=r?{tabId:r}:{},[s,n,a]=await Promise.all([chrome.action.getBadgeText(o).catch(()=>""),chrome.action.getBadgeBackgroundColor(o).catch(()=>null),chrome.action.getTitle(o).catch(()=>"")]);return{badgeText:s,badgeColor:Array.isArray(n)?`rgba(${n[0]}, ${n[1]}, ${n[2]}, ${(n[3]??255)/255})`:n??void 0,title:a}},onSetActionIcon:(e,t)=>{t&&chrome.action.setIcon({path:t})},onCreateContextMenu:(e,t)=>chrome.contextMenus.create(t),onUpdateContextMenu:async(e,t,r)=>(await chrome.contextMenus.update(t,r),!0),onRemoveContextMenu:async(e,t)=>(await chrome.contextMenus.remove(t),!0),onClearContextMenus:async()=>(await chrome.contextMenus.removeAll(),!0),onCreateNotification:(e,t,r)=>chrome.notifications.create(t??"",r),onClearNotification:(e,t)=>chrome.notifications.clear(t),onGetNotifications:()=>chrome.notifications.getAll(),onDownload:(e,t)=>chrome.downloads.download(t),onSearchDownloads:(e,t)=>chrome.downloads.search(t??{}),onCancelDownload:async(e,t)=>{await chrome.downloads.cancel(t).catch(()=>void 0)},onPauseDownload:async(e,t)=>{await chrome.downloads.pause(t).catch(()=>void 0)},onResumeDownload:async(e,t)=>{await chrome.downloads.resume(t).catch(()=>void 0)},onGetBookmarkTree:()=>chrome.bookmarks.getTree(),onGetBookmarks:(e,t)=>chrome.bookmarks.get(t),onGetBookmarkChildren:(e,t)=>t?chrome.bookmarks.getChildren(t):chrome.bookmarks.getTree(),onSearchBookmarks:(e,t)=>chrome.bookmarks.search(t??""),onCreateBookmark:(e,t)=>chrome.bookmarks.create(t),onUpdateBookmark:(e,t,r)=>chrome.bookmarks.update(t,r),onRemoveBookmark:async(e,t,r)=>(r?await chrome.bookmarks.removeTree(t):await chrome.bookmarks.remove(t),!0),onSearchHistory:(e,t)=>chrome.history.search({text:t?.text??"",...t}),onGetHistoryVisits:(e,t)=>chrome.history.getVisits({url:t?.url??""}),onAddHistoryUrl:async(e,t)=>{t?.url&&await chrome.history.addUrl({url:t.url})},onDeleteHistoryUrl:async(e,t)=>{t?.url&&await chrome.history.deleteUrl({url:t.url})},onDeleteHistoryRange:async(e,t)=>{await chrome.history.deleteRange({startTime:t?.startTime??0,endTime:t?.endTime??Date.now()})},onDeleteAllHistory:async()=>{await chrome.history.deleteAll()},onRuntimeMessage:(e,t)=>chrome.runtime.sendMessage(t),onGetRuntimeContexts:()=>chrome.runtime.getContexts({}),onContainsPermissions:(e,t)=>chrome.permissions.contains(t),onRequestPermissions:(e,t)=>chrome.permissions.request(t),onRemovePermissions:(e,t)=>chrome.permissions.remove(t),onGetAllPermissions:async()=>{let e=await chrome.permissions.getAll();return{permissions:e.permissions??[],origins:e.origins??[]}},onCreateOffscreenDocument:async(e,t)=>(await chrome.offscreen.createDocument(t),!0),onCloseOffscreenDocument:async()=>(await chrome.offscreen.closeDocument(),!0),onHasOffscreenDocument:()=>chrome.offscreen.hasDocument(),onGetCookie:(e,t)=>chrome.cookies.get(t),onGetAllCookies:(e,t)=>chrome.cookies.getAll(t),onSetCookie:(e,t)=>chrome.cookies.set(t),onRemoveCookie:(e,t)=>chrome.cookies.remove(t),onExecuteScript:(e,t)=>{let r=p(t.target?.tabId);if(null!=r&&t.files?.length)return chrome.scripting.executeScript({target:{tabId:r},files:t.files})},onInsertCss:async(e,t)=>{let r=p(t.target?.tabId);null!=r&&(t.css?await chrome.scripting.insertCSS({target:{tabId:r},css:t.css}):t.files?.length&&await chrome.scripting.insertCSS({target:{tabId:r},files:t.files}))}}}(),q=new Map;async function $(){try{return(await chrome.windows.getAll({populate:!0})).map(e=>{let t=e.tabs??[],r=t.find(e=>e.active);return{id:e.id??void 0,focused:e.focused,activeTabId:r?.id??"",tabs:t.map(e=>({id:e.id??"",url:e.url??e.pendingUrl??"",title:e.title??""}))}})}catch{return[]}}async function U(e){let r,o=Date.now(),s=t=>(R.recordOutcome({requestId:e.requestId,extensionId:e.extensionId,api:e.api,args:e.args,lane:"real",result:t.result,error:t.error,durationMs:Date.now()-o,source:"frame"}),t),n=(r=t(e.api,q.get(e.extensionId)??new Set))?{error:r}:null;if(n)return s(n);let a="tabs.query"===e.api||"tabs.get"===e.api||"windows.getCurrent"===e.api?await $():[];return new Promise(t=>{let r=!1,o=e=>{r||(r=!0,t(s(e)))};m({data:e,windows:a,...P,respond:o,source:"frame"}).catch(e=>o({error:e instanceof Error?e.message:"Bridge error"}))})}async function j(e){let t,{extensionId:r,url:o,code:s,css:n,matches:a=[]}=e,i=q.get(r);if(!(i&&(i.has("scripting")||i.has("activeTab"))))return{ok:!1,error:'This extension does not declare the "scripting" (or "activeTab") permission.'};if(!a.length||!a.some(e=>{let t=function(e){let t;if("<all_urls>"===e)return/^https?:\/\/.*/;let r=/^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(e);if(!r)return null;let[,o="",s="",n=""]=r,a="*"===o?"https?":o.replace(/[.+?^${}()|[\]\\]/g,"\\$&");t="*"===s?"[^/]+":s.startsWith("*.")?`(?:[^/]+\\.)?${s.slice(2).replace(/[.+?^${}()|[\]\\]/g,"\\$&").replace(/\*/g,"[^/]*")}`:s.replace(/[.+?^${}()|[\]\\]/g,"\\$&").replace(/\*/g,"[^/]*");let i=n.replace(/[.+?^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*");return RegExp(`^${a}://${t}${i}$`)}(e);return!!t&&t.test(o)}))return{ok:!1,error:`This extension's content scripts / host permissions do not match ${o}.`};try{t=await chrome.tabs.create({url:o,active:!0})}catch(e){return{ok:!1,error:`Could not open the tab: ${String(e)}`}}let l=t.id;if(null==l)return{ok:!1,error:"No tab id."};if(await new Promise(e=>{let t=setTimeout(()=>e(),8e3),r=(o,s)=>{o===l&&"complete"===s.status&&(clearTimeout(t),chrome.tabs.onUpdated.removeListener(r),e())};chrome.tabs.onUpdated.addListener(r)}),n&&await chrome.scripting.insertCSS({target:{tabId:l},css:n}).catch(()=>void 0),!s)return{ok:!0,injected:!1};try{let[e]=await chrome.scripting.executeScript({target:{tabId:l},world:"MAIN",func:e=>{try{return(0,eval)(e),{ran:!0}}catch(e){return{ran:!1,error:String(e)}}},args:[s]}),t=e?.result;if(t&&!1===t.ran)return{ok:!0,injected:!1,blocked:!0,reason:t.error};return{ok:!0,injected:!0}}catch(e){return{ok:!1,error:`Injection failed: ${String(e)}`}}}chrome.runtime.onInstalled.addListener(()=>{}),chrome.runtime.onConnectExternal.addListener(e=>{if(e.name!==N)return;O.add(e);let t=[],r=(r,o)=>{let s=chrome[r],n=s?.[o];if(!n||"function"!=typeof n.addListener)return;let a=(...t)=>((t,r,o)=>{try{e.postMessage({type:M,namespace:t,event:r,args:o})}catch{}})(r,o,t);n.addListener(a),t.push(()=>n.removeListener(a))};r("storage","onChanged"),r("alarms","onAlarm"),r("tabs","onCreated"),r("tabs","onUpdated"),r("tabs","onRemoved"),r("tabs","onActivated"),r("windows","onCreated"),r("windows","onRemoved"),r("windows","onFocusChanged"),r("bookmarks","onCreated"),r("bookmarks","onChanged"),r("bookmarks","onMoved"),r("bookmarks","onRemoved"),r("history","onVisited"),r("history","onVisitRemoved"),r("downloads","onCreated"),r("downloads","onChanged"),r("downloads","onErased"),r("cookies","onChanged"),r("notifications","onClicked"),r("notifications","onClosed"),r("notifications","onButtonClicked"),r("contextMenus","onClicked"),e.onDisconnect.addListener(()=>{for(let r of(O.delete(e),t))r()})}),chrome.runtime.onMessageExternal.addListener((e,t,r)=>e?.type===C?(r({type:T,version:chrome.runtime.getManifest().version,ready:!0}),!1):e?.type===E&&"string"==typeof e.extensionId?(q.set(e.extensionId,new Set(Array.isArray(e.permissions)?e.permissions:[])),r({ok:!0}),!1):e?.type===A&&e.request?(U(e.request).then(r),!0):e?.type===D&&"string"==typeof e.url&&(j(e).then(r),!0))})();