const REFRESH_SECONDS = 60;

const DEFAULT_LOCATION = {
  city: "Toronto",
  latitude: 43.6532,
  longitude: -79.3832,
  timezone: "America/Toronto",
};

const INDOOR_KV_KEY = "home:indoor";
const INDOOR_HISTORY_LIMIT = 96;
const BLUE_JAYS_TEAM_ID = 141;
const ROGERS_CENTRE_TICKETMASTER_VENUE_ID = "131114";
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
    const today = formatDate(new Date(), location.timezone);
    const [nvdaResult, btcResult, weatherResult, rogersCentreResult] = await Promise.allSettled([
      getNvdaQuote(),
      getBtcUsdtQuote(),
      getWeather(location),
      getRogersCentreActivity(today, location.timezone, env),
    ]);

    const dashboard = {
      date: today,
      generatedAt: formatTime(new Date(), location.timezone),
      location,
      nvda: valueOrUnavailable(nvdaResult),
      btc: valueOrUnavailable(btcResult),
      indoor: await getIndoorSnapshot(env),
      weather: valueOrUnavailable(weatherResult),
      rogersCentre: valueOrUnavailable(rogersCentreResult),
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
    return getYahooBtcUsdQuote();
  }
}

async function getYahooBtcUsdQuote() {
  try {
    const json = await fetchJson(
      "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=30m&range=1d",
    );
    const result = json.chart?.result?.[0];
    const meta = result?.meta;
    const prices = result?.indicators?.quote?.[0]?.close || [];
    const price = Number(meta?.regularMarketPrice);
    const previousClose = Number(meta?.chartPreviousClose ?? meta?.previousClose);

    if (!Number.isFinite(price)) {
      throw new Error("Yahoo BTC quote unavailable");
    }

    return {
      symbol: "BTCUSDT",
      price,
      currency: "USDT",
      changePercent: getPercentChange(price, previousClose),
      history: compactSeries(prices),
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

async function getRogersCentreActivity(date, timezone, env) {
  const [blueJaysResult, ticketmasterResult] = await Promise.allSettled([
    getBlueJaysHomeGame(date),
    getTicketmasterRogersCentreEvent(date, timezone, env),
  ]);

  return valueOrUnavailable(blueJaysResult) || valueOrUnavailable(ticketmasterResult);
}

async function getBlueJaysHomeGame(date) {
  const params = new URLSearchParams({
    sportId: "1",
    teamId: String(BLUE_JAYS_TEAM_ID),
    date,
  });
  const json = await fetchJson(`https://statsapi.mlb.com/api/v1/schedule?${params}`);
  const games = json.dates?.flatMap((day) => day.games || []) || [];
  const game = games.find((item) => item.teams?.home?.team?.id === BLUE_JAYS_TEAM_ID);

  if (!game) {
    return null;
  }

  return {
    title: "Blue Jays",
    subtitle: "",
    time: formatEventTime(game.gameDate, DEFAULT_LOCATION.timezone),
    source: "MLB",
  };
}

async function getTicketmasterRogersCentreEvent(date, timezone, env) {
  if (!env.TICKETMASTER_API_KEY) {
    return null;
  }

  const params = new URLSearchParams({
    venueId: ROGERS_CENTRE_TICKETMASTER_VENUE_ID,
    startDateTime: zonedTimeToUtcIso(date, "00:00:00", timezone),
    endDateTime: zonedTimeToUtcIso(date, "23:59:59", timezone),
    countryCode: "CA",
    sort: "date,asc",
    size: "1",
    apikey: env.TICKETMASTER_API_KEY,
  });
  const json = await fetchJson(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
  const event = json._embedded?.events?.[0];

  if (!event) {
    return null;
  }

  return {
    title: event.name || "Event",
    subtitle: "",
    time: formatTicketmasterTime(event, timezone),
    source: "Ticketmaster",
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

function formatEventTime(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return formatTime(date, timezone);
}

function formatTicketmasterTime(event, timezone) {
  const dateTime = event.dates?.start?.dateTime;
  if (dateTime) {
    return formatEventTime(dateTime, timezone);
  }

  const localTime = event.dates?.start?.localTime;
  if (!localTime) {
    return "";
  }

  return localTime.slice(0, 5);
}

function formatMlbMatchup(game) {
  const away = game.teams?.away?.team?.name || "Away";
  return `vs ${shortTeamName(away)}`;
}

function shortTeamName(name) {
  return String(name)
    .replace(/^Toronto /, "")
    .replace(/^Baltimore /, "")
    .replace(/^Boston /, "")
    .replace(/^New York /, "")
    .replace(/^Tampa Bay /, "")
    .replace(/^Los Angeles /, "")
    .replace(/^San Francisco /, "")
    .replace(/^Arizona /, "")
    .replace(/^Philadelphia /, "")
    .replace(/^Washington /, "")
    .replace(/^Cleveland /, "")
    .replace(/^Detroit /, "")
    .replace(/^Minnesota /, "")
    .replace(/^Kansas City /, "")
    .replace(/^Chicago /, "")
    .replace(/^Milwaukee /, "")
    .replace(/^Pittsburgh /, "")
    .replace(/^Cincinnati /, "")
    .replace(/^St\\. Louis /, "")
    .replace(/^Houston /, "")
    .replace(/^Texas /, "")
    .replace(/^Seattle /, "")
    .replace(/^Colorado /, "")
    .replace(/^San Diego /, "")
    .replace(/^Miami /, "")
    .replace(/^Atlanta /, "");
}

function zonedTimeToUtcIso(date, time, timezone) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  let utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  for (let index = 0; index < 3; index += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(utcDate);
    const local = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(
      Number(local.year),
      Number(local.month) - 1,
      Number(local.day),
      Number(local.hour),
      Number(local.minute),
      Number(local.second),
    );
    const expectedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    utcDate = new Date(utcDate.getTime() - (localAsUtc - expectedAsUtc));
  }

  return utcDate.toISOString().replace(".000Z", "Z");
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

function renderDashboard({ date, generatedAt, location, nvda, btc, indoor, weather, rogersCentre }) {
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

    .marketSlot,
    .bottomSlot {
      display: table-cell;
      width: 50%;
      vertical-align: top;
    }

    .marketSlotLeft,
    .bottomSlotLeft {
      padding-right: 10px;
    }

    .marketSlotRight,
    .bottomSlotRight {
      padding-left: 10px;
    }

    .markets .card {
      margin-bottom: 0;
      min-height: 210px;
    }

    .bottomRow {
      display: table;
      width: 100%;
      table-layout: fixed;
      border-spacing: 0;
    }

    .bottomRow .card {
      min-height: 258px;
      margin-bottom: 0;
    }

    .bottomRow .cardLabel {
      font-size: 20px;
      margin-bottom: 18px;
    }

    .bottomRow .primary {
      font-size: 58px;
    }

    .bottomRow .metric {
      width: 100%;
      padding-bottom: 12px;
      font-size: 25px;
    }

    .bottomRow .metric strong {
      font-size: 20px;
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

    .eventTitle {
      font-size: 34px;
      line-height: 1.15;
      font-weight: 700;
    }

    .eventSubtitle {
      margin-top: 10px;
      font-size: 24px;
      line-height: 1.15;
      font-weight: 700;
    }

    .eventTime {
      margin-top: 18px;
      font-size: 36px;
      line-height: 1;
      font-weight: 700;
    }

    .eventWarning {
      margin-top: 22px;
      border-top: 2px solid #000;
      padding-top: 14px;
      font-size: 24px;
      line-height: 1.15;
      font-weight: 700;
    }

    .hasEvent .masthead {
      margin-bottom: 20px;
      padding-bottom: 20px;
    }

    .hasEvent .date {
      font-size: 50px;
    }

    .hasEvent .refreshPill {
      font-size: 22px;
      padding: 5px 10px;
    }

    .hasEvent .markets {
      margin-bottom: 20px;
    }

    .hasEvent .card {
      border-width: 3px;
      border-radius: 24px;
      margin-bottom: 20px;
      padding: 20px;
    }

    .hasEvent .markets .card {
      min-height: 210px;
    }

    .hasEvent .cardLabel {
      font-size: 24px;
      margin-bottom: 20px;
      padding: 5px 12px;
    }

    .hasEvent .markets .cardCompact .primary {
      font-size: 54px;
    }

    .hasEvent .markets .cardCompact .secondary {
      font-size: 28px;
      margin-top: 20px;
    }

    .hasEvent .markets .cardCompact .arrow {
      font-size: 50px;
    }

    .hasEvent .markets .cardCompact .movePercent {
      font-size: 24px;
    }

    .hasEvent .markets .sparkline {
      height: 44px;
      margin-top: 16px;
    }

    .hasEvent .card:not(.cardCompact):not(.cardWeather):not(.cardEvent) {
      min-height: 214px;
    }

    .hasEvent .card:not(.cardCompact):not(.cardWeather):not(.cardEvent) .primary {
      font-size: 76px;
    }

    .hasEvent .card .source {
      top: 20px;
      right: 20px;
      font-size: 22px;
      gap: 6px;
    }

    .hasEvent .card .source .humidity {
      font-size: 18px;
    }

    .hasEvent .indoorChart {
      right: 20px;
      bottom: 48px;
      width: 46%;
      height: 52px;
    }

    .hasEvent .timeAxis {
      right: 20px;
      bottom: 20px;
      width: 46%;
      font-size: 22px;
    }

    .hasEvent .bottomRow .card {
      min-height: 330px;
      margin-bottom: 0;
    }

    .hasEvent .cardEvent {
      min-height: 330px;
    }

    .hasEvent .bottomRow .cardLabel {
      font-size: 21px;
      margin-bottom: 12px;
    }

    .hasEvent .bottomRow .primary {
      font-size: 54px;
    }

    .hasEvent .bottomRow .metric {
      padding-bottom: 12px;
      font-size: 25px;
    }

    .hasEvent .bottomRow .metric strong {
      font-size: 22px;
    }

    .hasEvent .eventTitle {
      font-size: 32px;
    }

    .hasEvent .eventSubtitle {
      margin-top: 8px;
      font-size: 24px;
    }

    .hasEvent .eventTime {
      margin-top: 20px;
      font-size: 32px;
    }

    .hasEvent .eventWarning {
      margin-top: 26px;
      padding-top: 12px;
      font-size: 24px;
    }
  </style>
</head>
<body>
  <main class="shell ${rogersCentre ? "hasEvent" : ""}">
    <section class="masthead">
      <div class="date">${escapeHtml(date)}</div>
      <div class="refreshNote"><span class="refreshPill">1m &middot; ${escapeHtml(generatedAt)}</span></div>
    </section>

    <section class="board">
      <section class="markets">
        <div class="marketSlot marketSlotLeft">${renderMarketCard("NVDA", nvda, "cardCompact")}</div>
        <div class="marketSlot marketSlotRight">${renderMarketCard("BTCUSDT", btc, "cardCompact")}</div>
      </section>
      ${renderIndoorCard(indoor)}
      ${renderBottomCards(weather, rogersCentre)}
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
  const start = formatAxisTime(history[Math.max(0, history.length - 7)]?.updatedAt);
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

function renderBottomCards(weather, rogersCentre) {
  if (!rogersCentre) {
    return renderWeatherCard(weather);
  }

  return `<section class="bottomRow">
      <div class="bottomSlot bottomSlotLeft">${renderWeatherCard(weather, true)}</div>
      <div class="bottomSlot bottomSlotRight">${renderRogersCentreCard(rogersCentre)}</div>
    </section>`;
}

function renderWeatherCard(weather, compact = false) {
  if (!weather) {
    return renderUnavailableCard("Weather");
  }

  const extraMetrics = compact
    ? ""
    : `<div class="metric"><strong>Humidity</strong>${Number.isFinite(weather.humidity) ? `${weather.humidity}%` : "--"}</div>
        <div class="metric"><strong>Wind</strong>${Number.isFinite(weather.wind) ? `${Math.round(weather.wind)} km/h` : "--"}</div>`;

  return `<section class="card cardWeather">
      <div class="cardLabel">Weather</div>
      <div class="primary">${formatTemp(weather.temperature)}</div>
      <div class="metrics">
        <div class="metric"><strong>High/Low</strong>${formatTemp(weather.high)} / ${formatTemp(weather.low)}</div>
        <div class="metric"><strong>Rain</strong>${Number.isFinite(weather.rainChance) ? `${weather.rainChance}%` : "--"}</div>
        ${extraMetrics}
      </div>
    </section>`;
}

function renderRogersCentreCard(event) {
  const time = event.time ? `${escapeHtml(event.time)} ` : "";
  const subtitle = event.subtitle ? `<div class="eventSubtitle">${escapeHtml(event.subtitle)}</div>` : "";

  return `<section class="card cardEvent">
      <div class="cardLabel">Rogers Centre</div>
      <div class="eventTitle">${escapeHtml(event.title)}</div>
      ${subtitle}
      <div class="eventTime">${time}Today</div>
      <div class="eventWarning">Traffic likely</div>
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
