const COOKIE_NAME = "kindle_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_LOGIN_BYTES = 1024;
const encoder = new TextEncoder();

export function matchesSecret(candidate, secret) {
  if (!secret || typeof candidate !== "string") return false;
  const actual = encoder.encode(candidate);
  const expected = encoder.encode(secret);
  return actual.length === expected.length && crypto.subtle.timingSafeEqual(actual, expected);
}

async function sessionMac(value, secret, host) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(`kindle-session:v1:${host}:${value}`));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hasDashboardSession(request, secret) {
  const url = new URL(request.url);
  if (!secret || url.protocol !== "https:") return false;
  const match = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=(\\d{10}\\.[0-9a-f-]{36})\\.([a-f0-9]{64})(?:;|$)`));
  if (!match || Number(match[1].split(".")[0]) <= Math.floor(Date.now() / 1000)) return false;
  return matchesSecret(match[2], await sessionMac(match[1], secret, url.host));
}

async function readPassword(request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded") || !request.body) return null;
  const reader = request.body.getReader();
  const buffer = new Uint8Array(MAX_LOGIN_BYTES);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > buffer.byteLength) {
        await reader.cancel();
        return null;
      }
      buffer.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return new URLSearchParams(new TextDecoder().decode(buffer.subarray(0, length))).get("password");
}

export async function loginDashboard(request, secret) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!secret || request.method !== "POST" || url.protocol !== "https:" || (origin && origin !== url.origin)) {
    return new Response(null, { status: 404 });
  }
  if (!matchesSecret(await readPassword(request), secret)) return dashboardLoginPage(true);

  const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const value = `${expiry}.${crypto.randomUUID()}`;
  const signature = await sessionMac(value, secret, url.host);
  const expires = new Date(expiry * 1000).toUTCString();
  return new Response(null, {
    status: 303,
    headers: {
      location: "/kindle",
      "set-cookie": `${COOKIE_NAME}=${value}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; Expires=${expires}; Secure; HttpOnly; SameSite=Lax`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

export function dashboardLoginPage(invalid = false) {
  return new Response(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kindle Dashboard Sign In</title>
<style>
  body { max-width: 480px; margin: 36px auto; padding: 0 20px; font: 22px Verdana, sans-serif; }
  h1 { font-size: 30px; }
  label, input, button { display: block; margin: 12px 0; font: inherit; }
  input { width: 100%; box-sizing: border-box; padding: 10px; }
  button { padding: 9px 18px; }
</style>
<h1>Kindle Dashboard</h1>
${invalid ? '<p role="alert">Incorrect password. Try again.</p>' : ""}
<form method="post" action="/login">
  <label for="dashboard-password">Dashboard password</label>
  <input id="dashboard-password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
</html>`, {
    status: 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
