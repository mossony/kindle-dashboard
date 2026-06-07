const REFRESH_SECONDS = 30;

const DEFAULT_LOCATION = {
  city: "Toronto",
  latitude: 43.6532,
  longitude: -79.3832,
  timezone: "America/Toronto",
};

const INDOOR_KV_KEY = "home:indoor";
const INDOOR_HISTORY_LIMIT = 96;
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
      generatedAt: formatTime(new Date(), location.timezone),
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
  const previousIndoor = await getIndoorSnapshot(env);
  const updatedAt = new Date().toISOString();
  const history = normalizeIndoorHistory(previousIndoor);
  history.push({
    temperature,
    humidity: Number.isFinite(humidity) ? humidity : null,
    updatedAt,
  });

  indoorSnapshot = {
    temperature,
    humidity: Number.isFinite(humidity) ? humidity : null,
    source: payload.source ? String(payload.source) : "HomePod",
    updatedAt,
    history: history.slice(-INDOOR_HISTORY_LIMIT),
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

function normalizeIndoorHistory(indoor) {
  if (!indoor) {
    return [];
  }

  if (Array.isArray(indoor.history)) {
    return indoor.history
      .map((point) => ({
        temperature: Number(point.temperature),
        humidity: Number(point.humidity),
        updatedAt: String(point.updatedAt || indoor.updatedAt || ""),
      }))
      .filter((point) => Number.isFinite(point.temperature) && point.updatedAt);
  }

  if (Number.isFinite(indoor.temperature) && indoor.updatedAt) {
    return [{
      temperature: indoor.temperature,
      humidity: Number(indoor.humidity),
      updatedAt: indoor.updatedAt,
    }];
  }

  return [];
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
  const result = json.chart?.result?.[0];
  const meta = result?.meta;
  const prices = result?.indicators?.quote?.[0]?.close || [];

  if (!meta?.regularMarketPrice) {
    throw new Error("NVDA quote unavailable");
  }

  return {
    symbol: "NVDA",
    price: meta.regularMarketPrice,
    currency: meta.currency || "USD",
    changePercent: getPercentChange(meta.regularMarketPrice, meta.previousClose),
    marketState: meta.marketState || "UNKNOWN",
    history: compactSeries(prices),
  };
}

async function getBtcUsdtQuote() {
  try {
    const [quote, klines] = await Promise.all([
      fetchJson("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"),
      fetchJson("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=30m&limit=48"),
    ]);

    return {
      symbol: "BTCUSDT",
      price: Number(quote.lastPrice),
      currency: "USDT",
      changePercent: Number(quote.priceChangePercent),
      history: compactSeries(klines.map((item) => Number(item[4]))),
    };
  } catch (error) {
    const json = await fetchJson("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    return {
      symbol: "BTCUSDT",
      price: Number(json.data?.amount),
      currency: "USDT",
      changePercent: null,
      history: [],
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

function compactSeries(values, targetLength = 28) {
  const cleanValues = values.filter((value) => Number.isFinite(value));
  if (cleanValues.length <= targetLength) {
    return cleanValues;
  }

  const step = cleanValues.length / targetLength;
  const series = [];
  for (let index = 0; index < targetLength; index += 1) {
    series.push(cleanValues[Math.floor(index * step)]);
  }

  return series;
}

function formatDate(date, timezone) {
  return date.toLocaleDateString("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatTime(date, timezone) {
  return date.toLocaleTimeString("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
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

  return `${value.toFixed(1)}&deg;C`;
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

function renderDashboard({ date, generatedAt, location, nvda, btc, indoor, weather }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=600, initial-scale=1, maximum-scale=1, user-scalable=no">
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
      font-family: Verdana, "Trebuchet MS", sans-serif;
    }

    body {
      box-sizing: border-box;
      padding: 20px;
    }

    .shell {
      width: 560px;
      max-width: none;
      margin: 0 auto;
      position: relative;
    }

    @media (min-width: 800px) {
      .shell {
        margin-left: 0;
        zoom: 1.45;
      }
    }

    .masthead {
      display: table;
      width: 100%;
      margin: 0 0 20px;
      padding: 0 0 20px;
      border-bottom: 3px solid #000;
      table-layout: fixed;
    }

    .date {
      display: table-cell;
      width: 62%;
      vertical-align: middle;
      font-size: 50px;
      line-height: 1;
      font-weight: 700;
      letter-spacing: 1px;
    }

    .refreshNote {
      display: table-cell;
      vertical-align: middle;
      text-align: right;
    }

    .refreshPill {
      display: inline-block;
      border: 2px solid #000;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 22px;
      line-height: 1;
      font-weight: 700;
      white-space: nowrap;
    }

    .card {
      box-sizing: border-box;
      position: relative;
      border: 3px solid #000;
      border-radius: 24px;
      margin: 0 0 20px;
      padding: 20px;
      background: #fff;
      overflow: visible;
    }

    .board {
      overflow: hidden;
    }

    .markets {
      display: table;
      width: 100%;
      table-layout: fixed;
      border-spacing: 0;
      margin-bottom: 20px;
    }

    .marketSlot {
      display: table-cell;
      width: 50%;
      vertical-align: top;
    }

    .marketSlotLeft {
      padding-right: 10px;
    }

    .marketSlotRight {
      padding-left: 10px;
    }

    .markets .card {
      margin-bottom: 0;
      min-height: 210px;
    }

    .cardCompact {
      min-height: 186px;
    }

    .cardTall {
      min-height: 254px;
    }

    .tag {
      display: inline-block;
      border: 2px solid #000;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 19px;
      line-height: 1;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      background: #fff;
    }

    .cardLabel {
      display: inline-block;
      border: 2px solid #000;
      border-radius: 999px;
      padding: 5px 12px;
      margin-bottom: 20px;
      font-size: 24px;
      line-height: 1;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .primary {
      font-size: 76px;
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
      font-size: 64px;
      line-height: 0.9;
    }

    .movePercent {
      display: block;
      margin-top: 8px;
      font-size: 30px;
      line-height: 1;
    }

    .sparkline {
      width: 100%;
      height: 52px;
      margin-top: 18px;
      display: block;
    }

    .sparkline path,
    .sparkline polyline {
      fill: none;
      stroke: #000;
      stroke-width: 5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .sparkline .dashedLine {
      stroke-dasharray: 12 10;
      stroke-width: 4;
    }

    .markets .sparkline {
      width: 56%;
      height: 44px;
      margin-top: 16px;
    }

    .indoorChart {
      position: absolute;
      right: 20px;
      bottom: 48px;
      width: 46%;
      height: 52px;
      margin-top: 0;
    }

    .timeAxis {
      position: absolute;
      right: 20px;
      bottom: 20px;
      display: table;
      width: 46%;
      margin-top: 0;
      font-size: 22px;
      line-height: 1;
      font-weight: 700;
    }

    .axisStart,
    .axisEnd {
      display: table-cell;
      width: 50%;
    }

    .axisEnd {
      text-align: right;
    }

    .cardCompact .marketRow,
    .cardCompact .marketPrice,
    .cardCompact .marketMove {
      display: block;
    }

    .cardCompact .marketMove {
      position: absolute;
      right: 20px;
      bottom: 20px;
      width: auto;
    }

    .cardCompact .arrow {
      font-size: 56px;
    }

    .cardCompact .movePercent {
      font-size: 27px;
    }

    .secondary {
      margin-top: 20px;
      font-size: 33px;
      line-height: 1.2;
    }

    .cardCompact .primary {
      font-size: 76px;
    }

    .markets .cardCompact .primary {
      font-size: 54px;
    }

    .markets .cardCompact .secondary {
      font-size: 28px;
    }

    .markets .cardCompact .arrow {
      font-size: 50px;
    }

    .markets .cardCompact .movePercent {
      font-size: 24px;
    }

    .cardCompact .secondary {
      font-size: 30px;
    }

    .cardTall .primary {
      font-size: 74px;
    }

    .metrics {
      width: 100%;
      margin-top: 20px;
    }

    .metric {
      display: inline-block;
      box-sizing: border-box;
      width: 48%;
      padding: 0 20px 20px 0;
      font-size: 32px;
      line-height: 1.2;
      vertical-align: top;
    }

    .metric strong {
      display: block;
      font-size: 25px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .card .source {
      position: absolute;
      top: 20px;
      right: 20px;
      font-size: 22px;
      font-weight: 700;
      text-align: right;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
    }

    .card .source .humidity {
      font-size: 18px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="masthead">
      <div class="date">${escapeHtml(date)}</div>
      <div class="refreshNote"><span class="refreshPill">30s &middot; ${escapeHtml(generatedAt)}</span></div>
    </section>

    <section class="board">
      <section class="markets">
        <div class="marketSlot marketSlotLeft">${renderMarketCard("NVDA", nvda, "cardCompact")}</div>
        <div class="marketSlot marketSlotRight">${renderMarketCard("BTCUSDT", btc, "cardCompact")}</div>
      </section>
      ${renderIndoorCard(indoor)}
      ${renderWeatherCard(weather)}
    </section>

  </main>
</body>
</html>`;
}

function renderMarketCard(label, quote, className = "") {
  if (!quote) {
    return renderUnavailableCard(label, className);
  }

  const movement = getMovement(quote.changePercent);

  return `<section class="card ${escapeHtml(className)}">
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
      ${renderSparkline(quote.history)}
    </section>`;
}

function renderSparkline(values, dashedValues = null) {
  if (!values || values.length < 2) {
    return "";
  }

  const width = 260;
  const height = 52;
  const padding = 5;
  const usableDashedValues = dashedValues?.filter((value) => Number.isFinite(value)) || [];
  const points = seriesToPoints(values, width, height, padding);
  const dashedPoints = dashedValues && usableDashedValues.length >= 2
    ? seriesToPoints(usableDashedValues, width, height, padding)
    : "";

  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="${points}"></polyline>
        ${dashedPoints ? `<polyline class="dashedLine" points="${dashedPoints}"></polyline>` : ""}
      </svg>`;
}

function seriesToPoints(values, width, height, padding) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values
    .map((value, index) => {
      const x = padding + (index / (values.length - 1)) * (width - padding * 2);
      const y = padding + ((max - value) / range) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function renderIndoorTrend(indoor) {
  const history = normalizeIndoorHistory(indoor);
  if (history.length < 2) {
    return "";
  }

  const values = history.map((point) => point.temperature);
  const humidityValues = history
    .map((point) => point.humidity)
    .filter((value) => Number.isFinite(value));
  const start = formatAxisTime(history[0]?.updatedAt);
  const end = formatAxisTime(history[history.length - 1]?.updatedAt);

  return `${renderSparkline(values, humidityValues).replace('class="sparkline"', 'class="sparkline indoorChart"')}
      <div class="timeAxis">
        <span class="axisStart">${escapeHtml(start)}</span>
        <span class="axisEnd">${escapeHtml(end)}</span>
      </div>`;
}

function formatAxisTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }

  return date.toLocaleTimeString("en-CA", {
    timeZone: DEFAULT_LOCATION.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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
  const updatedTime = Number.isNaN(updatedAt.getTime())
    ? ""
    : `${updatedAt.toLocaleTimeString("en-CA", {
        timeZone: DEFAULT_LOCATION.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}`;

  const humidityHtml = Number.isFinite(indoor.humidity)
    ? `<div class="humidity">Humidity ${Math.round(indoor.humidity)}%</div>`
    : "";

  return `<section class="card">
      <div class="cardLabel">Indoor</div>
      <div class="primary">${formatTemp(indoor.temperature)}</div>
      <div class="source">${escapeHtml(indoor.source)} ${escapeHtml(updatedTime)}${humidityHtml}</div>
      ${renderIndoorTrend(indoor)}
    </section>`;
}

function renderWeatherCard(weather) {
  if (!weather) {
    return renderUnavailableCard("Weather");
  }

  return `<section class="card cardWeather">
      <div class="cardLabel">Weather</div>
      <div class="primary">${formatTemp(weather.temperature)}</div>
      <div class="metrics">
        <div class="metric"><strong>High/Low</strong>${formatTemp(weather.high)} / ${formatTemp(weather.low)}</div>
        <div class="metric"><strong>Rain</strong>${Number.isFinite(weather.rainChance) ? `${weather.rainChance}%` : "--"}</div>
        <div class="metric"><strong>Humidity</strong>${Number.isFinite(weather.humidity) ? `${weather.humidity}%` : "--"}</div>
        <div class="metric"><strong>Wind</strong>${Number.isFinite(weather.wind) ? `${Math.round(weather.wind)} km/h` : "--"}</div>
      </div>
    </section>`;
}

function renderUnavailableCard(label, className = "") {
  return `<section class="card ${escapeHtml(className)}">
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
