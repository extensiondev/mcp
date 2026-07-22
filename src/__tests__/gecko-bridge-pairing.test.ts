import { describe, it, expect, beforeEach, vi } from "vitest";

// Firefox pairing of the Chromium-only CDP extras: URL navigation (extension_open
// url) and live source inspection ride the agent bridge instead of CDP, so both
// families share the same flow. True protocol parity (RDP) is upstream entry 78;
// these tests pin the bridge pairing that ships now.

const calls: string[][] = [];
let actResponder: (cli: string[]) => string = () => JSON.stringify({ ok: true });
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);
      return actResponder(cli);
    },
  };
});

// RDP console replay, pinned per test: null port = pre-rdpPort engine.
let mockRdpPort: number | null = null;
let mockConsoleMessages: Array<{ level: string; text: string }> = [];
vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return {
    ...actual,
    resolveRdpPort: async () =>
      mockRdpPort == null
        ? null
        : { port: mockRdpPort, source: "contract" as const },
  };
});
vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/rdp")>();
  return {
    ...actual,
    rdpCollectConsoleMessages: async () => mockConsoleMessages,
  };
});

// The session-browser resolver reads ready.json from disk; pin it to the
// browser the test passes so no filesystem is involved.
vi.mock("../lib/session-browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/session-browser")>();
  return {
    ...actual,
    resolveSessionBrowser: (_p: string, browser?: string, fallback?: string) => ({
      browser: browser ?? fallback ?? "chrome",
      source: "arg",
    }),
  };
});

const open = await import("../tools/open");
const sourceInspect = await import("../tools/source-inspect");

const isEval = (cli: string[]) => cli[0] === "eval";
const isListTabs = (cli: string[]) => cli.includes("--list-tabs");

beforeEach(() => {
  calls.length = 0;
  actResponder = () => JSON.stringify({ ok: true });
  mockRdpPort = null;
  mockConsoleMessages = [];
});

describe("extension_open url on Gecko (bridge navigation)", () => {
  it("navigates via a background tabs.update eval and verifies against the tab list", async () => {
    actResponder = (cli) => {
      if (isListTabs(cli)) {
        return JSON.stringify({
          ok: true,
          tabs: [{ tabId: 7, url: "https://example.com/", title: "Example" }],
        });
      }
      if (isEval(cli)) return JSON.stringify({ ok: true, value: { tabId: 7 } });
      return JSON.stringify({ ok: true });
    };

    const result = JSON.parse(
      await open.handler({
        projectPath: "/p",
        url: "https://example.com/",
        browser: "firefox",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.navigated).toBe("https://example.com/");
    // A NUMERIC chrome.tabs id, unlike the CDP path's targetId.
    expect(result.tab).toEqual({
      tabId: 7,
      url: "https://example.com/",
      title: "Example",
    });
    const evalCall = calls.find(isEval)!;
    expect(evalCall[1]).toContain("tabs.query");
    expect(evalCall[1]).toContain("https://example.com/");
    expect(evalCall[evalCall.indexOf("--context") + 1]).toBe("background");
  });

  it("passes the engine's own error through with an allowEval hint", async () => {
    actResponder = (cli) =>
      isEval(cli)
        ? JSON.stringify({
            ok: false,
            error: { name: "EvalDenied", message: "eval is not allowed" },
          })
        : JSON.stringify({ ok: true });

    const result = JSON.parse(
      await open.handler({
        projectPath: "/p",
        url: "https://example.com/",
        browser: "firefox",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("EvalDenied");
    expect(result.hint).toContain("allowEval");
  });

  it("reports NavigateFailed when no tab ever reports the URL", async () => {
    actResponder = (cli) => {
      if (isListTabs(cli)) {
        return JSON.stringify({
          ok: true,
          tabs: [{ tabId: 7, url: "about:blank", title: "" }],
        });
      }
      return JSON.stringify({ ok: true, value: { tabId: 7 } });
    };

    const result = JSON.parse(
      await open.handler({
        projectPath: "/p",
        url: "https://example.com/",
        browser: "firefox",
        timeout: 300,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NavigateFailed");
  });
});

describe("extension_source_inspect on Gecko (bridge inspection)", () => {
  const pageValue = {
    meta: { url: "https://example.com/", title: "Example", readyState: "complete" },
    summary: { htmlLength: 120, scriptCount: 1, styleCount: 0, linkCount: 0, extensionRootCount: 1, bodyChildCount: 2 },
    html: "<html><body>hi</body></html>",
  };

  it("returns summary/meta/html over the bridge with the CDP-only gaps named", async () => {
    actResponder = (cli) => {
      if (isListTabs(cli)) {
        return JSON.stringify({
          ok: true,
          tabs: [{ tabId: 7, url: "https://example.com/", title: "Example" }],
        });
      }
      if (isEval(cli)) return JSON.stringify({ ok: true, value: pageValue });
      return JSON.stringify({ ok: true });
    };

    const result = JSON.parse(
      await sourceInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        url: "https://example.com/",
        include: ["summary", "meta", "html", "console"],
      }),
    );

    expect(result.transport).toBe("bridge");
    expect(result.browser).toBe("firefox");
    expect(result.target).toEqual({ url: "https://example.com/", title: "Example" });
    expect(result.summary.extensionRootCount).toBe(1);
    expect(result.html).toContain("<body>hi</body>");
    expect(String(result.notes)).toContain("extension_logs");
    const evalCall = calls.find(isEval)!;
    expect(evalCall[evalCall.indexOf("--context") + 1]).toBe("page");
    expect(evalCall[evalCall.indexOf("--url") + 1]).toBe("https://example.com/");
  });

  it("navigates first when the url is not open in any tab", async () => {
    let navigated = false;
    actResponder = (cli) => {
      if (isListTabs(cli)) {
        return JSON.stringify({
          ok: true,
          tabs: navigated
            ? [{ tabId: 7, url: "https://example.com/", title: "Example" }]
            : [{ tabId: 7, url: "about:blank", title: "" }],
        });
      }
      if (isEval(cli) && String(cli[1]).includes("tabs.query")) {
        navigated = true;
        return JSON.stringify({ ok: true, value: { tabId: 7 } });
      }
      if (isEval(cli)) return JSON.stringify({ ok: true, value: pageValue });
      return JSON.stringify({ ok: true });
    };

    const result = JSON.parse(
      await sourceInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        url: "https://example.com/",
        include: ["summary"],
      }),
    );

    expect(result.transport).toBe("bridge");
    expect(result.summary).toBeTruthy();
    expect(calls.some((c) => isEval(c) && String(c[1]).includes("tabs.query"))).toBe(true);
  });

  it("pairs dom_snapshot and extension_roots over the bridge with the CDP page scripts", async () => {
    const snapshot = [{ tag: "html", depth: 0, childCount: 2 }];
    const roots = { rootCount: 1, markerCount: 0, latestGeneration: 3, roots: [], markers: [] };
    actResponder = (cli) => {
      if (isListTabs(cli)) {
        return JSON.stringify({
          ok: true,
          tabs: [{ tabId: 7, url: "https://example.com/", title: "Example" }],
        });
      }
      if (isEval(cli)) {
        return JSON.stringify({
          ok: true,
          value: { ...pageValue, domSnapshot: snapshot, extensionRoots: roots },
        });
      }
      return JSON.stringify({ ok: true });
    };

    const result = JSON.parse(
      await sourceInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        url: "https://example.com/",
        include: ["summary", "html", "dom_snapshot", "extension_roots"],
      }),
    );

    expect(result.transport).toBe("bridge");
    expect(result.domSnapshot).toEqual(snapshot);
    expect(result.extensionRoots).toEqual(roots);
    // No note may claim these are Chromium-only anymore.
    expect(JSON.stringify(result.notes ?? [])).not.toContain("dom_snapshot");
    const evalCall = calls.find(isEval)!;
    // The bridge expression embeds the SAME CDP page scripts: the dom walker,
    // the reinject-generation reader, and the shadow-aware html serializer.
    expect(evalCall[1]).toContain("domSnapshot");
    expect(evalCall[1]).toContain("data-extjs-reinject-generation");
    expect(evalCall[1]).toContain("XMLSerializer");
  });

  it("summarizes the RDP console replay when the session publishes rdpPort", async () => {
    mockRdpPort = 9223;
    mockConsoleMessages = [
      { level: "log", text: "hi" },
      { level: "log", text: "hi" },
      { level: "error", text: "boom" },
    ];
    actResponder = (cli) => {
      if (isListTabs(cli)) {
        return JSON.stringify({
          ok: true,
          tabs: [{ tabId: 7, url: "https://example.com/", title: "Example" }],
        });
      }
      if (isEval(cli)) return JSON.stringify({ ok: true, value: pageValue });
      return JSON.stringify({ ok: true });
    };

    const result = JSON.parse(
      await sourceInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        url: "https://example.com/",
        include: ["summary", "console"],
      }),
    );

    expect(result.rdpPort).toBe(9223);
    expect(result.console.total).toBe(3);
    expect(result.console.counts).toEqual({ log: 2, error: 1 });
    expect(result.console.topMessages[0]).toEqual({
      level: "log",
      text: "hi",
      count: 2,
    });
    // No fallback note once console genuinely rides RDP.
    expect(JSON.stringify(result.notes ?? [])).not.toContain("extension_logs");
  });

  it("keeps the extension_logs fallback note on a pre-rdpPort engine", async () => {
    mockRdpPort = null;
    actResponder = (cli) =>
      isEval(cli)
        ? JSON.stringify({ ok: true, value: pageValue })
        : JSON.stringify({ ok: true });

    const result = JSON.parse(
      await sourceInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        include: ["summary", "console"],
      }),
    );

    expect(result.console).toBeUndefined();
    expect(String(result.notes)).toContain("extension_logs");
  });

  it("walks closed shadow roots via a background executeScript eval", async () => {
    actResponder = (cli) => {
      if (!isEval(cli)) return JSON.stringify({ ok: true });
      const context = cli[cli.indexOf("--context") + 1];
      if (context === "background") {
        return JSON.stringify({
          ok: true,
          value: {
            frames: [
              {
                api: true,
                closed: [{ host: "div", html: "<p>secret</p>" }],
              },
            ],
          },
        });
      }
      return JSON.stringify({ ok: true, value: pageValue });
    };

    const result = JSON.parse(
      await sourceInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        include: ["summary"],
        deepDom: true,
      }),
    );

    expect(result.deepDom).toBe(true);
    expect(result.closedShadowRoots).toEqual([
      { host: "div", type: "closed", html: "<p>secret</p>" },
    ]);
    const bgCall = calls.find(
      (c) => isEval(c) && c[c.indexOf("--context") + 1] === "background",
    )!;
    expect(bgCall[1]).toContain("executeScript");
    expect(bgCall[1]).toContain("openOrClosedShadowRoot");
  });

  it("notes the deepDom failure with the host-permissions hint", async () => {
    actResponder = (cli) => {
      if (!isEval(cli)) return JSON.stringify({ ok: true });
      const context = cli[cli.indexOf("--context") + 1];
      if (context === "background") {
        return JSON.stringify({
          ok: true,
          value: { error: "Missing host permission for the tab" },
        });
      }
      return JSON.stringify({ ok: true, value: pageValue });
    };

    const result = JSON.parse(
      await sourceInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        include: ["summary"],
        deepDom: true,
      }),
    );

    expect(result.deepDom).toBeUndefined();
    expect(String(result.notes)).toContain("deepDom failed");
    expect(String(result.notes)).toContain("host permissions");
  });

  it("falls back to tabs.executeScript when the engine has no page-context eval (MV2)", async () => {
    // The live MV2 behavior: page-context eval reports Unsupported because
    // chrome.scripting is MV3-only; the same expression compiled in the
    // content-script sandbox returns the identical out object.
    actResponder = (cli) => {
      if (isListTabs(cli)) {
        return JSON.stringify({
          ok: true,
          tabs: [{ tabId: 7, url: "https://example.com/", title: "Example" }],
        });
      }
      if (!isEval(cli)) return JSON.stringify({ ok: true });
      const context = cli[cli.indexOf("--context") + 1];
      if (context === "page") {
        return JSON.stringify({
          ok: false,
          error: {
            name: "Unsupported",
            message:
              'chrome.scripting is not available on this engine (MV2 has no scripting API); use context: "background"',
          },
        });
      }
      return JSON.stringify({ ok: true, value: { frames: [pageValue] } });
    };

    const result = JSON.parse(
      await sourceInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        url: "https://example.com/",
        include: ["summary", "html"],
      }),
    );

    expect(result.transport).toBe("bridge");
    expect(result.summary.extensionRootCount).toBe(1);
    expect(result.html).toContain("<body>hi</body>");
    const bgCall = calls.filter(isEval).find(
      (c) => c[c.indexOf("--context") + 1] === "background",
    )!;
    expect(bgCall[1]).toContain("executeScript");
  });

  it("surfaces the MV2 fallback's content-script failure as InspectFailed", async () => {
    actResponder = (cli) => {
      if (!isEval(cli)) return JSON.stringify({ ok: true });
      const context = cli[cli.indexOf("--context") + 1];
      if (context === "page") {
        return JSON.stringify({
          ok: false,
          error: { name: "Unsupported", message: "chrome.scripting is not available on this engine" },
        });
      }
      return JSON.stringify({
        ok: true,
        value: { error: "Missing host permission for the tab" },
      });
    };

    const result = JSON.parse(
      await sourceInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        include: ["summary"],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("InspectFailed");
    expect(result.error.message).toContain("host permission");
    expect(result.hint).toContain("host permissions");
  });

  it("warns when a probe looks like JavaScript instead of a CSS selector", async () => {
    actResponder = (cli) =>
      isEval(cli)
        ? JSON.stringify({
            ok: true,
            value: {
              meta: { url: "https://example.com/", title: "Example" },
              probes: { "typeof chrome.tts": { count: 0, sample: null } },
            },
          })
        : JSON.stringify({ ok: true });

    const result = JSON.parse(
      await sourceInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        probe: ["typeof chrome.tts"],
        include: ["meta"],
      }),
    );

    expect(result.probes["typeof chrome.tts"].count).toBe(0);
    expect(result.probeWarning).toContain("NOT JavaScript");
  });

  it("passes the engine's eval error frame through untouched", async () => {
    actResponder = (cli) =>
      isEval(cli)
        ? JSON.stringify({
            ok: false,
            error: { name: "NoSession", message: "no active control channel" },
          })
        : JSON.stringify({ ok: true });

    const result = JSON.parse(
      await sourceInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        include: ["summary"],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoSession");
  });
});
