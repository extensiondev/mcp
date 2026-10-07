// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPConnection } from "./cdp-connection";
import {
  PAGE_HTML_SCRIPT,
  PAGE_META_SCRIPT,
  EXTENSION_ROOT_META_SCRIPT,
  RENDER_EVIDENCE_SCRIPT,
  probeSelectorsScript,
  domSnapshotScript,
} from "./cdp-page-scripts";

export interface RenderEvidence {
  readyState?: string;
  title?: string;
  bodyChildCount?: number;
  bodyElementCount?: number;
  textLength?: number;
  renderedElementCount?: number;
  visualElementCount?: number;
  renderedTextLength?: number;
  extensionRootCount?: number;
}

export interface DomSnapshot {
  nodes: Array<Record<string, unknown>>;
  totalElements: number;
  truncated: boolean;
  maxNodes: number;
  maxDepth: number;
}

export function normalizeDomSnapshot(result: unknown, maxNodes: number): DomSnapshot {
  if (Array.isArray(result)) {
    return { nodes: result, totalElements: result.length, truncated: false, maxNodes, maxDepth: 20 };
  }

  const obj = (result ?? {}) as Partial<DomSnapshot>;
  const nodes = Array.isArray(obj.nodes) ? obj.nodes : [];

  return {
    nodes,
    totalElements: typeof obj.totalElements === "number" ? obj.totalElements : nodes.length,
    truncated: obj.truncated === true,
    maxNodes,
    maxDepth: 20,
  };
}

export class CDPClient extends CDPConnection {
  static async discoverBrowserWsUrl(
    port: number,
    host = "127.0.0.1",
  ): Promise<string> {
    const res = await fetch(`http://${host}:${port}/json/version`);
    if (!res.ok) throw new Error(`CDP /json/version failed: ${res.status}`);

    const data = (await res.json()) as Record<string, unknown>;

    if (typeof data.webSocketDebuggerUrl === "string") {
      return data.webSocketDebuggerUrl;
    }

    throw new Error("No webSocketDebuggerUrl in /json/version response");
  }

  /* @invariant The browser says whether it is headless in its own product
     string ("HeadlessChrome/151..."), which is the only reading that survives
     a launcher shim adding --headless=new behind the caller's back; the
     environment variables this server also consults describe the request, not
     the process that came up. */
  static async discoverBrowserVersion(
    port: number,
    host = "127.0.0.1",
  ): Promise<string | null> {
    try {
      const res = await fetch(`http://${host}:${port}/json/version`);
      if (!res.ok) return null;

      const data = (await res.json()) as Record<string, unknown>;

      return typeof data.Browser === "string" ? data.Browser : null;
    } catch {
      return null;
    }
  }

  /* @invariant Chrome's new headless mode (--headless=new, the mode a launcher
     shim adds) keeps "Chrome/151..." in the Browser field and says
     HeadlessChrome only in the User-Agent field of /json/version, measured on
     Chrome 151. Both fields are read. */
  static async discoverUserAgent(
    port: number,
    host = "127.0.0.1",
  ): Promise<string | null> {
    try {
      const res = await fetch(`http://${host}:${port}/json/version`);
      if (!res.ok) return null;

      const data = (await res.json()) as Record<string, unknown>;

      return typeof data["User-Agent"] === "string" ? data["User-Agent"] : null;
    } catch {
      return null;
    }
  }

  static async discoverTargets(
    port: number,
    host = "127.0.0.1",
  ): Promise<
    Array<{
      id: string;
      type: string;
      url: string;
      title: string;
      webSocketDebuggerUrl: string;
    }>
  > {
    const res = await fetch(`http://${host}:${port}/json`);
    if (!res.ok) throw new Error(`CDP /json failed: ${res.status}`);

    return (await res.json()) as Array<{
      id: string;
      type: string;
      url: string;
      title: string;
      webSocketDebuggerUrl: string;
    }>;
  }

  async getTargets(): Promise<Array<Record<string, unknown>>> {
    const response = (await this.sendCommand("Target.getTargets")) as
      | { targetInfos?: Array<Record<string, unknown>> }
      | undefined;

    return response?.targetInfos ?? [];
  }

  async attachToTarget(targetId: string): Promise<string> {
    const response = (await this.sendCommand("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId?: string };

    return response.sessionId ?? "";
  }

  async enableDomains(sessionId: string): Promise<void> {
    await Promise.all([
      this.sendCommand("Runtime.enable", {}, sessionId),
      this.sendCommand("Log.enable", {}, sessionId),
      this.sendCommand("Page.enable", {}, sessionId),
    ]);
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    /* @invariant Page.navigate answers `errorText` (net::ERR_NAME_NOT_RESOLVED,
       net::ERR_CONNECTION_REFUSED, net::ERR_BLOCKED_BY_CLIENT) without a
       protocol error. Dropping it called a refused navigation navigated. */
    const reply = (await this.sendCommand("Page.navigate", { url }, sessionId)) as
      | { errorText?: unknown }
      | undefined;

    if (typeof reply?.errorText === "string" && reply.errorText) {
      throw new Error(`The browser refused to navigate to ${url}: ${reply.errorText}`);
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000);

      const unsubscribe = this.onEvent((msg) => {
        if (msg.method === "Page.loadEventFired") {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });
  }

  async evaluate(sessionId: string, expression: string): Promise<unknown> {
    const response = (await this.sendCommand(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: false },
      sessionId,
    )) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };

    if (response?.exceptionDetails) {
      const details = response.exceptionDetails;

      throw new Error(
        `the page threw while evaluating: ${details.exception?.description ?? details.text ?? "unknown error"}`,
      );
    }

    return response?.result?.value;
  }

  async getPageHTML(sessionId: string): Promise<string> {
    const result = await this.evaluate(sessionId, PAGE_HTML_SCRIPT);

    return typeof result === "string" ? result : "";
  }

  async getClosedShadowRoots(
    sessionId: string,
    maxBytes = 65536,
  ): Promise<
    Array<{ host: string; type: string; html: string; truncated?: boolean }>
  > {
    await this.sendCommand("DOM.enable", {}, sessionId);
    const doc = (await this.sendCommand(
      "DOM.getDocument",
      { depth: -1, pierce: true },
      sessionId,
    )) as { root?: unknown };

    const found: Array<{ nodeId: number; host: string; type: string }> = [];

    const walk = (node: any, hostName: string): void => {
      if (!node || typeof node !== "object") return;

      const name = node.localName || node.nodeName || hostName;

      if (Array.isArray(node.shadowRoots)) {
        for (const sr of node.shadowRoots) {
          if (
            sr &&
            sr.shadowRootType === "closed" &&
            typeof sr.nodeId === "number"
          ) {
            found.push({
              nodeId: sr.nodeId,
              host: String(name),
              type: "closed",
            });
          }

          walk(sr, name);
        }
      }

      if (Array.isArray(node.children))
        {for (const c of node.children) walk(c, name);}

      if (node.contentDocument) walk(node.contentDocument, name);
    };

    walk((doc as any).root, "html");

    const out: Array<{
      host: string;
      type: string;
      html: string;
      truncated?: boolean;
    }> = [];

    for (const f of found) {
      try {
        const oh = (await this.sendCommand(
          "DOM.getOuterHTML",
          { nodeId: f.nodeId },
          sessionId,
        )) as { outerHTML?: string };
        let html = String(oh?.outerHTML ?? "");
        let truncated = false;

        if (maxBytes > 0 && html.length > maxBytes) {
          html = html.slice(0, maxBytes);
          truncated = true;
        }

        out.push({
          host: f.host,
          type: f.type,
          html,
          ...(truncated ? { truncated } : {}),
        });
      } catch {
        out.push({ host: f.host, type: f.type, html: "" });
      }
    }

    return out;
  }

  async getPageMeta(sessionId: string): Promise<Record<string, unknown>> {
    const result = await this.evaluate(sessionId, PAGE_META_SCRIPT);

    return (result as Record<string, unknown>) ?? {};
  }

  async probeSelectors(
    sessionId: string,
    selectors: string[],
  ): Promise<
    Array<{
      selector: string;
      count: number;
      samples: Array<Record<string, unknown>>;
      error?: string;
    }>
  > {
    const result = await this.evaluate(
      sessionId,
      probeSelectorsScript(selectors),
    );

    return (
      (result as Array<{
        selector: string;
        count: number;
        samples: Array<Record<string, unknown>>;
        error?: string;
      }>) ?? []
    );
  }

  async getDomSnapshot(
    sessionId: string,
    maxNodes = 500,
  ): Promise<DomSnapshot> {
    const result = await this.evaluate(sessionId, domSnapshotScript(maxNodes));

    return normalizeDomSnapshot(result, maxNodes);
  }

  async getRenderEvidence(sessionId: string): Promise<RenderEvidence | null> {
    const result = await this.evaluate(sessionId, RENDER_EVIDENCE_SCRIPT);

    return (result as RenderEvidence) ?? null;
  }

  async getExtensionRootMeta(
    sessionId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.evaluate(sessionId, EXTENSION_ROOT_META_SCRIPT);

    return (result as Record<string, unknown>) ?? null;
  }
}
