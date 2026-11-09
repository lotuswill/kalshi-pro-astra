// Vercel Edge Middleware — optional site-wide Basic auth gate.
// Set the SITE_PASSWORD environment variable in the Vercel project to
// enable it (username: kalshi). Leave it unset to serve the app openly.
export const config = { matcher: "/(.*)" };

export default function middleware(req) {
  const pass = process.env.SITE_PASSWORD;
  if (!pass) return; // gate not configured — pass through

  const auth = req.headers.get("authorization") || "";
  const expected = "Basic " + btoa(`kalshi:${pass}`);
  if (auth === expected) return;

  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="kalshi-pro", charset="UTF-8"' },
  });
}
