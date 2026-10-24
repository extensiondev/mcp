# STORE.md fields

Generated from the parser's own declarations in `src/lib/store-md-declarations.ts`, the lists `src/lib/store-md-listing.ts` matches against (`STORE_FIELDS`, `BULLET_KEYS`, `SUBSECTION_KEYS`, the section names and the limits); do not edit by hand. Regenerate with `pnpm docs:tools`. A test fails when this file and the parser disagree. These are the lines `extension_submit` `preflight` and `sync-listing` read from a project's STORE.md, per store; the line column is the label the platform's requirements name in `satisfiedBy: "store-md: <line>"`.

## How a line is resolved

- A `##` heading is matched by prefix, case aside: `## Listing`, `## Privacy and data use`, and a store section by the store its heading names (chrome or chrome-web-store, firefox or amo, edge, safari or app store), so `## Firefox Add-ons`, `## firefox-amo` and `## AMO` are one section; the first section for a store wins. A `###` heading inside a store section is matched by prefix the same way.
- A line is a `- Key: value` bullet; the key is case-insensitive, and the value may continue on the indented lines below it. A value that starts with TODO counts as absent. HTML comments are skipped.
- The section column is the line's home. A line is also read from the sections in the also-read-from column, and the home wins when both carry one; a store section's own `- Key:` lines (those above its first `###`) are read with the same keys as `## Listing` and win for that store alone.
- `- Category:` is read from `## Listing` only: one name applies to every store, and a line of several names reads a trailing parenthetical naming stores as the stores that name is for. A trailing parenthetical on the license, support email and homepage lines is a remark and kept out of the value.
- A line that is present but over its limit or not in the shape the reader takes is left out of the sync and named, with its reason, in `skipped`; the preflight's `storeMd` block names the same line with the shape it wants.

## chrome (Chrome Web Store, `## Chrome Web Store`)

10 fields.

| line | section | also read from | field | limit |
| --- | --- | --- | --- | --- |
| `- Name:` | `## Listing` | `## Chrome Web Store` | `title` | up to 100 characters |
| `- Summary:` | `## Listing` | `## Chrome Web Store` | `shortDescription` | up to 250 characters |
| `- Description:` | `## Listing` | `## Chrome Web Store` | `fullDescription` | paragraphs indented below the bullet, up to 16,000 characters |
| `- Category:` | `## Listing` |  | `categories` | up to 5 names of 100 characters each; one name for every store, or `<name> (Chrome), <name> (Firefox)` per store |
| `- Support email:` | `## Listing` | `## Chrome Web Store` | `supportEmail` | an email address, up to 200 characters |
| `- Privacy policy URL:` | `## Privacy and data use` | `## Listing`, `## Chrome Web Store` | `privacyPolicyUrl` | an http or https URL, up to 2,000 characters |
| `- Homepage:` | `## Listing` | `## Chrome Web Store` | `homepageUrl` | an http or https URL, up to 2,000 characters |
| `### Single purpose` | `## Chrome Web Store` |  | `singlePurpose` | up to 1,000 characters |
| `### Permissions justification` | `## Chrome Web Store` |  | `permissionJustifications` | one `- <permission>: <reason>` bullet each, up to 50; a permission up to 200 characters, a reason up to 1,000 |
| `- Screenshots:` | `## Listing` |  | `screenshots` | up to 5 PNG files inside the project, one path per line below the bullet |

## firefox (Firefox Add-ons, `## Firefox Add-ons`)

11 fields.

| line | section | also read from | field | limit |
| --- | --- | --- | --- | --- |
| `- Name:` | `## Listing` | `## Firefox Add-ons` | `title` | up to 100 characters |
| `- Summary:` | `## Listing` | `## Firefox Add-ons` | `shortDescription` | up to 250 characters |
| `- Description:` | `## Listing` | `## Firefox Add-ons` | `fullDescription` | paragraphs indented below the bullet, up to 16,000 characters |
| `- Category:` | `## Listing` |  | `categories` | up to 5 names of 100 characters each; one name for every store, or `<name> (Chrome), <name> (Firefox)` per store |
| `- Support email:` | `## Listing` | `## Firefox Add-ons` | `supportEmail` | an email address, up to 200 characters |
| `- Privacy policy URL:` | `## Privacy and data use` | `## Listing`, `## Firefox Add-ons` | `privacyPolicyUrl` | an http or https URL, up to 2,000 characters |
| `- Homepage:` | `## Listing` | `## Firefox Add-ons` | `homepageUrl` | an http or https URL, up to 2,000 characters |
| `- License:` | `## Listing` | `## Firefox Add-ons` | `license` | up to 100 characters |
| `### Reviewer notes` | `## Firefox Add-ons` |  | `reviewerNotes` | up to 8,000 characters |
| `### Release notes` | `## Firefox Add-ons` |  | `releaseNotes` | up to 8,000 characters |
| `- Screenshots:` | `## Listing` |  | `screenshots` | up to 5 PNG files inside the project, one path per line below the bullet |

## edge (Edge Add-ons, `## Edge Add-ons`)

10 fields.

| line | section | also read from | field | limit |
| --- | --- | --- | --- | --- |
| `- Name:` | `## Listing` | `## Edge Add-ons` | `title` | up to 100 characters |
| `- Summary:` | `## Listing` | `## Edge Add-ons` | `shortDescription` | up to 250 characters |
| `- Description:` | `## Listing` | `## Edge Add-ons` | `fullDescription` | paragraphs indented below the bullet, up to 16,000 characters |
| `- Category:` | `## Listing` |  | `categories` | up to 5 names of 100 characters each; one name for every store, or `<name> (Chrome), <name> (Firefox)` per store |
| `- Search terms:` | `## Listing` | `## Edge Add-ons` | `searchTerms` | a comma list, up to 16 terms of 100 characters each |
| `- Support email:` | `## Listing` | `## Edge Add-ons` | `supportEmail` | an email address, up to 200 characters |
| `- Privacy policy URL:` | `## Privacy and data use` | `## Listing`, `## Edge Add-ons` | `privacyPolicyUrl` | an http or https URL, up to 2,000 characters |
| `- Homepage:` | `## Listing` | `## Edge Add-ons` | `homepageUrl` | an http or https URL, up to 2,000 characters |
| `### Certification notes` | `## Edge Add-ons` |  | `certificationNotes` | up to 8,000 characters |
| `- Screenshots:` | `## Listing` |  | `screenshots` | up to 5 PNG files inside the project, one path per line below the bullet |

## safari (App Store (Safari), `## Safari`)

14 fields.

| line | section | also read from | field | limit |
| --- | --- | --- | --- | --- |
| `- Name:` | `## Listing` | `## Safari` | `title` | up to 100 characters |
| `- Subtitle:` | `## Listing` | `## Safari` | `subtitle` | up to 30 characters |
| `- Summary:` | `## Listing` | `## Safari` | `shortDescription` | up to 250 characters |
| `- Description:` | `## Listing` | `## Safari` | `fullDescription` | paragraphs indented below the bullet, up to 16,000 characters |
| `- Category:` | `## Listing` |  | `categories` | up to 5 names of 100 characters each; one name for every store, or `<name> (Chrome), <name> (Firefox)` per store |
| `- Search terms:` | `## Listing` | `## Safari` | `searchTerms` | a comma list, up to 16 terms of 100 characters each, 100 characters joined by commas |
| `- Support email:` | `## Listing` | `## Safari` | `supportEmail` | an email address, up to 200 characters |
| `- Privacy policy URL:` | `## Privacy and data use` | `## Listing`, `## Safari` | `privacyPolicyUrl` | an http or https URL, up to 2,000 characters |
| `- Homepage:` | `## Listing` | `## Safari` | `homepageUrl` | an http or https URL, up to 2,000 characters |
| `### Reviewer notes` | `## Safari` |  | `reviewerNotes` | up to 8,000 characters |
| `- Review contact name:` | `## Safari` | `## Listing` | `reviewContactName` | up to 100 characters |
| `- Review contact email:` | `## Safari` | `## Listing` | `reviewContactEmail` | an email address, up to 200 characters |
| `- Review contact phone:` | `## Safari` | `## Listing` | `reviewContactPhone` | an E.164 phone number, up to 20 characters |
| `- Screenshots:` | `## Listing` |  | `screenshots` | up to 5 PNG files inside the project, one path per line below the bullet |
