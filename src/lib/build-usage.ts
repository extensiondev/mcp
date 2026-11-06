// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./builds-list-row";

export const DEFAULT_USAGE_GUIDE = `# How to try this extension

This is the default guide shown on your preview and deployment pages. To replace
it with your own notes, edit the usage guide from your project dashboard or
update this file in your repository.

## Install the build in your browser

Download the build artifact from the deployment page and unzip it, then load the
unpacked folder:

### Chrome

1. Open \`chrome://extensions\`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the unzipped folder.

### Edge

1. Open \`edge://extensions\`.
2. Turn on **Developer mode** (left sidebar).
3. Click **Load unpacked** and select the unzipped folder.

### Firefox

1. Open \`about:debugging#/runtime/this-firefox\`.
2. Click **Load Temporary Add-on**.
3. Select the \`manifest.json\` inside the unzipped folder.

> Firefox temporary add-ons are removed when you restart the browser. Reload the
> add-on from \`about:debugging\` after each restart.

## Run it as a native app

If this build also ships a desktop executable, download the \`.exe\`, \`.dmg\`, or
\`.deb\` from the deployment page and run it like any other app. On macOS you may
need to right-click the app and choose **Open** the first time so Gatekeeper
allows it.

## Run locally from source

**Development mode**: start a browser instance with the extension loaded. The
page reloads when you change your code.

\`\`\`bash
npm run dev
\`\`\`

**Preview build**: start a browser instance with production-like settings.

\`\`\`bash
npm run preview
\`\`\`

**Build for stores**: bundle the extension for store submission.

\`\`\`bash
npm run build
\`\`\`

## Learn more

Read the [Extension.js docs](https://extension.js.org) for the full workflow.
`;

const DEFAULT_OPENING = "# How to try this extension This is the default guide shown on your preview and deployment pages.";

function squeezed(markdown: string): string {
  return markdown.replace(/\s+/g, " ").trim();
}

export function isDefaultUsage(markdown: string, updatedAt: string | null): boolean {
  if (updatedAt) return false;

  const flat = squeezed(markdown);

  return flat === squeezed(DEFAULT_USAGE_GUIDE) || flat.startsWith(DEFAULT_OPENING);
}

export function usageValue(json: unknown): Record<string, unknown> {
  const body = isRow(json) ? json : {};
  const markdown = text(body.markdown);
  const updatedAt = text(body.updatedAt) || null;

  if (!markdown) return { recorded: false };
  if (isDefaultUsage(markdown, updatedAt)) return { recorded: true, default: true };

  return { recorded: true, markdown, updatedAt };
}
