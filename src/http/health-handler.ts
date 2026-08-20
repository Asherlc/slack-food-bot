const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export function handleHealthRequest(request: Request): Response {
  if (request.method === "GET" && new URL(request.url).pathname === "/health") {
    return Response.json({ status: "ok" }, { headers: jsonHeaders });
  }

  return Response.json({ error: "Not found" }, { status: 404, headers: jsonHeaders });
}
