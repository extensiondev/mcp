import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { handler } from "../tools/publish";
import {
  PUBLISH_EXPIRES_AT_EPOCH,
  publishAnswer,
  publishAnswerWithLink,
} from "./fixtures/platform-answers";

describe("extension_publish envelope compatibility", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;
  let prevApi: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-envelope-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_TOKEN;
    delete process.env.EXTENSION_DEV_API_URL;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the frozen PublishAuthError bytes when no token is available", async () => {
    const out = await handler({});
    expect(out).toBe(
      JSON.stringify({
        schema: 1,
        ok: false,
        command: "extension_publish",
        status: "auth-required",
        value: null,
        error: {
          code: "E_AUTH_REQUIRED",
          name: "PublishAuthError",
          message:
            "No token. Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard). An extension with no extension.dev project yet starts with extension_project_create, which makes one from its GitHub repository, then extension_auth.",
        },
        warnings: [],
      }),
    );
  });

  it("returns the frozen PublishConfigError bytes for a plaintext api URL", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok_test";
    const out = await handler({
      api: "http://evil.example.com",
    });
    expect(out).toBe(
      JSON.stringify({
        schema: 1,
        ok: false,
        command: "extension_publish",
        status: "publish-failed",
        value: null,
        error: {
          code: "E_PLATFORM",
          name: "PublishConfigError",
          message:
            "Refusing to send the access token to http://evil.example.com: use https (http is allowed only for localhost).",
        },
        warnings: [],
      }),
    );
  });

  it("names the remedy when the platform answers 404 for the token's project", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok_test";
    const origFetch = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          message: "Project not found",
          code: "PROJECT_NOT_FOUND",
          createProjectUrl: "https://www.extension.dev/new",
        }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch;

    try {
      const out = JSON.parse(await handler({}));
      expect(out.ok).toBe(false);
      expect(out.status).toBe("publish-failed");
      expect(out.error.message).toContain("(404)");
      expect(out.hint).toMatch(/extension\.dev\/new/);
      expect(out.hint).toMatch(/extension_auth \(action: status\)/);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("sends EXTENSION_DEV_TOKEN for an unnamed call and the stored login for a named one", async () => {
    writeCredentials({
      version: 1,
      token: "tok_stored",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });

    const envToken = `${Buffer.from(JSON.stringify({ u: "acme", p: "widget", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
    process.env.EXTENSION_DEV_TOKEN = envToken;
    const bearers: string[] = [];
    const prevFetch = global.fetch;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      bearers.push(
        String((init?.headers as Record<string, string>)?.authorization ?? ""),
      );

      return new Response(
        JSON.stringify({ message: "stop here", code: "PROJECT_NOT_FOUND" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      await handler({ api: "https://www.extension.dev" });
      await handler({
        api: "https://www.extension.dev",
        project: "acme/widget",
      });
    } finally {
      global.fetch = prevFetch;
    }

    expect(bearers[0]).toBe(`Bearer ${envToken}`);
    expect(bearers[1]).toBe("Bearer tok_stored");
  });

  describe("build link lifetime", () => {
    async function publishWith(
      ttlHours: number,
      expiresAt: number,
      answeredTtl: number,
    ) {
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      const bodies: Array<Record<string, unknown>> = [];
      const prevFetch = global.fetch;
      global.fetch = (async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/api/cli/publish")) {
          bodies.push(JSON.parse(String(init?.body ?? "{}")));

          return new Response(
            JSON.stringify(publishAnswer({ expiresAt, ttlHours: answeredTtl })),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        return new Response("{}", {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      try {
        return {
          out: JSON.parse(
            await handler({ api: "https://www.extension.dev", ttlHours }),
          ),
          bodies,
        };
      } finally {
        global.fetch = prevFetch;
      }
    }

    it.each([
      [
        "720 hours, a free plan's 30-day window",
        720,
        1793793600,
        720,
        "2026-11-04T12:00:00.000Z",
        false,
      ],
      [
        "8760 hours, a Pro plan's 365-day window",
        8760,
        1822737600,
        8760,
        "2027-10-05T12:00:00.000Z",
        false,
      ],
      [
        "8760 hours on a free plan, which the platform cuts to 30 days",
        8760,
        1793793600,
        720,
        "2026-11-04T12:00:00.000Z",
        true,
      ],
    ])(
      "sends %s and reports the expiry the platform answers as an ISO date",
      async (_name, ttlHours, epoch, answeredTtl, iso, clamped) => {
        const { out, bodies } = await publishWith(ttlHours, epoch, answeredTtl);

        expect(out.ok).toBe(true);
        expect(bodies).toEqual([{ ttlHours }]);
        expect(out.value.expiresAt).toBe(iso);
        expect(out.value.expiresAtEpoch).toBe(epoch);
        expect(out.value.link.expiresAt).toBe(iso);
        expect(out.value.ttlHoursRequested).toBe(ttlHours);
        expect(out.value.ttlHours).toBe(answeredTtl);
        expect(out.value.clamped).toBe(clamped);
      },
    );

    it("refuses a lifetime past a year before sending anything", async () => {
      const { out, bodies } = await publishWith(8761, 1822737600, 8760);

      expect(out.error.code).toBe("E_BAD_REQUEST");
      expect(out.error.message).toContain("8760");
      expect(bodies).toHaveLength(0);
    });
  });

  describe("the link to send and the sentence to say with it", () => {
    const API = "https://www.extension.dev";
    const ISO = new Date(PUBLISH_EXPIRES_AT_EPOCH * 1000).toISOString();

    async function publishAgainst(
      answer: Record<string, unknown>,
      channels: Record<string, unknown> = {},
      args: Record<string, unknown> = {},
    ) {
      process.env.EXTENSION_DEV_TOKEN = `${Buffer.from(
        JSON.stringify({
          u: "acme",
          p: "widget",
          exp: Math.floor(Date.now() / 1000) + 600,
        }),
      ).toString("base64url")}.sig`;

      const prevFetch = global.fetch;
      global.fetch = (async (url: string) => {
        const href = String(url);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });

        if (href.endsWith("/api/cli/publish")) return json(answer);
        if (href.endsWith("/channels.json")) return json(channels);
        if (href.endsWith("/builds/index.json")) return json({ items: [] });

        return new Response("{}", {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      try {
        return JSON.parse(await handler({ api: API, ...args }));
      } finally {
        global.fetch = prevFetch;
      }
    }

    it.each([
      [
        "an older platform that answers epoch seconds and no link",
        publishAnswer(),
      ],
      [
        "a platform that answers link and projectVisibility",
        publishAnswerWithLink(),
      ],
    ])(
      "a private project from %s gets a build link with an ISO expiry and a way to renew it",
      async (_name, answer) => {
        const out = await publishAgainst(answer);

        expect(out.status).toBe("publish-dispatched");
        expect(out.value.outcome.recorded).toBe(false);
        expect(out.value.link).toMatchObject({
          kind: "build",
          url: "https://acme.extension.dev/widget/builds/abc1234?share=tok_share",
          expiresAt: ISO,
          pointsAt: "this build",
          audience: "anyone with the link",
          renewBy: {
            tool: "extension_publish",
            args: { buildSha: "abc1234", ttlHours: 168 },
          },
        });

        expect(out.value.expiresAt).toBe(ISO);
        expect(out.value.expiresAtEpoch).toBe(PUBLISH_EXPIRES_AT_EPOCH);
        expect(out.value.links.map((l: { kind: string }) => l.kind)).toEqual([
          "share",
          "track",
          "build",
        ]);

        expect(out.value.links[0]).toMatchObject({
          url: "https://acme.extension.dev/widget/builds/abc1234?share=tok_share",
          audience: "anyone with the link",
          expiresAt: ISO,
          made: true,
        });

        expect(out.value.projectVisibility).toMatchObject({
          value: "private",
          source: "extension.dev project settings",
        });

        expect(
          JSON.stringify(out.value.projectVisibility.makeEvergreen),
        ).toMatch(/console/);

        expect(
          JSON.stringify(out.value.projectVisibility.makeEvergreen),
        ).toMatch(/settings\/visibility/);

        expect(
          JSON.stringify(out.value.projectVisibility.makeEvergreen),
        ).not.toMatch(/repositor/i);

        expect(out.value.tellThem).toBe(
          "Here is widget to try: https://acme.extension.dev/widget/builds/abc1234?share=tok_share. It works until October 6, 2026 at 12:00 UTC.",
        );

        expect(out.value.tellThem).not.toMatch(/repo/i);
        expect(out.value.link.id).toBeNull();
        expect(out.hint).toContain(
          "Send value.tellThem to the person as written",
        );
      },
    );

    it("names the extension by its manifest name and flags a project display name that differs", async () => {
      const out = await publishAgainst(
        publishAnswerWithLink({
          projectName: "PII Shield",
          extensionName: "Rebeccat",
        }),
      );

      expect(out.value.tellThem).toContain("Here is Rebeccat to try:");
      expect(out.value.tellThem).not.toContain("PII Shield");
      const note = out.warnings.find(
        (line: string | null) =>
          typeof line === "string" && line.includes("display name"),
      );
      expect(note).toContain('manifest names the extension "Rebeccat"');
      expect(note).toContain('display name on extension.dev is "PII Shield"');
      expect(note).toMatch(/project-settings/);
      expect(note).toContain("does not write them");

      const same = await publishAgainst(
        publishAnswerWithLink({
          projectName: "Rebeccat",
          extensionName: "Rebeccat",
        }),
      );
      expect(
        same.warnings.some(
          (line: string | null) =>
            typeof line === "string" && line.includes("display name"),
        ),
      ).toBe(false);
    });

    it("never echoes the raw share token beside the link that already carries it", async () => {
      const out = await publishAgainst(publishAnswerWithLink());

      expect(out.value).not.toHaveProperty("token");
      expect(out.value.shareUrl).toContain("share=tok_share");
      expect(out.value.previewCommands.chrome).toContain("t=tok_share");
    });

    it("a public project with no channel serving the build gets a build link that never expires", async () => {
      const answer = publishAnswer({
        visibility: "public",
        shareUrl: "https://acme.extension.dev/widget/builds/abc1234",
        token: undefined,
        expiresAt: undefined,
        ttlHours: undefined,
      });
      const out = await publishAgainst(answer, { beta: { sha: "bead5ee" } });

      expect(out.value.link).toMatchObject({
        kind: "build",
        expiresAt: null,
        pointsAt: "this build",
      });

      expect(out.value.link.renewBy ?? null).toBeNull();
      expect(out.value.expiresAt).toBeNull();
      expect(out.value.projectVisibility).toMatchObject({
        value: "public",
        source: "extension.dev project settings",
      });

      expect(out.value.projectVisibility.makeEvergreen ?? null).toBeNull();
      expect(out.value.tellThem).toBe(
        "Here is widget to try: https://acme.extension.dev/widget/builds/abc1234.",
      );
    });

    it.each([
      [
        "an older platform",
        publishAnswer({
          visibility: "public",
          shareUrl: "https://acme.extension.dev/widget/builds/abc1234",
          token: undefined,
          expiresAt: undefined,
          ttlHours: undefined,
        }),
      ],
      [
        "a platform that answers link",
        publishAnswerWithLink({
          visibility: "public",
          shareUrl: "https://acme.extension.dev/widget/builds/abc1234",
          token: undefined,
          expiresAt: undefined,
          ttlHours: undefined,
        }),
      ],
    ])(
      "a public project whose build a channel serves gets both kinds from %s and is told to send the channel link",
      async (_name, answer) => {
        const out = await publishAgainst(answer, {
          "chrome-stable": { sha: "abc1234" },
        });

        expect(out.value.links.slice(0, 2)).toEqual([
          expect.objectContaining({
            kind: "build",
            url: "https://acme.extension.dev/widget/builds/abc1234",
            expiresAt: null,
            made: false,
          }),
          expect.objectContaining({
            kind: "channel",
            url: "https://acme.extension.dev/widget/channels/stable",
            expiresAt: null,
            pointsAt: "latest in stable",
            made: false,
          }),
        ]);

        expect(out.value.tellThem).toBe(
          "Here is widget to try: https://acme.extension.dev/widget/channels/stable. It always opens the newest stable build.",
        );

        expect(out.hint).toContain(
          "Send value.tellThem to the person as written",
        );
      },
    );

    it("an older public answer with a serving channel synthesizes a channel link", async () => {
      const answer = publishAnswer({
        visibility: "public",
        shareUrl: "https://acme.extension.dev/widget/builds/abc1234",
        token: undefined,
        expiresAt: undefined,
        ttlHours: undefined,
      });
      const out = await publishAgainst(answer, {
        "chrome-stable": { sha: "abc1234" },
      });

      expect(out.value.link).toMatchObject({
        kind: "channel",
        url: "https://acme.extension.dev/widget/channels/stable",
        expiresAt: null,
        audience: "public",
      });
    });

    it("a private project with no build to link answers the platform's refusal with the next step", async () => {
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      const prevFetch = global.fetch;
      global.fetch = (async () =>
        new Response(
          JSON.stringify({
            message:
              "This private project has no completed build to link yet, and a share link opens one build.",
            code: "NO_BUILD_TO_SHARE",
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        )) as unknown as typeof fetch;

      try {
        const out = JSON.parse(await handler({ api: API }));

        expect(out.ok).toBe(false);
        expect(out.status).toBe("no-build-to-share");
        expect(out.error.platformCode).toBe("NO_BUILD_TO_SHARE");
        expect(out.hint).toMatch(/build link/);
        expect(out.hint).toMatch(/extension_builds/);
      } finally {
        global.fetch = prevFetch;
      }
    });
  });
});
