// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lanePageUrl, setApprovalOpener } from "../lib/approval-open";
import { loginIdOf } from "../lib/credential-source";
import { credentialsPath, writeCredentials } from "../lib/credentials";
import { envelope as envelopeOf } from "../lib/envelope";
import { forgetForwardCredentials } from "../lib/forward-credential";
import { runAskingOnly } from "../lib/ask-only";
import { forgetCarriedMemory } from "../lib/forward-lane-answer";
import { forgetApprovalHolders, forwardCall } from "../lib/hosted-forwarder";
import { outcomeClock } from "../lib/outcome-clock";
import { createToolDispatcher } from "../lib/tool-dispatch";
import { tools } from "../index";
import { solidPng } from "./fixtures/png";
import { APPROVAL, PROJECT, WWW, stubPlatformFetch } from "./hosted-platform-fetch";

let tmp = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-hosted-"));
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_API_URL"]) saved[key] = process.env[key];
  process.env.XDG_CONFIG_HOME = tmp;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  delete process.env.EXTENSION_DEV_API_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetForwardCredentials();
  forgetCarriedMemory();
  forgetApprovalHolders();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

const LANE = "https://mcp.extension.dev/mcp/forward";
const LISTED = JSON.parse(envelopeOf({ ok: true, command: "extension_builds", status: "listed", value: { builds: [] } }));
const FORWARDING = { env: {}, version: "11.0.0", resolveLogin: () => ({ token: "device-login", ref: PROJECT }) };

function stubLane(answers: unknown[], exchange = 200) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body ?? "null")) });
    const exchanged = seen.filter((hit) => hit.url.endsWith("/api/cli/forward/exchange")).length;

    if (String(input).endsWith("/api/cli/forward/exchange")) return new Response(JSON.stringify(exchange === 200 ? { access_token: `forward-${exchanged}`, expires_in: 600 } : { code: "FORWARD_LANE_CLOSED", message: "The lane is off." }), { status: exchange });

    const next = answers.shift();

    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;

    return new Response(JSON.stringify(next), { status: 200 });
  });

  return { seen, lane: () => seen.filter((hit) => hit.url === LANE) };
}

describe("the forwarder", () => {
  it("sends the lane a project ref, a forward credential and one key, never the login, api or path", async () => {
    const { seen, lane } = stubLane([LISTED, LISTED]);
    const local = vi.fn(async () => "local");
    const out = await forwardCall("extension_builds", { action: "list", project: "acme/web", projectPath: "/work/web", api: WWW }, local, FORWARDING);
    await forwardCall("extension_builds", { action: "list", project: "acme/web" }, local, FORWARDING);
    const [first, second] = lane();

    expect(JSON.parse(out)).toEqual(LISTED);
    expect(local).not.toHaveBeenCalled();
    expect(seen.filter((hit) => hit.url.endsWith("/exchange"))).toHaveLength(1);
    expect(first?.headers).toMatchObject({ authorization: "Bearer forward-1", "x-extensiondev-forwarder": "11.0.0", "x-extensiondev-project": "acme/web" });
    expect(first?.headers["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(second?.headers["idempotency-key"]).not.toBe(first?.headers["idempotency-key"]);
    expect(first?.body).toEqual({ tool: "extension_builds", args: { action: "list", project: "acme/web" } });
    expect(lane().map((hit) => hit.headers.authorization)).not.toContain("Bearer device-login");
  });

  it("sends the submit facts it read here, and runs a step that writes to this machine here", async () => {
    const { lane } = stubLane([LISTED]);
    const local = vi.fn(async () => "local");
    await forwardCall("extension_submit_check", { action: "preflight", browsers: ["chrome"], projectPath: tmp }, local, FORWARDING);

    expect(lane()[0]?.body.args.local.facts.project).toMatchObject({ exists: true });
    expect(lane()[0]?.body.args).not.toHaveProperty("projectPath");

    for (const [tool, args] of [["extension_builds", { action: "download", buildId: "abc1234" }], ["extension_auth", { action: "login" }], ["extension_preview_web", {}]] as const) {
      expect(await forwardCall(tool, args, local, FORWARDING)).toBe("local");
    }

    expect(lane()).toHaveLength(1);
  });

  it("926: sends the lane where STORE.md was read as a path under the label, and reads a lane answer that names it back as the file on this machine", async () => {
    const bare = path.join(tmp, "bare");
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(bare, "src"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(bare, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0" }));
    fs.writeFileSync(path.join(bare, "src", "STORE.md"), "# Store\n\n## Listing\n\n- Summary: hello\n");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "plain" }));
    fs.writeFileSync(path.join(repo, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0" }));
    fs.writeFileSync(path.join(repo, "STORE.md"), "# Store\n\n## Listing\n\n- Summary: hello\n");
    const answer = (file: string) => JSON.parse(envelopeOf({ ok: true, command: "extension_submit_check", status: "preflight-read", value: { file }, hint: `Read ${file}. Then go on.` }));
    const { lane } = stubLane([answer("{projectPath}/src/STORE.md"), answer("{projectPath}/../STORE.md"), answer("{projectPath}/STORE.md")]);
    const ask = async (projectPath: string) => JSON.parse(await forwardCall("extension_submit_check", { action: "preflight", browsers: ["chrome"], projectPath }, async () => "local", FORWARDING));
    const inSrc = await ask(bare);
    const above = await ask(path.join(repo, "src"));
    const beside = await ask(repo);
    const sent = lane().map((hit) => hit.body.args.local.facts.project);

    expect(sent.map((project) => [project.projectPath, project.storeMdFile, project.storeMd === null])).toEqual([
      ["{projectPath}", "src/STORE.md", false],
      ["{projectPath}", "../STORE.md", false],
      ["{projectPath}", "STORE.md", false],
    ]);

    expect(inSrc).toMatchObject({ value: { file: path.join(bare, "src", "STORE.md") }, hint: `Read ${path.join(bare, "src", "STORE.md")}. Then go on.` });
    expect(above).toMatchObject({ value: { file: path.join(repo, "STORE.md") }, hint: `Read ${path.join(repo, "STORE.md")}. Then go on.` });
    expect(beside).toMatchObject({ value: { file: path.join(repo, "STORE.md") } });
    expect(JSON.stringify(lane().map((hit) => hit.body))).not.toContain(tmp);
  });

  it("retries a lane that did not answer, and a refused cached credential, with the same key", async () => {
    const denied = { ok: false, status: "auth-refused", error: { code: "E_AUTH_DENIED", message: "Refused." } };
    const { lane } = stubLane([new Error("socket hang up"), LISTED, denied, LISTED]);
    await forwardCall("extension_builds", {}, async () => "local", FORWARDING);
    const out = await forwardCall("extension_builds", {}, async () => "local", FORWARDING);
    const keys = lane().map((hit) => hit.headers["idempotency-key"]);

    expect(JSON.parse(out)).toEqual(LISTED);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).toBe(keys[3]);
    expect(lane().map((hit) => hit.headers.authorization)).toEqual(["Bearer forward-1", "Bearer forward-1", "Bearer forward-1", "Bearer forward-2"]);
  });

  const WEB_LOGIN = "web.device.login";
  const DOCS_LOGIN = "docs.device.login";
  const DOCS_EXPIRES = Math.floor(Date.now() / 1000) + 2 * 24 * 3600;

  function twoLoginsDefaultWeb() {
    const entry = (projectSlug: string, token: string, expiresAt: number) => ({ version: 1 as const, token, workspaceSlug: "acme", projectSlug, expiresAt, api: WWW, provider: "extensiondev" as const });

    writeCredentials(entry("docs", DOCS_LOGIN, DOCS_EXPIRES));
    writeCredentials(entry("web", WEB_LOGIN, DOCS_EXPIRES + 24 * 3600));
  }

  const APPROVED = (approvalId: string) => JSON.parse(envelopeOf({ ok: true, command: "extension_approvals", status: "approved", value: { approvalId } }));

  function approvalFor(project: string, loginId: string) {
    return {
      approvalId: `apr_${project.padEnd(32, "0")}`,
      workspace: "acme",
      project,
      loginId,
      action: "release.promote",
      fingerprint: "sha256:abc",
      approvalUrl: `${WWW}/device/approve/apr_${project}`,
      mintedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  }

  function stubHostedPlatform(laneAnswer: unknown, record?: Record<string, unknown>, holder = DOCS_LOGIN, holderProject = "") {
    const seen: Array<{ url: string; authorization: string | null; project: string | null; body: any }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const hit = { url: String(input), authorization: headers.get("authorization"), project: headers.get("x-extensiondev-project"), body: JSON.parse(String(init?.body ?? "null")) };
      seen.push(hit);

      if (hit.url.endsWith("/api/cli/forward/exchange")) return new Response(JSON.stringify({ access_token: `forward-of-${String(hit.authorization).replace("Bearer ", "")}`, expires_in: 600 }), { status: 200 });

      if (hit.url.endsWith("/api/cli/forward/approvals")) {
        const held = record && hit.authorization === `Bearer forward-of-${holder}` && hit.body.approvalId === record.approvalId && (!holderProject || hit.project === holderProject);

        return new Response(JSON.stringify(held ? { record } : { code: "APPROVAL_UNKNOWN" }), { status: held ? 200 : 404 });
      }

      if (hit.url.endsWith("/api/cli/whoami")) return new Response(JSON.stringify({ login: "acme/web", live: true, projectId: "prj_hosted1", workspaceSlug: "acme", projectSlug: "web" }), { status: 200 });

      return new Response(JSON.stringify(laneAnswer), { status: 200 });
    });

    return { seen, lane: () => seen.filter((hit) => hit.url === LANE) };
  }

  async function dispatched(name: string, args: Record<string, unknown>) {

    try {
      const frame = await createToolDispatcher({ tools, options: { features: ["local", "platform"], noShip: false }, openApprovals: false })({ name, arguments: args });

      return JSON.parse((frame.content as Array<{ text: string }>)[0]?.text ?? "null");
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it("693: makes a call that carries only approvalId as the project and login www holds the approval for", async () => {
    twoLoginsDefaultWeb();
    const record = approvalFor("docs", loginIdOf(DOCS_LOGIN));
    const { seen, lane } = stubHostedPlatform(APPROVED(record.approvalId), record);
    const out = await dispatched("extension_approvals", { approvalId: record.approvalId });

    expect(out).toMatchObject({ ok: true, status: "approved" });
    expect(lane()).toHaveLength(1);
    expect(lane()[0]).toMatchObject({ authorization: `Bearer forward-of-${DOCS_LOGIN}`, project: "acme/docs" });
    expect(lane()[0]?.body.args).toMatchObject({ approvalId: record.approvalId, project: "acme/docs" });
    expect(seen.filter((hit) => hit.url.endsWith("/api/cli/forward/approvals")).map((hit) => hit.project)).toEqual(["acme/web", "acme/docs"]);
    expect(lane().map((hit) => hit.authorization)).not.toContain(`Bearer ${DOCS_LOGIN}`);
  });

  it("744: forwards a call whose approval www answers to the call's own login when that login is not in the store", async () => {
    const envLogin = `${Buffer.from(JSON.stringify({ u: "acme", p: "web", n: "tok_env" })).toString("base64url")}.sig`;
    const record = approvalFor("web", "tok_env");
    const { lane } = stubHostedPlatform(APPROVED(record.approvalId), record, envLogin);
    process.env.EXTENSION_DEV_TOKEN = envLogin;
    const out = await dispatched("extension_approvals", { approvalId: record.approvalId });

    expect(out).toMatchObject({ ok: true, status: "approved" });
    expect(lane().map((hit) => hit.authorization)).toEqual([`Bearer forward-of-${envLogin}`]);
    expect(lane()[0]?.body.args).toMatchObject({ approvalId: record.approvalId });

    delete process.env.EXTENSION_DEV_TOKEN;
    twoLoginsDefaultWeb();
    const nowhere = stubHostedPlatform(JSON.parse(envelopeOf({ ok: false, command: "extension_submit", status: "approval-rejected", error: { code: "E_APPROVAL_REJECTED", message: "No such approval." } })));
    const judged = await dispatched("extension_submit", { action: "rollout", store: "chrome", deployPercentage: 50, approvalId: "apr_nowhere0000000000000000000000000" });

    expect(judged).toMatchObject({ ok: false, status: "approval-rejected" });
    expect(nowhere.lane().map((hit) => [hit.project, hit.body.tool, hit.body.args.approvalId])).toEqual([["acme/web", "extension_submit", "apr_nowhere0000000000000000000000000"]]);
  });

  it("733: asks one login at a time and stops at the one that reads the approval, then asks that one first", async () => {
    const BLOG_LOGIN = "blog.device.login";
    writeCredentials({ version: 1, token: BLOG_LOGIN, workspaceSlug: "acme", projectSlug: "blog", expiresAt: DOCS_EXPIRES, api: WWW, provider: "extensiondev" });
    twoLoginsDefaultWeb();
    const record = approvalFor("blog", loginIdOf(BLOG_LOGIN));
    const { seen, lane } = stubHostedPlatform(APPROVED(record.approvalId), record, BLOG_LOGIN);
    const to = (door: string) => seen.filter((hit) => hit.url.endsWith(door)).map((hit) => hit.project);

    await dispatched("extension_approvals", { approvalId: record.approvalId });

    expect(to("/api/cli/forward/approvals")).toEqual(["acme/web", "acme/blog"]);
    expect(to("/api/cli/forward/exchange")).toEqual(["acme/web", "acme/blog"]);

    await dispatched("extension_approvals", { approvalId: record.approvalId });

    expect(to("/api/cli/forward/approvals")).toEqual(["acme/web", "acme/blog", "acme/blog"]);
    expect(to("/api/cli/forward/exchange")).toHaveLength(2);
    expect(lane().map((hit) => hit.project)).toEqual(["acme/blog", "acme/blog"]);
  });

  it("733: asks www once which project holds the approval, exchanges no login for the read but the call's own, and asks nobody else when www says it is not this person's", async () => {
    const BLOG_LOGIN = "blog.device.login";
    writeCredentials({ version: 1, token: BLOG_LOGIN, workspaceSlug: "acme", projectSlug: "blog", expiresAt: DOCS_EXPIRES, api: WWW, provider: "extensiondev" });
    twoLoginsDefaultWeb();
    const mine = `apr_${"blog".padEnd(32, "0")}`;
    const theirs = `apr_${"theirs".padEnd(32, "0")}`;
    const { seen, lane } = stubHostedPlatform(APPROVED(mine));
    const older = globalThis.fetch;

    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "null"));

      if (!String(input).endsWith("/api/cli/forward/approvals") || body?.anyProject !== true) return older(input as string, init);

      seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), project: new Headers(init?.headers).get("x-extensiondev-project"), body });

      return body.approvalId === mine
        ? new Response(JSON.stringify({ project: "acme/blog", loginId: loginIdOf(BLOG_LOGIN) }), { status: 200 })
        : new Response(JSON.stringify({ code: "APPROVAL_UNKNOWN", message: "Unknown approval", anyProject: true }), { status: 404 });
    });

    const reads = () => seen.filter((hit) => hit.url.endsWith("/api/cli/forward/approvals")).map((hit) => [hit.project, hit.body.anyProject]);
    const exchanges = () => seen.filter((hit) => hit.url.endsWith("/api/cli/forward/exchange")).map((hit) => hit.authorization);

    await dispatched("extension_approvals", { approvalId: mine });
    await dispatched("extension_approvals", { approvalId: mine });

    expect(reads()).toEqual([["acme/web", true]]);
    expect(exchanges()).toEqual([`Bearer ${WEB_LOGIN}`, `Bearer ${BLOG_LOGIN}`]);
    expect(lane().map((hit) => [hit.authorization, hit.project, hit.body.args.project])).toEqual([
      [`Bearer forward-of-${BLOG_LOGIN}`, "acme/blog", "acme/blog"],
      [`Bearer forward-of-${BLOG_LOGIN}`, "acme/blog", "acme/blog"],
    ]);

    const other = await dispatched("extension_approvals", { approvalId: mine, project: "acme/docs" });

    expect(other).toMatchObject({ ok: false, status: "approval-rejected", error: { name: "ApprovalOtherProject" }, value: { approvalId: mine, mintedFor: "acme/blog", named: "acme/docs" } });
    expect(other.error.message).toContain(`Approval ${mine} was minted for acme/blog, not acme/docs`);
    expect(other.hint).toContain('project: "acme/blog"');
    expect(lane()).toHaveLength(2);

    await dispatched("extension_approvals", { approvalId: theirs });

    expect(reads()).toEqual([["acme/web", true], ["acme/web", true]]);
    expect(exchanges()).toHaveLength(2);
    expect(lane()[2]).toMatchObject({ authorization: `Bearer forward-of-${WEB_LOGIN}`, project: "acme/web" });
  });

  it("answers the sign-in sentence, and asks the lane nothing, when the login that requested an approval is no longer stored", async () => {
    twoLoginsDefaultWeb();
    const gone = `apr_${"blog".padEnd(32, "0")}`;
    const { seen, lane } = stubHostedPlatform(APPROVED(gone));
    const older = globalThis.fetch;

    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "null"));

      if (!String(input).endsWith("/api/cli/forward/approvals") || body?.anyProject !== true) return older(input as string, init);

      seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), project: new Headers(init?.headers).get("x-extensiondev-project"), body });

      return new Response(JSON.stringify({ project: "acme/blog", loginId: "tok_blog_gone" }), { status: 200 });
    });

    const out = await dispatched("extension_builds_act", { action: "configure", buildSettings: { firefox: { enabled: true } }, approvalId: gone });

    expect(out).toMatchObject({ ok: false, status: "auth-required", error: { code: "E_AUTH_REQUIRED", name: "ApprovalLoginGone" }, value: { approvalId: gone, mintedFor: "acme/blog" } });
    expect(out.error.message).toContain("the login that requested this approval is no longer stored; sign in to acme/blog again and request a new approval");
    expect(out.hint).toContain('extension_auth (action: login, project: "acme/blog")');
    expect(out.value.trackUrl).toContain("/blog");
    expect(lane()).toEqual([]);
  });

  it("refuses a plaintext api URL before any login is exchanged or sent", async () => {
    twoLoginsDefaultWeb();
    const { seen } = stubHostedPlatform(LISTED);
    const out = await dispatched("extension_publish", { api: "http://evil.example.com" });

    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("Refusing to send the access token to http://evil.example.com: use https (http is allowed only for localhost).");
    expect(seen).toEqual([]);
  });

  it("exchanges EXTENSION_DEV_TOKEN for an unnamed call and the stored login for a named one, never the active login in its place", async () => {
    const envLogin = `${Buffer.from(JSON.stringify({ u: "acme", p: "web", n: "tok_env" })).toString("base64url")}.sig`;
    twoLoginsDefaultWeb();
    process.env.EXTENSION_DEV_TOKEN = envLogin;
    const { seen, lane } = stubHostedPlatform(LISTED);
    const exchanges = () => seen.filter((hit) => hit.url.endsWith("/api/cli/forward/exchange")).map((hit) => hit.authorization);

    await dispatched("extension_publish", {});
    await dispatched("extension_shares", { action: "list", project: "acme/docs" });

    expect(exchanges()).toEqual([`Bearer ${envLogin}`, `Bearer ${DOCS_LOGIN}`]);
    expect(lane().map((hit) => [hit.body.tool, hit.authorization, hit.project])).toEqual([
      ["extension_publish", `Bearer forward-of-${envLogin}`, "acme/web"],
      ["extension_shares", `Bearer forward-of-${DOCS_LOGIN}`, "acme/docs"],
    ]);

    expect(lane().map((hit) => hit.authorization)).not.toContain(`Bearer forward-of-${WEB_LOGIN}`);
  });

  it("733: reads an approval through a member login, one project at a time on one exchange", async () => {
    const MEMBER_LOGIN = "member.device.login";
    writeCredentials({ version: 1, token: MEMBER_LOGIN, workspaceSlug: "acme", projectSlug: "*", kind: "member", projectSlugs: ["docs", "blog"], expiresAt: DOCS_EXPIRES, api: WWW, provider: "extensiondev" });
    writeCredentials({ version: 1, token: WEB_LOGIN, workspaceSlug: "acme", projectSlug: "web", expiresAt: DOCS_EXPIRES, api: WWW, provider: "extensiondev" });
    const record = approvalFor("blog", loginIdOf(MEMBER_LOGIN));
    const { seen, lane } = stubHostedPlatform(APPROVED(record.approvalId), record, MEMBER_LOGIN, "acme/blog");
    const out = await dispatched("extension_approvals", { approvalId: record.approvalId, project: "acme/web" });
    const asked = await dispatched("extension_approvals", { approvalId: record.approvalId });

    expect(out).toMatchObject({ ok: false, status: "approval-rejected" });
    expect(asked).toMatchObject({ ok: true, status: "approved" });
    expect(seen.filter((hit) => hit.url.endsWith("/api/cli/forward/approvals")).map((hit) => hit.project)).toEqual(["acme/web", "acme/docs", "acme/blog", "acme/blog"]);
    expect(seen.filter((hit) => hit.url.endsWith("/api/cli/forward/exchange")).map((hit) => hit.authorization)).toEqual([`Bearer ${WEB_LOGIN}`, `Bearer ${MEMBER_LOGIN}`]);
    expect(lane()).toMatchObject([{ authorization: `Bearer forward-of-${MEMBER_LOGIN}`, project: "acme/blog" }]);
  });

  it("694: answers auth status here, with the device login's expiry and this machine's logins, and asks the lane only its preflight", async () => {
    twoLoginsDefaultWeb();
    const { seen, lane } = stubHostedPlatform(LISTED);
    const out = await dispatched("extension_auth", { action: "status", project: "acme/docs" });
    const all = await dispatched("extension_auth", { action: "status" });

    expect(out.command).toBe("extension_auth");
    expect(out.value).toMatchObject({ workspaceSlug: "acme", projectSlug: "docs", expiresAt: new Date(DOCS_EXPIRES * 1000).toISOString() });
    expect(out.value.expiresInSeconds).toBeGreaterThan(600);
    expect(all.value.logins.map((login: { project: string }) => login.project).sort()).toEqual(["acme/docs", "acme/web"]);
    expect(lane().map((hit) => [hit.authorization, hit.body])).toEqual([[null, null], [null, null]]);
    expect(seen.filter((hit) => hit.url.endsWith("/api/cli/whoami")).map((hit) => hit.authorization)).toEqual([`Bearer ${DOCS_LOGIN}`, `Bearer ${WEB_LOGIN}`]);
  });

  it("697: opens the pages the lane names on this machine, https only, and under the rules an approval page obeys", async () => {
    const opened: string[] = [];
    const restore = setApprovalOpener((url) => {
      opened.push(url);

      return true;
    });
    const connectUrl = "https://console.extension.dev/acme/web/submissions/firefox/connect";
    const keyPage = "https://addons.mozilla.org/developers/addon/api/key/";
    const pending = () => JSON.parse(envelopeOf({ ok: true, command: "extension_submit", status: "connect-pending", value: { connectUrl, opened: true, openPages: [keyPage, connectUrl, "http://example.com/elsewhere", "file:///etc/hosts"] } }));

    try {
      const { lane } = stubLane([pending(), pending()]);
      const local = vi.fn(async () => "local");
      const out = JSON.parse(await forwardCall("extension_submit", { action: "connect", store: "firefox", projectPath: tmp }, local, { ...FORWARDING, platform: "darwin" }));

      expect(lane()[0]?.body.args.local.pageOpening).toEqual({ block: "" });
      expect(opened).toEqual([keyPage, connectUrl]);
      expect(out.value).toEqual({ connectUrl, opened: true });

      const headless = { ...FORWARDING, platform: "darwin" as const, env: { EXTENSION_HEADLESS: "1" } };
      const held = JSON.parse(await forwardCall("extension_submit", { action: "connect", store: "firefox", projectPath: tmp }, local, headless));

      expect(lane()[1]?.body.args.local.pageOpening.block).toContain("EXTENSION_HEADLESS=1");
      expect(opened).toHaveLength(2);
      expect(held.value).toMatchObject({ connectUrl, opened: false, openedNote: expect.stringContaining("No page was opened: EXTENSION_HEADLESS=1") });
      expect(held.value).not.toHaveProperty("openPages");
      expect(local).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("899: opens a page the lane names only on the platform or a store's developer dashboard, and keeps any other as text", async () => {
    const opened: string[] = [];
    const restore = setApprovalOpener((url) => {
      opened.push(url);

      return true;
    });
    const connectUrl = "https://console.extension.dev/acme/web/submissions/edge/connect";
    const keyPage = "https://partner.microsoft.com/dashboard/microsoftedge/publishapi";
    const elsewhere = "https://login.example.test/dashboard";
    const lookalike = "https://partner.microsoft.com.example.test/dashboard";
    const answer = (openPages: string[]) => JSON.parse(envelopeOf({ ok: true, command: "extension_submit", status: "connect-pending", value: { connectUrl, opened: true, openPages } }));

    try {
      const { lane } = stubLane([answer([keyPage, elsewhere, connectUrl, lookalike]), answer([elsewhere])]);
      const local = vi.fn(async () => "local");
      const out = JSON.parse(await forwardCall("extension_submit", { action: "connect", store: "edge", projectPath: tmp }, local, { ...FORWARDING, platform: "darwin" }));

      expect(lane()).toHaveLength(1);
      expect(opened).toEqual([keyPage, connectUrl]);
      expect(out.value).toEqual({ connectUrl, opened: true, pagesNotOpened: [elsewhere, lookalike] });
      expect(out.warnings.join(" ")).toContain(`neither on extension.dev nor on a store's developer dashboard: ${elsewhere}, ${lookalike}`);

      const alone = JSON.parse(await forwardCall("extension_submit", { action: "connect", store: "edge", projectPath: tmp }, local, { ...FORWARDING, platform: "darwin" }));

      expect(opened).toHaveLength(2);
      expect(alone.value).toMatchObject({ opened: false, pagesNotOpened: [elsewhere] });

      for (const page of ["https://chrome.google.com/webstore/devconsole/p/i/edit", "https://addons.mozilla.org/developers/addon/api/key/", "https://appstoreconnect.apple.com/access/integrations/api", "https://www.extension.dev/device/approve", "http://localhost:3100/x"]) {
        expect(lanePageUrl(page), page).toBe(page);
      }

      for (const page of ["https://chrome.google.com/search", "https://addons.mozilla.org/firefox/addon/x/", "https://appstoreconnect.apple.com@example.test/", "https://extension.dev.example.test/", "http://partner.microsoft.com/dashboard", "javascript:alert(1)"]) {
        expect(lanePageUrl(page), page).toBe("");
      }

      for (const page of ["https://partner.microsoft.com/dashboard/microsoftedge/overview", "https://partner.microsoft.com/dashboard/microsoftedge/903d21e4-0e5b-4507-95f2-4620fcf06f1c/packages/dashboard", "https://appstoreconnect.apple.com/apps", "https://appstoreconnect.apple.com/apps/6826223107/distribution"]) {
        expect(lanePageUrl(page), page).toBe(page);
      }

      for (const page of [
        "https://partner.microsoft.com/",
        "https://partner.microsoft.com/redirect?url=https://example.test",
        "https://partner.microsoft.com/dashboard/microsoftedge/../../redirect?url=https://example.test",
        "https://partner.microsoft.com/dashboard/microsoftedge/%2e%2e/%2e%2e/redirect",
        "https://partner.microsoft.com/dashboard/microsoftedge/..%2f..%2fredirect",
        "https://partner.microsoft.com/dashboard/microsoftedge\\..\\..\\redirect",
        "https://partner.microsoft.com//example.test/dashboard/microsoftedge",
        "https://appstoreconnect.apple.com/",
        "https://appstoreconnect.apple.com/login?targetUrl=https://example.test/apps",
        "https://appstoreconnect.apple.com/apps/../login",
        "https://appstoreconnect.apple.com/apps/..%5Clogin",
        "https://appstoreconnect.apple.com/access/users",
      ]) {
        expect(lanePageUrl(page), page).toBe("");
      }
    } finally {
      restore();
    }
  });

  it("732: asks the lane for the words of a page that did not open, as the session it began, when the open command does not start", async () => {
    const restore = setApprovalOpener(() => false);
    const connectUrl = "https://console.extension.dev/acme/web/submissions/firefox/connect";
    const resumedNote = "No page was opened: this call resumed connect session cs_1, whose page opened when the session began.";
    const pending = (value: Record<string, unknown>, say: string, note = "") =>
      JSON.parse(envelopeOf({ ok: true, command: "extension_submit", status: "connect-pending", value: { connectSession: "cs_1", connectUrl, ...value, sayToPerson: say, nextStep: { kind: "connect", say, url: connectUrl } }, hint: [say, note].filter(Boolean).join(" ") }));
    const open = 'The page "Connect Firefox Add-ons for acme/web" is open in your browser.';
    const handed = `Open ${connectUrl} to connect Firefox Add-ons for acme/web.`;

    try {
      const { lane } = stubLane([pending({ opened: true, openPages: [connectUrl] }, open), pending({ opened: false, openedNote: resumedNote }, handed, resumedNote), pending({ opened: true, openPages: [connectUrl] }, open), new Response("{}", { status: 500 })]);
      const args = { action: "connect", store: "firefox", waitSeconds: 30, projectPath: tmp };
      const out = JSON.parse(await forwardCall("extension_submit", args, async () => "local", { ...FORWARDING, platform: "darwin" }));
      const [first, second] = lane();

      expect(second?.body.args).toMatchObject({ action: "connect", store: "firefox", connectSession: "cs_1", waitSeconds: 0, local: { pageOpening: { block: "the open command did not start" } } });
      expect(second?.headers["idempotency-key"]).not.toBe(first?.headers["idempotency-key"]);
      expect(out.value).toMatchObject({ opened: false, sayToPerson: handed, nextStep: { say: handed }, openedNote: expect.stringContaining("the open command did not start") });
      expect(JSON.stringify(out)).not.toContain("is open in your browser");
      expect(JSON.stringify(out)).not.toContain("whose page opened");

      const alone = JSON.parse(await forwardCall("extension_submit", args, async () => "local", { ...FORWARDING, platform: "darwin" }));

      expect(alone.value).toMatchObject({ opened: false, openedNote: expect.stringContaining("the open command did not start") });
      expect(alone.warnings).toEqual([expect.stringContaining("No page was opened")]);
    } finally {
      restore();
    }
  });

  it("sends an ask-only call under the check tool's name, so the lane's dispatcher marks it asking only", async () => {
    const { lane } = stubLane([LISTED, LISTED]);
    writeCredentials({ version: 1, token: "disk-token", workspaceSlug: "acme", projectSlug: "web", expiresAt: 4102444800, api: WWW });
    const dispatch = createToolDispatcher({ tools, options: { features: ["local", "platform"], noShip: false }, openApprovals: false });
    const asked = { action: "submit", browsers: ["chrome"], project: "acme/web", buildSha: "abc1234", dryRun: false };

    await dispatch({ name: "extension_submit_check", arguments: asked });
    await dispatch({ name: "extension_submit", arguments: asked });

    expect(lane().map((hit) => hit.body.tool)).toEqual(["extension_submit_check", "extension_submit"]);
    expect(JSON.parse(await runAskingOnly(() => forwardCall("extension_release_promote", { project: "acme/web" }, async () => "local", FORWARDING)))).toMatchObject({ ok: false, status: "ask-only" });
    expect(lane()).toHaveLength(2);
  });

  it("743: uploads listing images to www itself only once the lane asks for them, and sends the lane digests, sizes and a path label, never bytes or the machine path", async () => {
    const root = path.join(tmp, "proj");
    const icon = solidPng(128, 128);
    const shot = Buffer.concat([solidPng(1280, 800), Buffer.alloc(900_000, 7)]);
    const uploads: Array<{ url: string; authorization: string | null; body: any }> = [];
    const laneBodies: string[] = [];
    const wantsImages = (stageFirst?: unknown[]) => JSON.parse(envelopeOf({ ok: false, command: "extension_submit", status: "sync-listing-refused", value: { platformCode: "IMAGE_BYTES_NOT_SENT", ...(stageFirst ? { stageFirst } : {}) }, error: { code: "E_PLATFORM", message: "Not uploaded." } }));
    const laneAnswers: unknown[] = [wantsImages()];
    fs.mkdirSync(path.join(root, "dist", "chrome", "icons"), { recursive: true });
    fs.mkdirSync(path.join(root, "store", "screenshots", "chrome"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "chrome", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0", icons: { "128": "icons/128.png" } }));
    fs.writeFileSync(path.join(root, "dist", "chrome", "icons", "128.png"), icon);
    fs.writeFileSync(path.join(root, "store", "screenshots", "chrome", "1.png"), shot);
    fs.writeFileSync(path.join(root, "STORE.md"), "# Store\n\n## Listing\n\n- Summary: hello\n");
    writeCredentials({ version: 1, token: "disk-token", workspaceSlug: "acme", projectSlug: "web", expiresAt: 4102444800, api: WWW });

    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");

      if (url.endsWith("/api/cli/forward/exchange")) return new Response(JSON.stringify({ access_token: "forward-1", expires_in: 600 }), { status: 200 });
      if (url.endsWith("/api/cli/whoami")) return new Response(JSON.stringify({ projectId: "prj_hosted1", workspaceSlug: "acme", projectSlug: "web" }), { status: 200 });

      if (url.endsWith("/stores/chrome/listing/images")) {
        uploads.push({ url, authorization, body: JSON.parse(String(init?.body)) });

        return new Response(JSON.stringify({ image: { sha256: `answered-${uploads.length}`, width: 128, height: 128, bytes: 10 } }), { status: 200 });
      }

      laneBodies.push(String(init?.body));

      return new Response(JSON.stringify(laneAnswers.shift() ?? JSON.parse(envelopeOf({ ok: true, command: "extension_submit", status: "listing-synced", value: { file: "{projectPath}/STORE.md" }, hint: "Read {projectPath}/STORE.md. Then go on." }))), { status: 200 });
    });

    const login = { env: {}, version: "11.0.0" };
    const syncArgs = { action: "sync-listing", browsers: ["chrome"], project: "acme/web", projectPath: root, screenshots: [path.join(root, "store", "screenshots", "chrome", "1.png")] };
    const out = JSON.parse(await forwardCall("extension_submit", syncArgs, async () => "local", login));
    const judged = JSON.parse(laneBodies[0]!).args.local.facts.project;

    expect(laneBodies).toHaveLength(2);
    expect(judged.icons.chrome.icon).toMatchObject({ bytes: null, size: icon.length });
    expect(judged.icons.chrome.icon).not.toHaveProperty("staged");

    await forwardCall("extension_submit", { action: "submit", browsers: ["firefox"], project: "acme/web", projectPath: root }, async () => "local", login);
    await forwardCall("extension_submit", { action: "preflight", browsers: ["chrome"], project: "acme/web", projectPath: root }, async () => "local", login);
    const sent = JSON.parse(laneBodies[1]!).args;
    const facts = sent.local.facts.project;

    expect(uploads.map((hit) => [hit.url, hit.authorization, hit.body.kind, hit.body.dataBase64.length])).toEqual([
      [`${WWW}/api/projects/prj_hosted1/stores/chrome/listing/images`, "Bearer disk-token", "icons", icon.toString("base64").length],
      [`${WWW}/api/projects/prj_hosted1/stores/chrome/listing/images`, "Bearer disk-token", "screenshots", shot.toString("base64").length],
    ]);

    expect(facts.icons.chrome.icon).toMatchObject({ bytes: null, size: icon.length, staged: { chrome: { ok: true, json: { image: { sha256: "answered-1" } } } } });
    expect(facts.shots.given.screenshots[0]).toMatchObject({ bytes: null, size: shot.length, source: path.join("store", "screenshots", "chrome", "1.png"), staged: { chrome: { ok: true, json: { image: { sha256: "answered-2" } } } } });
    expect(sent.screenshots).toEqual(["store/screenshots/chrome/1.png"]);
    expect(facts.projectPath).toBe("{projectPath}");
    expect(laneBodies).toHaveLength(4);
    expect(Math.max(...laneBodies.map((body) => body.length))).toBeLessThan(50_000);

    for (const body of laneBodies) {
      expect(body).not.toContain('"type":"Buffer"');
      expect(body).not.toContain(tmp);
      expect(body).not.toContain(fs.realpathSync(tmp));
    }

    expect(out).toMatchObject({ value: { file: path.join(root, "STORE.md") }, hint: `Read ${path.join(root, "STORE.md")}. Then go on.` });

    const before = uploads.length;
    laneAnswers.push(JSON.parse(envelopeOf({ ok: false, command: "extension_submit", status: "sync-listing-failed", error: { code: "E_BAD_REQUEST", message: "Summary is over the store's limit." } })));
    const refused = JSON.parse(await forwardCall("extension_submit", syncArgs, async () => "local", login));

    expect(refused.status).toBe("sync-listing-failed");
    expect(uploads).toHaveLength(before);

    laneAnswers.push(wantsImages([{ store: "chrome", kind: "icons", name: judged.icons.chrome.icon.source }]));
    await forwardCall("extension_submit", syncArgs, async () => "local", login);

    expect(uploads.slice(before).map((hit) => hit.body.kind)).toEqual(["icons"]);
  });
});

const PROMOTE = { project: "acme/web", buildId: "abc1234", channel: "stable" };
const IN_FLIGHT = { ok: false, status: "act-in-flight", error: { code: "E_ACT_IN_FLIGHT", message: "This act was already sent and has not reported an outcome yet." }, value: { idempotencyKey: "k" } };
const PROMOTED = JSON.parse(envelopeOf({ ok: true, command: "extension_release_promote", status: "promoted", value: { channel: "stable" } }));
const edge = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });
const forwarded = async (tool: string, args: Record<string, unknown>) => JSON.parse(await forwardCall(tool, args, async () => "local", FORWARDING));

describe("the forwarder reads a lane answer by its status, and never reports an act that may have run as one that did not", () => {
  it("answers a 504 or a 502 on an act as may have run, with its key and the record to read first", async () => {
    for (const status of [504, 502]) {
      const { lane } = stubLane([edge(status, "An error occurred with this application.\nFUNCTION_INVOCATION_TIMEOUT"), edge(status, "An error occurred with this application.\nFUNCTION_INVOCATION_TIMEOUT")]);
      const out = await forwarded("extension_release_promote", PROMOTE);
      const keys = lane().map((hit) => hit.headers["idempotency-key"]);

      expect(out).toMatchObject({ ok: false, status: "act-unconfirmed", error: { code: "E_PLATFORM" }, value: { httpStatus: status, mayHaveRun: true, idempotencyKey: keys[0], readFirst: "extension_release_status (project: 'acme/web')" } });
      expect(out.error.message).toContain(`answered ${status} (FUNCTION_INVOCATION_TIMEOUT)`);
      expect(out.hint).toContain("extension_release_status (project: 'acme/web')");
      expect(keys).toEqual([keys[0], keys[0]]);
    }
  });

  it("asks a lost read once more and answers what the second try read", async () => {
    const { lane } = stubLane([edge(504, "FUNCTION_INVOCATION_TIMEOUT"), LISTED]);

    expect(await forwarded("extension_builds", { action: "list", project: "acme/web" })).toEqual(LISTED);
    expect(lane()).toHaveLength(2);

    stubLane([edge(502, "BAD_GATEWAY"), edge(502, "BAD_GATEWAY")]);
    const twice = await forwarded("extension_builds", { action: "list", project: "acme/web" });

    expect(twice).toMatchObject({ ok: false, status: "platform-unavailable", value: { httpStatus: 502 } });
    expect(twice.hint).toContain("Nothing was changed");
    expect(twice.value).not.toHaveProperty("mayHaveRun");
  });

  it("758: names the payload on a 413 and the lane on a 503 with the switch its preflight names, and sends neither again", async () => {
    const big = stubLane([edge(413, "Request Entity Too Large\nFUNCTION_PAYLOAD_TOO_LARGE")]);
    const large = await forwarded("extension_submit", { action: "sync-listing", browsers: ["chrome"], project: "acme/web", projectPath: tmp });
    const sentBytes = Buffer.byteLength(JSON.stringify(big.lane()[0]?.body));

    expect(large).toMatchObject({ ok: false, status: "payload-too-large", error: { code: "E_BAD_REQUEST" }, value: { httpStatus: 413, sentBytes } });
    expect(large.error.message).toContain(`${Math.ceil(sentBytes / 1024)} KB was sent`);
    expect(large.value.localFactsBytes).toBeGreaterThan(0);
    expect(big.lane()).toHaveLength(1);

    const killSwitch = { switch: "MCP_KILL_SWITCH", closes: "every hosted answer, /mcp and the forward lane" };
    const preflight = (closedSwitches: unknown[]) => ({ ok: closedSwitches.length === 0, status: closedSwitches.length ? "lane-closed" : "lane-ready", value: { switches: { MCP_KILL_SWITCH: closedSwitches.length === 0 }, closed: closedSwitches, www: "read" } });
    const off = stubLane([edge(503, JSON.stringify({ ok: false, status: "hosted-off", error: { code: "E_PLATFORM", message: "Platform tools are switched off for now. The local tools still work." } }), { "retry-after": "300" }), preflight([killSwitch, { switch: "not a variable", closes: "x" }])]);
    const closed = await forwarded("extension_release_promote", PROMOTE);

    expect(closed.value.hostedLane).toEqual({ lane: LANE, status: "lane-closed", closed: [killSwitch] });
    expect(closed.hint).toContain("MCP_KILL_SWITCH (closes every hosted answer, /mcp and the forward lane). That switch is extension.dev's, not this machine's");
    expect(off.lane()[1]?.headers).toMatchObject({ "x-extensiondev-preflight": "1" });
    expect(off.lane()[1]?.headers).not.toHaveProperty("authorization");
    expect(off.lane()[1]?.body).toBeNull();

    const door = JSON.parse(envelopeOf({ ok: false, command: "extension_release_promote", status: "lane-closed", error: { code: "E_PLATFORM", message: "The hosted lane's acts door is closed." }, value: { door: "acts" } }));
    const silent = stubLane([door, edge(404, "Not found")]);
    const unnamed = await forwarded("extension_release_promote", PROMOTE);

    expect(unnamed).toMatchObject({ ok: false, status: "lane-closed", value: { door: "acts" } });
    expect(unnamed.value).not.toHaveProperty("hostedLane");
    expect(silent.lane()).toHaveLength(2);

    stubLane([preflight([])]);
    const status = JSON.parse(await forwardCall("extension_auth", { action: "status" }, async () => envelopeOf({ ok: true, command: "extension_auth", status: "logged-in", value: { workspaceSlug: "acme" }, hint: "Signed in." }), FORWARDING));

    expect(status).toMatchObject({ status: "logged-in", hint: "Signed in.", value: { workspaceSlug: "acme", hostedLane: { lane: LANE, status: "lane-ready", closed: [] } } });

    expect(closed).toMatchObject({ ok: false, status: "hosted-off", error: { code: "E_PLATFORM" }, value: { lane: LANE, httpStatus: 503, retryAfterSeconds: 300 } });
    expect(closed.error.message).toContain(`${LANE} answered 503: Platform tools are switched off for now.`);
    expect(off.lane()).toHaveLength(2);
  });

  it("asks a key the lane still holds in flight again until its act reports, and stops asking once the function cannot still be running", async () => {
    const settled = stubLane([new Error("socket hang up"), IN_FLIGHT, IN_FLIGHT, PROMOTED]);

    expect(await forwarded("extension_release_promote", PROMOTE)).toEqual(PROMOTED);
    expect(new Set(settled.lane().map((hit) => hit.headers["idempotency-key"])).size).toBe(1);
    expect(settled.lane()).toHaveLength(4);

    const stuck = stubLane([new Error("socket hang up"), ...Array.from({ length: 40 }, () => IN_FLIGHT)]);
    const out = await forwarded("extension_release_promote", PROMOTE);

    expect(out).toMatchObject({ ok: false, status: "act-in-flight", error: { code: "E_ACT_IN_FLIGHT" } });
    expect(stuck.lane().length).toBe(2 + 65_000 / 5_000);
  });
});

describe("the forwarder gives the person the wait they asked for and keeps what the hosted tools remember", () => {
  const cut = (granted: number, status = "found") => ({
    ok: true,
    command: "extension_builds",
    status,
    value: { buildId: "abc1234", hostedWait: { askedSeconds: 180, grantedSeconds: granted, notice: "The hosted lane cut this wait." } },
    warnings: ["The hosted lane cut this wait."],
  });

  it("asks a read whose wait the lane cut again with the seconds still owed, and answers without the lane's notice", async () => {
    const settled = { ok: true, command: "extension_builds", status: "found", value: { buildId: "abc1234", conclusion: "success", waited: { seconds: 22, settled: false } }, hint: "The 22s wait passed before build 12 settled; call get again with waitSeconds to keep waiting." };
    const { lane } = stubLane([cut(40), cut(40), settled]);
    let calls = 0;
    const stubbed = globalThis.fetch;

    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      if (String(input) === LANE && calls++ > 0) await outcomeClock.sleep(40_000);

      return stubbed(input as string, init);
    });

    const out = await forwarded("extension_builds", { action: "get", buildId: "abc1234", project: "acme/web", waitSeconds: 180 });

    expect(out).toMatchObject({ ok: true, status: "found", value: { conclusion: "success", waited: { seconds: 80, settled: false } } });
    expect(out.hint).toContain("The 80s wait passed before build 12 settled");
    expect(out.value).not.toHaveProperty("hostedWait");
    expect(lane().map((hit) => hit.body.args.waitSeconds)).toEqual([180, 180, 140]);
    expect(new Set(lane().map((hit) => hit.headers["idempotency-key"])).size).toBe(1);
  });

  it("never sends an act again to finish its wait, and hands the agent the lane's notice", async () => {
    const dispatched = { ok: true, command: "extension_release_promote", status: "promote-dispatched", value: { hostedWait: { askedSeconds: 180, grantedSeconds: 40, notice: "The hosted lane cut this wait." } }, warnings: ["The hosted lane cut this wait."] };
    const { lane } = stubLane([dispatched]);
    const out = await forwarded("extension_release_promote", PROMOTE);

    expect(lane()).toHaveLength(1);
    expect(out).toMatchObject({ status: "promote-dispatched", value: { hostedWait: { askedSeconds: 180, grantedSeconds: 40 } }, warnings: ["The hosted lane cut this wait."] });
  });

  it("884: finishes a cut submit wait with resume legs under new keys that carry the lane's memory, and keeps the dispatched answer when the lane has nothing to resume", async () => {
    const SUBMIT = { browsers: ["firefox"], buildSha: "4cec881", dryRun: false, approvalId: "apr_884", project: "acme/web", waitSeconds: 180 };
    const memory = { "submit-dispatches": [["https://www.extension.dev\nfirefox\n4cec881", { data: { ok: true, submissions: [{ id: "sub_w", store: "firefox" }] }, modes: {} }]] };
    const dispatched = (granted: number) => ({
      ok: true,
      command: "extension_submit",
      status: "submit-dispatched",
      value: { submittedStores: ["firefox"], hostedWait: { askedSeconds: 180, grantedSeconds: granted, notice: "The hosted lane cut this wait." } },
      warnings: ["The hosted lane cut this wait."],
      memory,
    });
    const failed = { ok: false, command: "extension_submit", status: "submit-failed", error: { code: "E_PLATFORM", name: "SubmitFailed", message: "AMO refused the version." }, value: { submittedStores: ["firefox"] }, memory: {} };

    const slowLane = (answers: unknown[]) => {
      const { lane } = stubLane(answers);
      const stubbed = globalThis.fetch;
      let calls = 0;

      vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
        if (String(input) === LANE && calls++ > 0) await outcomeClock.sleep(40_000);

        return stubbed(input as string, init);
      });

      return lane;
    };

    const lane = slowLane([dispatched(29), dispatched(46), failed]);
    const out = await forwarded("extension_submit", SUBMIT);

    expect(out).toMatchObject({ ok: false, status: "submit-failed", error: { message: "AMO refused the version." } });
    expect(out.value).not.toHaveProperty("hostedWait");
    expect(lane().map((hit) => hit.body.args.local?.resumeAct)).toEqual([undefined, true, true]);
    expect(lane().map((hit) => hit.body.args.waitSeconds)).toEqual([180, 180, 140]);
    expect(lane().slice(1).every((hit) => hit.body.args.local?.memory?.["submit-dispatches"])).toBe(true);
    expect(new Set(lane().map((hit) => hit.headers["idempotency-key"])).size).toBe(3);

    const unknown = { ok: false, command: "extension_submit", status: "nothing-to-resume", error: { code: "E_BAD_REQUEST", name: "SubmitResumeUnknown", message: "No dispatched submit is remembered." }, value: {} };
    const second = slowLane([dispatched(29), unknown]);
    const kept = await forwarded("extension_submit", SUBMIT);

    expect(second()).toHaveLength(2);
    expect(kept).toMatchObject({ ok: true, status: "submit-dispatched", value: { hostedWait: { askedSeconds: 180, grantedSeconds: 29 } } });

    forgetCarriedMemory();

    const older = slowLane([{ ...dispatched(29), memory: {} }, failed]);
    const once = await forwarded("extension_submit", SUBMIT);

    expect(older()).toHaveLength(1);
    expect(once).toMatchObject({ status: "submit-dispatched", value: { hostedWait: { grantedSeconds: 29 } } });
  });

  it("carries what the lane's tools remembered into the next call and never shows it to the agent", async () => {
    const memory = { "build-dispatches": [["https://www.extension.dev\nprj_1", [{ sha: "abc1234", dispatchedAt: "2026-11-14T12:00:00Z" }]]] };
    const { lane } = stubLane([{ ...LISTED, memory }, { ...LISTED, memory: {} }, LISTED]);
    const first = await forwarded("extension_builds_act", { action: "rebuild", buildId: "abc1234", project: "acme/web" });
    await forwarded("extension_builds", { action: "list", project: "acme/web" });
    await forwarded("extension_builds", { action: "list", project: "acme/web" });

    expect(first).toEqual(LISTED);
    expect(lane()[0]?.body.args).not.toHaveProperty("local");
    expect(lane()[1]?.body.args.local).toEqual({ memory });
    expect(lane()[2]?.body.args).not.toHaveProperty("local");
  });
});

describe("the forwarder's smaller promises", () => {
  it("sends the lane the per-install id the README promises, and none when telemetry is off", async () => {
    const { lane } = stubLane([LISTED, LISTED]);
    const off = process.env.EXTENSION_DEV_NO_TELEMETRY;

    await forwarded("extension_builds", {});
    delete process.env.EXTENSION_DEV_NO_TELEMETRY;

    try {
      await forwarded("extension_builds", {});
    } finally {
      process.env.EXTENSION_DEV_NO_TELEMETRY = off;
    }

    expect(lane()[0]?.headers).not.toHaveProperty("x-extensiondev-install");
    expect(lane()[1]?.headers["x-extensiondev-install"]).toMatch(/^[0-9a-f]{32}$/);
    expect(lane()[1]?.headers["x-extensiondev-tool"]).toBe("extension_builds");
  });

  it("drops the lane function's own server stamp, so the agent never reads a pid that is not on this machine", async () => {
    stubLane([{ ...LISTED, value: { builds: [], server: { version: "0.0.1", pid: 4, startedAt: "2026-11-14T12:00:00Z" } } }]);

    expect((await forwarded("extension_builds", {})).value).toEqual({ builds: [] });
  });

  it("tells a forwarder the lane calls too old to update the package before it reconnects", async () => {
    stubLane([{ ok: false, status: "forwarder-stale", error: { code: "E_FORWARDER_STALE", message: "Update @extension.dev/mcp to 11.0.0 or newer to use the platform tools; this version is too old for the hosted contract." } }]);
    const out = await forwarded("extension_builds", {});

    expect(out).toMatchObject({ ok: false, status: "forwarder-stale", error: { code: "E_SERVER_STALE", message: expect.stringContaining("11.0.0 or newer") }, value: { forwarderVersion: "11.0.0" } });
    expect(out.hint.indexOf("@extension.dev/mcp@latest")).toBeGreaterThan(-1);
    expect(out.hint.indexOf("@extension.dev/mcp@latest")).toBeLessThan(out.hint.indexOf("/mcp, pick extension-dev"));
  });

  it("answers offline with E_NETWORK when it cannot reach www or the lane for a read", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });

    expect(await forwarded("extension_release_status", { project: "acme/web" })).toMatchObject({ ok: false, status: "offline", error: { code: "E_NETWORK" } });

    stubLane([new TypeError("fetch failed"), new TypeError("fetch failed")]);

    expect(await forwarded("extension_release_status", { project: "acme/web" })).toMatchObject({ ok: false, status: "offline", error: { code: "E_NETWORK" }, hint: expect.stringContaining("Nothing was changed") });
  });
});
