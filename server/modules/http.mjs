// HTTP 工具:CORS 头 + JSON 响应 + 请求体读取。完全无状态。
export const allowedOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "tauri://localhost",
  "https://tauri.localhost"
]);

export function corsHeaders(req) {
  const origin = req.headers.origin;
  const allow = origin && allowedOrigins.has(origin) ? origin : "http://127.0.0.1:5173";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "origin"
  };
}

export function sendJson(req, res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(req)
  });
  res.end(JSON.stringify(value));
}

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
