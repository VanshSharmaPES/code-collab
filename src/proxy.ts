import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, readSession } from "@/lib/session-token";

// Visitors without a valid session get a real redirect before anything is rendered. A redirect() thrown inside a
// page that streams behind loading.tsx can only be sent as a <meta> tag in an HTTP 200 response. This does not
// replace the check in each page and server action. Keep the target in step with UNAUTHENTICATED_REDIRECT.
export async function proxy(request: NextRequest) {
  const session = await readSession(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (session === null) return NextResponse.redirect(new URL("/", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/issues", "/issues/:path*", "/pull-requests", "/pull-requests/:path*", "/users", "/users/:path*"] };
