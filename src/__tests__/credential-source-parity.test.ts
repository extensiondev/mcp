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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHostedServer } from "../hosted";
import { writeCredentials } from "../lib/credentials";
import { createServer } from "../index";
import { PROJECT, WWW, stubPlatformFetch, type SeenRequest } from "./hosted-platform-fetch";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

const LOCAL_TOKEN = "parity-token-local";
const HOSTED_TOKEN = "parity-token-hosted";
const EXPIRES_AT = 4102444800;
const NOW = new Date("2026-10-15T12:00:00.000Z");

const CALLS: Array<[string, Record<string, unknown>]> = [
  ["extension_auth", { action: "status" }],
  ["extension_builds", { action: "list" }],
  ["extension_builds", { action: "get", buildId: "0123456789abcdef0123456789abcdef01234567" }],
  ["extension_release_status", {}],
  ["extension_release_status", { include: ["stores", "history"] }],
  ["extension_workspace", { action: "info" }],
  ["extension_workspace", { action: "projects" }],
  ["extension_workspace", { action: "settings", project: "acme/web" }],
  ["extension_release_promote", { action: "promote", buildId: "0123456789abcdef0123456789abcdef01234567", channel: "stable" }],
];

let tmp = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-parity-"));
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_NO_TELEMETRY"]) saved[key] = process.env[key];
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_NO_TELEMETRY = "1";
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  delete process.env.EXTENSION_DEV_API_URL;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

async function connect(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "parity-probe", version: "0.0.0" });
  await client.connect(clientTransport);

  return client;
}

function comparable(text: string): unknown {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const boundary = (parsed.untrusted as { boundary?: string } | undefined)?.boundary;
  delete parsed.untrusted;
  delete parsed.untrustedEnd;
  const body = JSON.stringify(parsed);

  return JSON.parse(boundary ? body.split(boundary).join("<boundary>") : body);
}

function withoutWording(envelope: unknown): unknown {
  const { hint: _hint, warnings: _warnings, ...rest } = envelope as Record<string, unknown>;

  return rest;
}

async function run(client: Client, seen: SeenRequest[]) {
  const tokens = new Set<string>();
  const answers: Array<{ envelope: unknown; isError: boolean; tokens?: string[]; requests: Array<Omit<SeenRequest, "project">> }> = [];

  for (const [name, args] of CALLS) {
    seen.length = 0;
    const result = await client.callTool({ name, arguments: args });
    answers.push({
      envelope: comparable((result.content as Array<{ text: string }>)[0]?.text ?? ""),
      isError: result.isError === true,
      tokens: seen.map((request) => request.authorization ?? "").filter(Boolean),
      requests: seen.map(({ project: _project, ...request }) => ({ ...request, authorization: request.authorization?.replace(/^Bearer .+$/, "Bearer <token>") ?? null })),
    });
  }

  for (const answer of answers) {
    for (const token of answer.tokens ?? []) tokens.add(token);
    delete answer.tokens;
  }

  return { answers, tokens: [...tokens] };
}

describe("credential source parity", () => {
  it("answers the same envelopes from a stored login and from a request credential", async () => {
    const seen = stubPlatformFetch();

    writeCredentials({ version: 1, token: LOCAL_TOKEN, workspaceSlug: PROJECT.workspace, projectSlug: PROJECT.project, expiresAt: EXPIRES_AT, api: WWW });
    const local = await run(await connect(createServer({ features: ["local", "platform"], noShip: false })), seen);

    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const hosted = await run(
      await connect(createHostedServer({ credential: { token: HOSTED_TOKEN, api: WWW, projects: [PROJECT], expiresAt: EXPIRES_AT } })),
      seen,
    );

    expect(hosted.answers.length).toBe(CALLS.length);

    for (const [index, [name]] of CALLS.entries()) {
      const pair = [hosted.answers[index], local.answers[index]].map((answer) =>
        name === "extension_auth" ? { ...answer, envelope: withoutWording(answer!.envelope) } : answer,
      );

      expect({ name, ...pair[0] }).toEqual({ name, ...pair[1] });
    }

    expect(local.tokens).toEqual([`Bearer ${LOCAL_TOKEN}`]);
    expect(hosted.tokens).toEqual([`Bearer ${HOSTED_TOKEN}`]);
  });
});
