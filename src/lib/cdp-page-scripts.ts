// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

export const PAGE_HTML_SCRIPT = `(() => {
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
      })()`;

export const PAGE_META_SCRIPT = `(() => {
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
      })()`;

export const EXTENSION_ROOT_META_SCRIPT = `(() => {
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
      })()`;

export function probeSelectorsScript(selectors: string[]) {
  return `(() => {
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
      })()`;
}

export function domSnapshotScript(maxNodes: number) {
  return `(() => {
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
      })()`;
}
