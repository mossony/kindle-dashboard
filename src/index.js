const REFRESH_SECONDS = 5 * 60;

const DEFAULT_LOCATION = {
  city: "Toronto",
  latitude: 43.6532,
  longitude: -79.3832,
  timezone: "America/Toronto",
};

const INDOOR_KV_KEY = "home:indoor";
let indoorSnapshot = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");

    if (!env.DASHBOARD_SECRET || key !== env.DASHBOARD_SECRET) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }

    if (url.pathname === "/api/home") {
      return handleHomeApi(request, env);
    }

    if (url.pathname !== "/" && url.pathname !== "/kindle") {
      return new Response("Not Found", { status: 404 });
    }

    const location = getLocation(request, env);
    const [nvdaResult, btcResult, weatherResult] = await Promise.allSettled([
      getNvdaQuote(),
      getBtcUsdtQuote(),
      getWeather(location),
    ]);

    const dashboard = {
      date: formatDate(new Date(), location.timezone),
      location,
      nvda: valueOrUnavailable(nvdaResult),
      btc: valueOrUnavailable(btcResult),
      indoor: await getIndoorSnapshot(env),
      weather: valueOrUnavailable(weatherResult),
    };

    return new Response(renderDashboard(dashboard), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  },
};

async function handleHomeApi(request, env) {
  if (request.method === "GET") {
    return jsonResponse({ indoor: await getIndoorSnapshot(env) });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (error) {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const temperature = Number(payload.indoorTemperature ?? payload.temperature);
  if (!Number.isFinite(temperature)) {
    return jsonResponse({ error: "indoorTemperature must be a number" }, 400);
  }

  const humidity = Number(payload.indoorHumidity ?? payload.humidity);
  indoorSnapshot = {
    temperature,
    humidity: Number.isFinite(humidity) ? humidity : null,
    source: payload.source ? String(payload.source) : "HomePod",
    updatedAt: new Date().toISOString(),
  };

  if (env.DASHBOARD_KV) {
    await env.DASHBOARD_KV.put(INDOOR_KV_KEY, JSON.stringify(indoorSnapshot));
  }

  return jsonResponse({ ok: true, indoor: indoorSnapshot });
}

async function getIndoorSnapshot(env) {
  if (!env.DASHBOARD_KV) {
    return indoorSnapshot;
  }

  const stored = await env.DASHBOARD_KV.get(INDOOR_KV_KEY, { type: "json" });
  if (stored) {
    indoorSnapshot = stored;
    return stored;
  }

  return indoorSnapshot;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function getLocation(request, env) {
  const latitude = Number(env.DEFAULT_LATITUDE || request.cf?.latitude);
  const longitude = Number(env.DEFAULT_LONGITUDE || request.cf?.longitude);

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return {
      city: env.DEFAULT_CITY || request.cf?.city || DEFAULT_LOCATION.city,
      latitude,
      longitude,
      timezone: env.DEFAULT_TIMEZONE || request.cf?.timezone || DEFAULT_LOCATION.timezone,
    };
  }

  return {
    city: env.DEFAULT_CITY || DEFAULT_LOCATION.city,
    latitude: DEFAULT_LOCATION.latitude,
    longitude: DEFAULT_LOCATION.longitude,
    timezone: env.DEFAULT_TIMEZONE || DEFAULT_LOCATION.timezone,
  };
}

async function getNvdaQuote() {
  const json = await fetchJson(
    "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1m&range=1d",
  );
  const meta = json.chart?.result?.[0]?.meta;

  if (!meta?.regularMarketPrice) {
    throw new Error("NVDA quote unavailable");
  }

  return {
    symbol: "NVDA",
    price: meta.regularMarketPrice,
    currency: meta.currency || "USD",
    changePercent: getPercentChange(meta.regularMarketPrice, meta.previousClose),
    marketState: meta.marketState || "UNKNOWN",
  };
}

async function getBtcUsdtQuote() {
  try {
    const json = await fetchJson("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT");
    return {
      symbol: "BTCUSDT",
      price: Number(json.lastPrice),
      currency: "USDT",
      changePercent: Number(json.priceChangePercent),
    };
  } catch (error) {
    const json = await fetchJson("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    return {
      symbol: "BTCUSDT",
      price: Number(json.data?.amount),
      currency: "USDT",
      changePercent: null,
    };
  }
}

async function getWeather(location) {
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: [
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "weather_code",
      "wind_speed_10m",
    ].join(","),
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    temperature_unit: "celsius",
    wind_speed_unit: "kmh",
    timezone: "auto",
    forecast_days: "1",
  });

  const json = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`);
  const current = json.current;
  const daily = json.daily;

  if (!current) {
    throw new Error("Weather unavailable");
  }

  return {
    city: location.city,
    condition: weatherCodeToText(current.weather_code),
    temperature: current.temperature_2m,
    feelsLike: current.apparent_temperature,
    high: daily?.temperature_2m_max?.[0],
    low: daily?.temperature_2m_min?.[0],
    humidity: current.relative_humidity_2m,
    wind: current.wind_speed_10m,
    rainChance: daily?.precipitation_probability_max?.[0],
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "kindle-dashboard-worker/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

function valueOrUnavailable(result) {
  if (result.status === "fulfilled") {
    return result.value;
  }

  return null;
}

function getPercentChange(price, previousClose) {
  if (!price || !previousClose) {
    return null;
  }

  return ((price - previousClose) / previousClose) * 100;
}

function formatDate(date, timezone) {
  return date.toLocaleDateString("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatMoney(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return "--";
  }

  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }

  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatTemp(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }

  return `${Math.round(value)}&deg;C`;
}

function weatherCodeToText(code) {
  const weatherCodes = {
    0: "Clear",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Cloudy",
    45: "Fog",
    48: "Fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Heavy drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    80: "Rain showers",
    81: "Rain showers",
    82: "Heavy showers",
    95: "Thunderstorm",
    96: "Thunderstorm",
    99: "Thunderstorm",
  };

  return weatherCodes[code] || "Weather";
}

function renderDashboard({ date, location, nvda, btc, indoor, weather }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="${REFRESH_SECONDS}">
  <title>Kindle Dashboard</title>
  <style>
    html, body {
      width: 100%;
      min-height: 100%;
      margin: 0;
      padding: 0;
      background: #fff;
      color: #000;
      font-family: Verdana, "Trebuchet MS", Arial, sans-serif;
    }

    body {
      box-sizing: border-box;
      padding: 26px 32px;
    }

    .shell {
      max-width: 760px;
      margin: 0 auto;
    }

    .masthead {
      border: 5px solid #000;
      padding: 18px 20px;
      margin-bottom: 18px;
    }

    .date {
      font-size: 34px;
      line-height: 1;
      font-weight: 700;
      letter-spacing: 1px;
    }

    .card {
      border: 4px solid #000;
      margin: 16px 0;
      padding: 18px 20px;
      page-break-inside: avoid;
    }

    .cardLabel {
      font-size: 22px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 2px;
      border-bottom: 2px solid #000;
      padding-bottom: 8px;
      margin-bottom: 12px;
    }

    .primary {
      font-size: 54px;
      line-height: 1.05;
      font-weight: 700;
      white-space: nowrap;
    }

    .marketRow {
      display: table;
      width: 100%;
      table-layout: fixed;
    }

    .marketPrice,
    .marketMove {
      display: table-cell;
      vertical-align: middle;
    }

    .marketMove {
      width: 34%;
      text-align: right;
      font-weight: 700;
    }

    .arrow {
      display: block;
      font-size: 52px;
      line-height: 0.9;
    }

    .movePercent {
      display: block;
      margin-top: 8px;
      font-size: 25px;
      line-height: 1;
    }

    .secondary {
      margin-top: 10px;
      font-size: 27px;
      line-height: 1.2;
    }

    .split {
      display: table;
      width: 100%;
      table-layout: fixed;
      margin-top: 12px;
    }

    .cell {
      display: table-cell;
      width: 33.33%;
      padding-right: 12px;
      font-size: 23px;
      line-height: 1.2;
    }

    .cell strong {
      display: block;
      font-size: 18px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    @media (max-width: 520px) {
      body {
        padding: 18px;
      }

      .date {
        font-size: 30px;
      }

      .primary {
        font-size: 44px;
      }

      .secondary {
        font-size: 24px;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="masthead">
      <div class="date">${escapeHtml(date)}</div>
    </section>

    ${renderMarketCard("NVDA", nvda)}
    ${renderMarketCard("BTCUSDT", btc)}
    ${renderIndoorCard(indoor)}
    ${renderWeatherCard(weather)}

  </main>

  <script>
    setTimeout(function () {
      location.reload();
    }, ${REFRESH_SECONDS * 1000});
  </script>
</body>
</html>`;
}

function renderMarketCard(label, quote) {
  if (!quote) {
    return renderUnavailableCard(label);
  }

  const movement = getMovement(quote.changePercent);

  return `<section class="card">
      <div class="cardLabel">${label}</div>
      <div class="marketRow">
        <div class="marketPrice">
          <div class="primary">${formatMoney(quote.price, label === "BTCUSDT" ? 0 : 2)}</div>
          <div class="secondary">${escapeHtml(quote.currency)}</div>
        </div>
        <div class="marketMove">
          <span class="arrow">${movement.arrow}</span>
          <span class="movePercent">${formatPercent(quote.changePercent)}</span>
        </div>
      </div>
    </section>`;
}

function getMovement(value) {
  if (!Number.isFinite(value)) {
    return { arrow: "-" };
  }

  if (value > 0) {
    return { arrow: "&#9650;" };
  }

  if (value < 0) {
    return { arrow: "&#9660;" };
  }

  return { arrow: "-" };
}

function renderIndoorCard(indoor) {
  if (!indoor) {
    return `<section class="card">
      <div class="cardLabel">Indoor</div>
      <div class="primary">--</div>
      <div class="secondary">Waiting for HomePod</div>
    </section>`;
  }

  const updatedAt = new Date(indoor.updatedAt);
  const updatedLabel = Number.isNaN(updatedAt.getTime())
    ? ""
    : ` &middot; ${updatedAt.toLocaleTimeString("en-CA", {
        timeZone: DEFAULT_LOCATION.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}`;

  return `<section class="card">
      <div class="cardLabel">Indoor</div>
      <div class="primary">${formatTemp(indoor.temperature)}</div>
      <div class="secondary">${escapeHtml(indoor.source)}${updatedLabel}</div>
      ${Number.isFinite(indoor.humidity) ? `<div class="secondary">Humidity ${Math.round(indoor.humidity)}%</div>` : ""}
    </section>`;
}

function renderWeatherCard(weather) {
  if (!weather) {
    return renderUnavailableCard("Weather");
  }

  return `<section class="card">
      <div class="cardLabel">Weather</div>
      <div class="primary">${formatTemp(weather.temperature)}</div>
      <div class="secondary">${escapeHtml(weather.condition)} in ${escapeHtml(weather.city)}</div>
      <div class="split">
        <div class="cell"><strong>Feels</strong>${formatTemp(weather.feelsLike)}</div>
        <div class="cell"><strong>High/Low</strong>${formatTemp(weather.high)} / ${formatTemp(weather.low)}</div>
        <div class="cell"><strong>Rain</strong>${Number.isFinite(weather.rainChance) ? `${weather.rainChance}%` : "--"}</div>
      </div>
      <div class="split">
        <div class="cell"><strong>Humidity</strong>${Number.isFinite(weather.humidity) ? `${weather.humidity}%` : "--"}</div>
        <div class="cell"><strong>Wind</strong>${Number.isFinite(weather.wind) ? `${Math.round(weather.wind)} km/h` : "--"}</div>
        <div class="cell"></div>
      </div>
    </section>`;
}

function renderUnavailableCard(label) {
  return `<section class="card">
      <div class="cardLabel">${escapeHtml(label)}</div>
      <div class="primary">--</div>
      <div class="secondary">Temporarily unavailable</div>
    </section>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
