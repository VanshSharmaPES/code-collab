// JSON responses for the auth routes. Login and logout responses (errors included)
// must never be stored by browsers, proxies or CDNs.
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}
