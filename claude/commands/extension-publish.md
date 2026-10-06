---
description: Get an extension through store review (Chrome Web Store, Firefox AMO, Edge Add-ons, App Store for Safari)
argument-hint: "[chrome|firefox|edge|safari|all]"
---

Take the current extension to store review. The user said: $ARGUMENTS

## Parse arguments

Default to `chrome` and `firefox`. `all` means chrome, firefox, edge and safari. Accept any comma-separated mix.

## Steps

1. **Check the manifest.** Call `extension_manifest_validate` for each target browser. Fix every `buildBlocking` finding before going on; report warnings.

2. **Build store bundles.** Call `extension_build` with `zip: true` for each target. If it refuses on a blocking manifest error or returns compiler errors in `value.errors`, fix and rebuild.

3. **Look for review risks.** Call `extension_analyze` on each build and flag anything a reviewer rejects:
   - `<all_urls>` or broad host permissions without a reason in the listing
   - remote code (`eval`, `new Function`, scripts loaded from a URL)
   - permissions the code never uses
   - Firefox: a missing `browser_specific_settings.gecko.data_collection_permissions` declaration, which AMO now requires for new add-ons and updates
   - a bundle over 10 MB, source maps in the production build, missing 128px icon

4. **Pick the build to submit.** Store review runs from a build on extension.dev, not from local files. Call `extension_release_status` with `include: ["releases"]` to find the sha. If no build of this version is listed, say so: a build comes from a push to the project's repository (the platform builds it), not from `extension_publish`, which only shares a build that already exists.

5. **Rehearse.** Call `extension_submit` with the browsers and `buildSha`, leaving `dryRun` at its default (`true`). Show the per-store credential rows. A store whose credentials are not healthy is fixed in the extension.dev console (the response names the page); drop it from `browsers` or stop.

6. **Submit only on a clear yes.** Ask the user to confirm the exact stores, build and channel. Then call `extension_submit` with `dryRun: false`.
   - It answers `approval-required` with an `approvalUrl`: give the user that link. A workspace owner approves exactly this submission on extension.dev.
   - When they say it is approved, call `extension_submit` again with the same arguments plus the returned `approvalId`. It runs once.

7. **Report.** Call `extension_release_status` for the recorded outcome and review state per store, and give the user each store's listing or dashboard link from the response.

## Rules

- Never submit without the user's confirmation in step 6, and never retry a real submission with a different build or store list under an old `approvalId`; request a new approval.
- Keep the manifest version the project already declares. Extension.js templates use `chromium:manifest_version: 3` and `firefox:manifest_version: 2`, and AMO accepts both; do not migrate a manifest as part of a submission.
- Store credentials are never arguments and never asked for in chat; they live in the extension.dev console.
