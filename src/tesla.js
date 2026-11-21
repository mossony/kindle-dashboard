const FLEET_API = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const BATTERY_KEY_PREFIX = "tesla:battery:";
const TOKENS_KEY = "tesla:tokens";
const TIMEOUT_MS = 8000;

export const TESLA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEpkyRawNAuZQ5I4K9Nlj5ncW6eHU5
2AGYhPy0ffYpZGFCPRDiGx22c2g71NnKSCBUVCDymhjbCz4BHwWHf1NXsQ==
-----END PUBLIC KEY-----`;

export function getTeslaBattery(env) {
  return env.TESLA_VIN && env.DASHBOARD_KV
    ? env.DASHBOARD_KV.get(BATTERY_KEY_PREFIX + env.TESLA_VIN, { type: "json" })
    : null;
}

export async function syncTeslaBattery(env) {
  const { DASHBOARD_KV: kv, TESLA_CLIENT_ID: clientId, TESLA_REFRESH_TOKEN: initialToken, TESLA_VIN: vin } = env;
  if (!kv || !clientId || !initialToken || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin || "")) return;

  // A new bootstrap secret replaces the stored token chain after reauthorization.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(initialToken));
  const tokenChain = btoa(String.fromCharCode(...new Uint8Array(digest)));
  let tokens = await kv.get(TOKENS_KEY, { type: "json" });
  if (tokens?.chain !== tokenChain) tokens = null;

  if (!tokens?.accessToken || tokens.expiresAt <= Date.now() + 60_000) {
    const refreshed = await fetchTeslaJson(TOKEN_URL, "token refresh", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens?.refreshToken || initialToken,
      }),
    });
    if (!refreshed.access_token || !refreshed.refresh_token || !Number.isFinite(refreshed.expires_in)) {
      throw new Error("Tesla returned incomplete tokens");
    }
    tokens = {
      chain: tokenChain,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    };
    await kv.put(TOKENS_KEY, JSON.stringify(tokens));
  }

  const data = await fetchTeslaJson(`${FLEET_API}/api/1/vehicles/${vin}/vehicle_data_cached`, "cached data", {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  const charge = data.response?.charge_state;
  const level = charge?.battery_level;
  const timestamp = charge?.timestamp;
  if (!Number.isFinite(level) || level < 0 || level > 100 || timestamp <= 0 ||
      !Number.isFinite(timestamp) || Number.isNaN(new Date(timestamp).getTime())) {
    throw new Error("Tesla cached charge data incomplete");
  }

  const previous = await getTeslaBattery(env);
  if (previous?.timestamp >= timestamp) return;
  const chargingState = typeof charge.charging_state === "string" ? charge.charging_state : null;
  await kv.put(BATTERY_KEY_PREFIX + vin, JSON.stringify({ level, timestamp, chargingState }));
}

async function fetchTeslaJson(url, operation, options) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new Error(`Tesla ${operation} request failed`);
  }
  if (!response.ok) throw new Error(`Tesla ${operation} failed (HTTP ${response.status})`);
  try {
    return await response.json();
  } catch {
    throw new Error(`Tesla ${operation} returned invalid JSON`);
  }
}
