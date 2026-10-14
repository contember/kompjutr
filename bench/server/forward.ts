/** HTTP connection framing belongs to each transport hop, not the forwarded body. */
export function forwardBenchmarkRequest(request: Request, origin: string): Request {
  const url = new URL(request.url);
  const forwarded = new Request(`${origin}${url.pathname}${url.search}`, request);
  const connection = forwarded.headers.get("connection");
  if (connection !== null) {
    for (const name of connection.split(",")) forwarded.headers.delete(name.trim());
  }
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    forwarded.headers.delete(name);
  }
  forwarded.headers.set("accept-encoding", "identity");
  return forwarded;
}
