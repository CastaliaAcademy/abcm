import type { ArtifactLineageRecord, DocumentRecord, MapDiagnostic } from "./types.js";

export interface ArtifactLineageResolution {
  documents: DocumentRecord[];
  lineages: ArtifactLineageRecord[];
}

export function resolveArtifactLineages(
  input: readonly DocumentRecord[],
  diagnostics: MapDiagnostic[],
): ArtifactLineageResolution {
  const documents = input.map(document => ({ ...document }));
  const artifacts = documents.filter(document => document.artifactId !== undefined);
  const byId = new Map(artifacts.map(document => [document.artifactId!, document]));
  const grouped = new Map<string, DocumentRecord[]>();
  for (const artifact of artifacts) {
    const lineageId = artifact.lineageId ?? artifact.artifactId!;
    artifact.lineageId = lineageId;
    const current = grouped.get(lineageId) ?? [];
    current.push(artifact);
    grouped.set(lineageId, current);
  }

  const lineages: ArtifactLineageRecord[] = [];
  for (const [lineageId, entries] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const entryIds = new Set(entries.map(entry => entry.artifactId!));
    for (const entry of entries) {
      if (entry.supersedes === undefined) continue;
      const previous = byId.get(entry.supersedes);
      if (previous === undefined || previous.lineageId !== lineageId) {
        diagnostics.push({
          code: "ARTIFACT_LINEAGE_INVALID",
          severity: "scope_error",
          path: entry.relativePath,
          scopeId: entry.scopeId,
          message: `Artifact '${entry.artifactId}' supersedes a missing artifact or an artifact from another lineage.`,
        });
      }
    }
    const accepted = entries.filter(entry => entry.lifecycle.toLocaleLowerCase("en-US") === "accepted");
    const supersededIds = new Set(accepted.map(entry => entry.supersedes).filter((value): value is string => value !== undefined));
    const heads = accepted.filter(entry => !supersededIds.has(entry.artifactId!));
    if (heads.length > 1) {
      diagnostics.push({
        code: "ARTIFACT_LINEAGE_CONFLICT",
        severity: "scope_error",
        path: heads[0]!.relativePath,
        scopeId: heads[0]!.scopeId,
        message: `Artifact lineage '${lineageId}' has multiple accepted heads.`,
      });
    }
    const head = heads.length === 1 ? heads[0] : undefined;
    if (head !== undefined) {
      let previous = head.supersedes;
      const seen = new Set<string>();
      while (previous !== undefined && entryIds.has(previous) && !seen.has(previous)) {
        seen.add(previous);
        const ancestor = byId.get(previous)!;
        if (ancestor.lifecycle.toLocaleLowerCase("en-US") === "accepted") ancestor.lifecycle = "superseded";
        previous = ancestor.supersedes;
      }
    }
    lineages.push({
      lineageId,
      artifactIds: entries.map(entry => entry.artifactId!).sort((left, right) => left.localeCompare(right)),
      ...(head === undefined ? {} : { headArtifactId: head.artifactId }),
      status: heads.length <= 1 ? "valid" : "ambiguous",
    });
  }
  return { documents, lineages };
}
