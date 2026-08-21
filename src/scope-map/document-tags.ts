export const DOCUMENT_TAG_MAX_LENGTH = 256;
export const DOCUMENT_TAG_MAX_COUNT = 64;
export const DOCUMENT_TAGS_MAX_UTF8_BYTES = 4096;

export interface DocumentTagValidation {
  tags: string[];
  error?: string;
}

export function normalizeDocumentTag(value: string): string {
  return value.normalize("NFKC").trim().replace(/^#+/, "").toLocaleLowerCase("en-US");
}

/** Validates the canonical tag set used by both ScopeMap and public LinkPackage schemas. */
export function validateDocumentTags(values: readonly string[]): DocumentTagValidation {
  const tags = [...new Set(values.map(normalizeDocumentTag).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const oversized = tags.find(tag => tag.length > DOCUMENT_TAG_MAX_LENGTH);
  if (oversized !== undefined) {
    return { tags: [], error: `A normalized document tag exceeds ${DOCUMENT_TAG_MAX_LENGTH} characters.` };
  }
  if (tags.length > DOCUMENT_TAG_MAX_COUNT) {
    return { tags: [], error: `A document may declare at most ${DOCUMENT_TAG_MAX_COUNT} unique tags.` };
  }
  const utf8Bytes = new TextEncoder().encode(tags.join("\n")).byteLength;
  if (utf8Bytes > DOCUMENT_TAGS_MAX_UTF8_BYTES) {
    return { tags: [], error: `Normalized document tags exceed ${DOCUMENT_TAGS_MAX_UTF8_BYTES} UTF-8 bytes in total.` };
  }
  return { tags };
}
