import { parseDocument } from "yaml";

const MAX_ALIAS_COUNT = 20;

/** Parses YAML as inert core-schema data and rejects warnings, custom tags, duplicate keys, and alias expansion bombs. */
export function parseSafeYaml(source: string): unknown {
  const document = parseDocument(source, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
    merge: false,
  });
  const issues = [...document.errors, ...document.warnings];
  if (issues.length > 0) throw new Error(issues.map(issue => issue.message).join("; "));
  return document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
}
