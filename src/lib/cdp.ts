import WebSocket from "ws";

const COMMAND_TIMEOUT_MS = 15_000;

// Lightweight CDP WebSocket client for MCP source inspection.
// Connects to a running Chrome instance, evaluates JS, and captures console output.
export class CDPClient {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private eventListeners = new Set<(msg: Record<string, unknown>) => void>();
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private consoleMessages: Array<{
    level: string;
    text: string;
    source: string;
    timestamp: number;
  }> = [];

  // Connect to a CDP WebSocket URL (e.g., ws://127.0.0.1:9222/devtools/browser/...)
  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => resolve());

      this.ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("error", (err: Error) => {
        this.rejectAllPending(err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        this.rejectAllPending("CDP connection closed");
      });
    });
  }

  disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as Record<string, unknown>;

      if (typeof message.id === "number") {
        const pending = this.pendingRequests.get(message.id);

        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.id);

          if (message.error) {
            pending.reject(new Error(JSON.stringify(message.error)));
          } else {
            pending.resolve(message.result);
          }
        }
        return;
      }

      if (message.method === "Log.entryAdded") {
        const entry = (message.params as Record<string, unknown>)?.entry as
          | Record<string, unknown>
          | undefined;

        if (entry) {
          this.consoleMessages.push({
            level: String(entry.level ?? "info"),
            text: String(entry.text ?? ""),
            source: String(entry.source ?? "other"),
            timestamp: Number(entry.timestamp ?? Date.now()),
          });
        }
      }

      if (message.method === "Runtime.consoleAPICalled") {
        const params = message.params as Record<string, unknown> | undefined;

        if (params) {
          const args = (params.args as Array<Record<string, unknown>>) ?? [];
          const text = args
            .map((a) => String(a.value ?? a.description ?? ""))
            .join(" ");

          this.consoleMessages.push({
            level: String(params.type ?? "log"),
            text,
            source: "console-api",
            timestamp: Number(params.timestamp ?? Date.now()),
          });
        }
      }

      for (const listener of this.eventListeners) {
        listener(message);
      }
    } catch {
      // Malformed message, ignore
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);

      pending.reject(new Error(reason));

      this.pendingRequests.delete(id);
    }
  }

  async sendCommand(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("CDP WebSocket is not connected"));
      }

      const id = ++this.messageId;
      const message: Record<string, unknown> = { id, method, params };

      if (sessionId) message.sessionId = sessionId;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `CDP command timed out (${COMMAND_TIMEOUT_MS}ms): ${method}`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify(message));
    });
  }

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
    await this.sendCommand("Page.navigate", { url }, sessionId);
    // Wait for load event with timeout
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
    )) as { result?: { value?: unknown; exceptionDetails?: unknown } };

    return response.result?.value;
  }

  async getPageHTML(sessionId: string): Promise<string> {
    const result = await this.evaluate(
      sessionId,
      `(() => {
        try {
          const doctype = document.doctype;
          const dt = doctype
            ? '<!DOCTYPE ' + doctype.name
              + (doctype.publicId ? ' PUBLIC "' + doctype.publicId + '"' : '')
              + (doctype.systemId ? ' "' + doctype.systemId + '"' : '')
              + '>'
            : '';
          // Include shadow DOM content from extension roots
          const roots = Array.from(document.querySelectorAll(
            '#extension-root,[data-extension-root]:not([data-extension-root="extension-js-devtools"])'
          ));
          if (roots.length) {
            const clone = document.documentElement.cloneNode(true);
            const clonedRoots = Array.from(clone.querySelectorAll(
              '#extension-root,[data-extension-root]:not([data-extension-root="extension-js-devtools"])'
            ));
            const s = new XMLSerializer();
            for (let i = 0; i < Math.min(roots.length, clonedRoots.length); i++) {
              const sr = roots[i].shadowRoot;
              if (!sr) continue;
              try {
                const shadow = Array.from(sr.childNodes).map(n => {
                  try { return s.serializeToString(n); } catch { return ''; }
                }).join('');
                if (shadow) clonedRoots[i].innerHTML = shadow;
              } catch {}
            }
            return dt + '\\n' + clone.outerHTML;
          }
          return dt + '\\n' + document.documentElement.outerHTML;
        } catch (e) { return ''; }
      })()`,
    );
    return typeof result === "string" ? result : "";
  }

  // Closed-shadow pierce (--deep-dom, Chromium only). JS evaluate() can't see
  // closed shadow roots (.shadowRoot is null), so we go through the CDP DOM
  // domain: DOM.getDocument({pierce:true}) returns the full tree INCLUDING closed
  // shadow roots, then DOM.getOuterHTML extracts each closed root's content.
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
          if (sr && sr.shadowRootType === "closed" && typeof sr.nodeId === "number") {
            found.push({ nodeId: sr.nodeId, host: String(name), type: "closed" });
          }
          walk(sr, name);
        }
      }
      if (Array.isArray(node.children)) for (const c of node.children) walk(c, name);
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
        out.push({ host: f.host, type: f.type, html, ...(truncated ? { truncated } : {}) });
      } catch {
        out.push({ host: f.host, type: f.type, html: "" });
      }
    }
    return out;
  }

  async getPageMeta(sessionId: string): Promise<Record<string, unknown>> {
    const result = await this.evaluate(
      sessionId,
      `(() => {
        try {
          return {
            title: document.title,
            url: location.href,
            readyState: document.readyState,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              devicePixelRatio: window.devicePixelRatio
            },
            frameCount: window.frames.length,
            scriptCount: document.querySelectorAll('script').length,
            styleCount: document.querySelectorAll('style,link[rel="stylesheet"]').length
          };
        } catch { return {}; }
      })()`,
    );
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
    }>
  > {
    const result = await this.evaluate(
      sessionId,
      `(() => {
        const selectors = ${JSON.stringify(selectors)};
        return selectors.map(selector => {
          try {
            const els = Array.from(document.querySelectorAll(selector));
            return {
              selector,
              count: els.length,
              samples: els.slice(0, 3).map(el => ({
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                classes: Array.from(el.classList).join(' ') || undefined,
                role: el.getAttribute('role') || undefined,
                ariaLabel: el.getAttribute('aria-label') || undefined,
                textLength: (el.textContent || '').length,
                textSnippet: (el.textContent || '').trim().slice(0, 80)
              }))
            };
          } catch (e) {
            return { selector, count: 0, samples: [], error: String(e) };
          }
        });
      })()`,
    );
    return (
      (result as Array<{
        selector: string;
        count: number;
        samples: Array<Record<string, unknown>>;
      }>) ?? []
    );
  }

  async getDomSnapshot(
    sessionId: string,
    maxNodes = 500,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.evaluate(
      sessionId,
      `(() => {
        const maxNodes = ${maxNodes};
        const nodes = [];
        const walk = (node, depth) => {
          if (nodes.length >= maxNodes || depth > 20) return;
          if (node.nodeType !== 1) return;
          const el = node;
          nodes.push({
            tag: el.tagName.toLowerCase(),
            depth,
            id: el.id || undefined,
            classes: Array.from(el.classList).slice(0, 5).join(' ') || undefined,
            role: el.getAttribute('role') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            childCount: el.children.length
          });
          for (const child of el.children) {
            walk(child, depth + 1);
          }
        };
        walk(document.documentElement, 0);
        return nodes;
      })()`,
    );
    return (result as Array<Record<string, unknown>>) ?? [];
  }

  async getExtensionRootMeta(
    sessionId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.evaluate(
      sessionId,
      `(() => {
        try {
          const readGeneration = (node) => {
            const raw = node.getAttribute && node.getAttribute('data-extjs-reinject-generation');
            const parsed = Number(raw);
            return Number.isFinite(parsed) ? parsed : undefined;
          };
          const normalize = (node) => ({
            tag: node.tagName ? String(node.tagName).toLowerCase() : 'unknown',
            id: node.id || undefined,
            key: node.getAttribute ? node.getAttribute('data-extjs-reinject-key') || undefined : undefined,
            generation: readGeneration(node),
            status: node.getAttribute ? node.getAttribute('data-extjs-reinject-status') || undefined : undefined
          });
          const roots = Array.from(
            document.querySelectorAll('#extension-root,[data-extension-root]:not([data-extension-root="extension-js-devtools"])')
          ).slice(0, 10).map(normalize);
          const markers = Array.from(
            document.querySelectorAll('[data-extjs-reinject-marker="true"]')
          ).slice(0, 10).map(normalize);
          if (!roots.length && !markers.length) return null;
          const generations = [...roots, ...markers]
            .map(e => e.generation)
            .filter(g => typeof g === 'number');
          return {
            rootCount: roots.length,
            markerCount: markers.length,
            latestGeneration: generations.length ? Math.max(...generations) : 0,
            roots,
            markers
          };
        } catch { return null; }
      })()`,
    );
    return (result as Record<string, unknown>) ?? null;
  }

  getConsoleMessages(): Array<{
    level: string;
    text: string;
    source: string;
    timestamp: number;
  }> {
    return [...this.consoleMessages];
  }

  getConsoleSummary(): Record<string, unknown> {
    const counts: Record<string, number> = {};
    const uniqueByLevel: Record<string, Map<string, number>> = {};

    for (const msg of this.consoleMessages) {
      counts[msg.level] = (counts[msg.level] ?? 0) + 1;

      if (!uniqueByLevel[msg.level]) uniqueByLevel[msg.level] = new Map();

      const key = msg.text.slice(0, 200);

      uniqueByLevel[msg.level].set(
        key,
        (uniqueByLevel[msg.level].get(key) ?? 0) + 1,
      );
    }

    const topMessages: Array<{ level: string; text: string; count: number }> =
      [];

    for (const [level, msgs] of Object.entries(uniqueByLevel)) {
      const sorted = [...msgs.entries()].sort((a, b) => b[1] - a[1]);

      for (const [text, count] of sorted.slice(0, 5)) {
        topMessages.push({ level, text, count });
      }
    }

    return {
      total: this.consoleMessages.length,
      counts,
      topMessages: topMessages.sort((a, b) => b.count - a.count).slice(0, 10),
    };
  }

  private onEvent(handler: (msg: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(handler);

    return () => {
      this.eventListeners.delete(handler);
    };
  }
}
