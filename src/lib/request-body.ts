// Request-body helpers for the auth routes; no framework imports so they are easy to test.

// Accepts "application/json" with optional parameters (e.g. "; charset=utf-8"),
// and nothing else: "application/jsonp" or "text/plain" do not match.
export function isJsonContentType(header: string | null): boolean {
  if (!header) return false;
  return header.split(";")[0].trim().toLowerCase() === "application/json";
}

export type BodyResult = { ok: true; text: string } | { ok: false; reason: "too-large" };

// Reads the body as UTF-8 text, stopping as soon as more than `maxBytes` bytes have
// arrived. Content-Length is only an early hint: it may be absent or wrong, so the
// limit is always enforced on the bytes actually read.
export async function readLimitedBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { ok: false, reason: "too-large" };
  }
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
