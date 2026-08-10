import { timingSafeEqual } from "node:crypto";

function equals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function unauthorized(): Response {
  return Response.json(
    {
      type: "https://abcm.dev/problems/AUTHENTICATION_REQUIRED",
      title: "AUTHENTICATION_REQUIRED",
      status: 401,
      detail: "A valid Bearer token is required.",
      code: "AUTHENTICATION_REQUIRED",
    },
    {
      status: 401,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
        "www-authenticate": "Bearer",
      },
    },
  );
}

export function requireStaticBearerToken(
  handler: (request: Request) => Promise<Response>,
  token: string,
): (request: Request) => Promise<Response> {
  if (token.length < 16) throw new Error("ABCM bearer token must contain at least 16 characters.");
  return async request => {
    if (new URL(request.url).pathname === "/health") return handler(request);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return unauthorized();
    const candidate = authorization.slice("Bearer ".length);
    if (!equals(candidate, token)) return unauthorized();
    return handler(request);
  };
}
