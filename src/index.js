export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/" && url.pathname !== "/kindle") {
      return new Response("Not Found", { status: 404 });
    }

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

    const now = new Date().toLocaleString("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kindle Dashboard</title>
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #fff;
      color: #000;
      font-family: Georgia, "Times New Roman", serif;
    }

    body {
      box-sizing: border-box;
      padding: 36px 48px;
    }

    .title {
      font-size: 42px;
      font-weight: bold;
      border-bottom: 4px solid #000;
      padding-bottom: 14px;
      margin-bottom: 28px;
    }

    .row {
      font-size: 30px;
      margin: 22px 0;
    }

    .label {
      font-weight: bold;
    }

    .small {
      font-size: 20px;
      margin-top: 42px;
    }
  </style>
</head>
<body>
  <div class="title">Kindle Home Dashboard</div>

  <div class="row">
    <span class="label">Toronto Time:</span> ${now}
  </div>

  <div class="row">
    <span class="label">Cloud:</span> Cloudflare Worker online
  </div>

  <div class="row">
    <span class="label">Kindle:</span> Jailbreak ready
  </div>

  <div class="row">
    <span class="label">Mode:</span> Secure dashboard URL
  </div>

  <div class="small">
    Auto-refresh: 5 minutes
  </div>

  <script>
    setTimeout(function () {
      location.reload();
    }, 5 * 60 * 1000);
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  },
};
