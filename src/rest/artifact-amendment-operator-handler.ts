import { artifactAmendmentApprovalIssueInputSchema } from "../artifacts/amendment-schema.js";
import type { ArtifactAmendmentService } from "../artifacts/amendment-service.js";
import { AbcmError } from "../core/errors.js";

export function createArtifactAmendmentOperatorHandler(service: ArtifactAmendmentService) {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/operator/artifact-amendment-approvals") {
        throw new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found.");
      }
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > 65_536) throw new AbcmError("REQUEST_INVALID", "Approval request is too large.");
      let value: unknown;
      try { value = await request.json(); }
      catch { throw new AbcmError("REQUEST_INVALID", "JSON request body is invalid."); }
      const parsed = artifactAmendmentApprovalIssueInputSchema.safeParse(value);
      if (!parsed.success) throw new AbcmError("REQUEST_INVALID", "Approval request body is invalid.", { cause: parsed.error.message });
      return Response.json(await service.issueApproval(parsed.data, request.signal), { status: 201 });
    } catch (error) {
      const mapped = error instanceof AbcmError ? error : new AbcmError("REQUEST_INVALID", "Approval request failed.");
      return Response.json({
        type: `https://abcm.dev/problems/${mapped.code}`,
        title: mapped.code,
        status: mapped.status,
        detail: mapped.message,
        code: mapped.code,
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
      }, { status: mapped.status, headers: { "content-type": "application/problem+json" } });
    }
  };
}
