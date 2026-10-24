// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const LISTING_STORES = ["chrome", "firefox", "edge", "safari"] as const;

export type ListingStore = (typeof LISTING_STORES)[number];

export const LISTING_TEXT_LIMITS = {
  title: 100,
  appStoreName: 30,
  subtitle: 30,
  shortDescription: 250,
  fullDescription: 16_000,
  supportEmail: 200,
  privacyPolicyUrl: 2_000,
  homepageUrl: 2_000,
  license: 100,
  singlePurpose: 1_000,
  reviewerNotes: 8_000,
  releaseNotes: 8_000,
  certificationNotes: 8_000,
  reviewContactName: 100,
  reviewContactEmail: 200,
  reviewContactPhone: 20,
  supportUrl: 2_000,
} as const;

export type ListingTextField = keyof typeof LISTING_TEXT_LIMITS;

export const SEARCH_TERMS_JOINED_LIMITS: Partial<Record<ListingStore, number>> = { safari: 100 };

export const LISTING_LIST_LIMITS = {
  categories: { items: 5, each: 100 },
  searchTerms: { items: 16, each: 100 },
  permissionJustifications: { items: 50, permission: 200, justification: 1_000 },
} as const;

export const LISTING_TEXT_FIELDS = Object.keys(LISTING_TEXT_LIMITS) as ListingTextField[];

export type PermissionJustification = { permission: string; justification: string };

export type ListingText = Partial<Record<ListingTextField, string>> & {
  categories?: string[];
  searchTerms?: string[];
  permissionJustifications?: PermissionJustification[];
};

export type ListingField = keyof ListingText;

export const LISTING_SECTION = "## Listing";

export const PRIVACY_SECTION = "## Privacy and data use";

export const STORE_SECTIONS: Record<ListingStore, string> = {
  chrome: "## Chrome Web Store",
  firefox: "## Firefox Add-ons",
  edge: "## Edge Add-ons",
  safari: "## Safari",
};

export const STORE_OWN_LINES: Partial<Record<ListingStore, ListingField[]>> = {
  safari: ["appStoreName", "reviewContactName", "reviewContactEmail", "reviewContactPhone"],
};

export const SCREENSHOTS_LINE = "Screenshots";

export const STORE_FIELDS: Record<ListingStore, ListingField[]> = {
  chrome: ["title", "shortDescription", "fullDescription", "categories", "supportEmail", "privacyPolicyUrl", "homepageUrl", "singlePurpose", "permissionJustifications"],
  firefox: ["title", "shortDescription", "fullDescription", "categories", "supportEmail", "privacyPolicyUrl", "homepageUrl", "license", "reviewerNotes", "releaseNotes"],
  edge: ["title", "shortDescription", "fullDescription", "categories", "searchTerms", "supportEmail", "privacyPolicyUrl", "homepageUrl", "certificationNotes"],
  safari: ["title", "appStoreName", "subtitle", "shortDescription", "fullDescription", "categories", "searchTerms", "supportEmail", "privacyPolicyUrl", "homepageUrl", "reviewerNotes", "reviewContactName", "reviewContactEmail", "reviewContactPhone", "supportUrl"],
};

export type BulletField = Exclude<ListingField, "permissionJustifications">;

export interface BulletKey {
  field: BulletField;
  line: string;
  pattern: RegExp;
}

export const BULLET_KEYS: BulletKey[] = [
  { field: "title", line: "Name", pattern: /^(name|title)$/ },
  { field: "appStoreName", line: "App Store name", pattern: /^app store name$/ },
  { field: "subtitle", line: "Subtitle", pattern: /^subtitle$/ },
  { field: "shortDescription", line: "Summary", pattern: /^(summary|short description)$/ },
  { field: "fullDescription", line: "Description", pattern: /^(description|long description|full description)$/ },
  { field: "categories", line: "Category", pattern: /^categor(y|ies)$/ },
  { field: "supportEmail", line: "Support email", pattern: /^support email$/ },
  { field: "privacyPolicyUrl", line: "Privacy policy URL", pattern: /^privacy policy( url)?$/ },
  { field: "homepageUrl", line: "Homepage", pattern: /^(homepage|website|homepage url)$/ },
  { field: "supportUrl", line: "Support URL", pattern: /^support (url|page|website)$/ },
  { field: "license", line: "License", pattern: /^license$/ },
  { field: "searchTerms", line: "Search terms", pattern: /^(search terms|keywords|tags)$/ },
  { field: "reviewContactName", line: "Review contact name", pattern: /^(app review contact name|review contact name|contact name)$/ },
  { field: "reviewContactEmail", line: "Review contact email", pattern: /^(app review contact email|review contact email|contact email)$/ },
  { field: "reviewContactPhone", line: "Review contact phone", pattern: /^(app review contact phone|review contact phone|contact phone)$/ },
];

export interface SubsectionKey {
  field: ListingField;
  heading: string;
  prefix: string;
}

export const SUBSECTION_KEYS: SubsectionKey[] = [
  { field: "singlePurpose", heading: "### Single purpose", prefix: "single purpose" },
  { field: "permissionJustifications", heading: "### Permissions justification", prefix: "permission" },
  { field: "reviewerNotes", heading: "### Reviewer notes", prefix: "reviewer notes" },
  { field: "releaseNotes", heading: "### Release notes", prefix: "release notes" },
  { field: "certificationNotes", heading: "### Certification notes", prefix: "certification notes" },
];
