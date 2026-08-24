export function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export function preflight(): Response {
  return withCors(new Response(null, { status: 204 }));
}

export function json(data: unknown, status = 200): Response {
  return withCors(
    Response.json(data, {
      status,
      headers: { "Cache-Control": "no-store" },
    }),
  );
}

export function text(body: string, type = "text/plain; charset=utf-8", status = 200): Response {
  return withCors(
    new Response(body, {
      status,
      headers: { "Content-Type": type, "Cache-Control": "no-store" },
    }),
  );
}
