export async function handleApi(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return Response.json({ ok: true, site: "__SITE_ID__" });
  }

  return Response.json({ ok: false, error: "not_found" }, { status: 404 });
}
