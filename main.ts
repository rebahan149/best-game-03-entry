// Loomlight — zero-dependency static file server (Node >= 22, type-stripped TS).
// Serves the game in this directory: index.html at /, assets alongside.
// Usage: node main.ts            (PORT env overrides the default 8080)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT: string = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT: number = Number(process.env.PORT ?? 8080);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method: string = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
    res.end("Method Not Allowed\n");
    return;
  }

  let urlPath: string;
  try {
    urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Request\n");
    return;
  }

  if (urlPath === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, game: "loomlight" }) + "\n");
    return;
  }

  if (urlPath === "/") urlPath = "/index.html";

  // Path traversal guard: the resolved file must stay inside ROOT.
  const filePath: string = resolve(join(ROOT, normalize(urlPath)));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden\n");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const body: Buffer = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "content-length": body.byteLength,
      "cache-control": "no-cache",
    });
    res.end(method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found\n");
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error\n");
  });
});

server.listen(PORT, () => {
  console.log(`Loomlight server listening on http://localhost:${PORT}/ (serving ${ROOT})`);
});
