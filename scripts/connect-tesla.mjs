import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const host = "tesla.mossony.online";
const port = 53682;
const callbackPath = "/tesla/callback";
const redirectUri = `http://localhost:${port}${callbackPath}`;
const audience = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const tokenUrl = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const { TESLA_CLIENT_ID: clientId, TESLA_CLIENT_SECRET: clientSecret, TESLA_VIN: vin, ...childEnv } = process.env;
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

async function teslaRequest(url, options, label) {
  const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status})`);
  return response;
}

async function main() {
  if (!clientId || !clientSecret || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin || "")) {
    throw new Error("Set TESLA_CLIENT_ID, TESLA_CLIENT_SECRET, and the 17-character TESLA_VIN in the local terminal.");
  }
  const runWrangler = (args, input) => spawnSync(process.execPath, [wrangler, ...args], {
    env: childEnv,
    input,
    stdio: ["pipe", "ignore", "ignore"],
  });
  if (runWrangler(["whoami"]).status !== 0) throw new Error("Sign in to Cloudflare with Wrangler before starting Tesla authorization.");

  const token = async (grant, fields) => (await teslaRequest(tokenUrl, {
    method: "POST",
    body: new URLSearchParams({ grant_type: grant, client_id: clientId, client_secret: clientSecret, audience, ...fields }),
  }, "Tesla token exchange")).json();
  const partner = await token("client_credentials", { scope: "vehicle_device_data" });
  await teslaRequest(`${audience}/api/1/partner_accounts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${partner.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ domain: host }),
  }, "Tesla partner registration");

  const state = randomUUID();
  const authorize = new URL("https://auth.tesla.com/oauth2/v3/authorize");
  authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid offline_access vehicle_device_data", state });
  await new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      const callback = new URL(`http://localhost:${port}${request.url}`);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      if (request.method !== "GET" || callback.pathname !== callbackPath || callback.searchParams.get("state") !== state) {
        response.writeHead(400).end("Invalid Tesla authorization response.");
        return;
      }
      clearTimeout(timeout);
      server.close();
      try {
        const code = callback.searchParams.get("code");
        if (!code) throw new Error("Tesla authorization did not return a code.");
        const user = await token("authorization_code", { code, redirect_uri: redirectUri });
        if (!user.refresh_token) throw new Error("Tesla did not return a refresh token.");
        const secrets = JSON.stringify({ TESLA_CLIENT_ID: clientId, TESLA_VIN: vin, TESLA_REFRESH_TOKEN: user.refresh_token });
        if (runWrangler(["secret", "bulk"], secrets).status !== 0) throw new Error("Cloudflare could not save the Tesla secrets.");
        response.end("Tesla is connected. You can close this tab.");
        resolve();
      } catch (error) {
        response.writeHead(502).end("Tesla setup failed. See the local terminal.");
        reject(error);
      }
    });
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Tesla authorization timed out."));
    }, 10 * 60_000);
    server.once("error", error => { clearTimeout(timeout); reject(error); });
    server.listen(port, "127.0.0.1", () => console.log(`Open this Tesla authorization link in Chrome:\n${authorize}`));
  });
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
