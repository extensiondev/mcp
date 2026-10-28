import crypto from "node:crypto";

import { listingDigest } from "../../lib/store-listing-media";

export function digestOf(body: {
  listing: Record<string, unknown>;
  media?: {
    icons?: Array<{ dataBase64: string }>;
    screenshots?: Array<{ dataBase64: string }>;
  };
}): string {
  const image = (item: { dataBase64: string }) => {
    const bytes = Buffer.from(item.dataBase64, "base64");

    return {
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      bytes,
      source: "",
    };
  };

  return listingDigest({
    listing: body.listing,
    ...(body.media?.icons ? { icons: body.media.icons.map(image) } : {}),
    ...(body.media?.screenshots ? { screenshots: body.media.screenshots.map(image) } : {}),
  } as Parameters<typeof listingDigest>[0]);
}
