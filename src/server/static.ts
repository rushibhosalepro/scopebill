import { resolve, sep } from "node:path";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function createStaticHandler(directory: string) {
  const root = resolve(directory);

  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    const { pathname } = new URL(request.url);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const target = resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response("Not found", { status: 404 });
    }

    const file = Bun.file(target);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });

    const isPage = target.endsWith(".html");
    return new Response(file, {
      headers: {
        "Content-Security-Policy": CONTENT_SECURITY_POLICY,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": isPage ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  };
}
