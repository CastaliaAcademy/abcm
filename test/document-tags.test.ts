import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_TAG_MAX_COUNT,
  DOCUMENT_TAG_MAX_LENGTH,
  DOCUMENT_TAGS_MAX_UTF8_BYTES,
  validateDocumentTags,
} from "../src/scope-map/document-tags.js";

describe("document tag limits", () => {
  test("uses one deterministic length, count and aggregate-size contract", () => {
    expect(validateDocumentTags(["#Alpha", "alpha"])).toEqual({ tags: ["alpha"] });
    expect(validateDocumentTags(["x".repeat(DOCUMENT_TAG_MAX_LENGTH + 1)]).error).toContain("exceeds");
    expect(validateDocumentTags(Array.from({ length: DOCUMENT_TAG_MAX_COUNT + 1 }, (_, index) => `tag-${index}`)).error).toContain("at most");
    const aggregate = Array.from(
      { length: DOCUMENT_TAG_MAX_COUNT },
      (_, index) => `${index.toString().padStart(2, "0")}-${"я".repeat(Math.ceil(DOCUMENT_TAGS_MAX_UTF8_BYTES / DOCUMENT_TAG_MAX_COUNT))}`,
    );
    expect(aggregate.every(tag => tag.length <= DOCUMENT_TAG_MAX_LENGTH)).toBe(true);
    expect(validateDocumentTags(aggregate).error).toContain("UTF-8 bytes");
  });
});
