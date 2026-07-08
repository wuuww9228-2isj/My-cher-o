const express = require("express");
const fetch = require("node-fetch");
const pLimit = require("p-limit");

// ===================== CONFIG =====================
const GENRES = [
  "All Content", "Action", "Animation", "Comedy", "Drama",
  "Horror", "Sci-Fi", "Thriller", "Documentary", "Adult (XXX)"
];

// Public CORS proxy – bypasses Render’s blocked IP
const PROXY = "https://corsproxy.io/?";

// Torrent sources (all accessed through the proxy)
const TORRENT_APIS = [
  {
    name: "TorrentProject",
    url: (query) => `https://torrentproject.cc/api/v1/torrents?limit=100&search=${encodeURIComponent(query || "")}`,
    parse: (json) => json.torrents?.map(i => ({
      info_hash: i.hash,
      name: i.title,
      size: i.size || 0,
      seeders: i.seeders || 0,
      added: i.uploaded || Math.floor(Date.now()/1000)
    })) || []
  },
  {
    name: "DHT",
    url: (query) => `https://dht.lc/search?q=${encodeURIComponent(query || "latest")}`,
    parse: (data) => Array.isArray(data) ? data.map(i => ({
      info_hash: i.info_hash,
      name: i.name,
      size: i.size || 0,
      seeders: i.seeders || 0,
      added: i.added || 0
    })) : []
  },
  {
    name: "APIBay (TPB)",
    url: (query) => `https://apibay.org/q.php?q=${encodeURIComponent(query || "")}&cat=0`,
    parse: (data) => Array.isArray(data) && data[0]?.id !== "0" ? data.map(i => ({
      info_hash: i.info_hash,
      name: i.name,
      size: i.size,
      seeders: i.seeders,
      added: i.added
    })) : []
  }
];

const MANIFEST = {
  id: "community.rawstreamer.fresh",
  version: "1.0.0",
  name: "Raw Torrent Streamer",
  description: "Latest unfiltered torrents (Movies, Series, Videos) via Real-Debrid.",
  resources: ["catalog", "stream"],
  types: ["movie", "series", "other"],
  idPrefixes: ["tt", "raw_"],
  catalogs: [
    {
      type: "movie",
      id: "raw_movies",
      name: "🔞 Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", options: GENRES, isRequired: false }
      ]
    },
    {
      type: "series",
      id: "raw_series",
      name: "🔞 Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", options: GENRES, isRequired: false }
      ]
    },
    {
      type: "other",
      id: "raw_videos",
      name: "🔞 Videos",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", options: GENRES, isRequired: false }
      ]
    }
  ]
};

// ===================== EXPRESS SETUP =====================
const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// ===================== CONFIG PAGE =====================
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Raw Torrent Streamer – Setup</title>
      <style>
        body { font-family: Arial; background: #111; color: #eee; padding: 2rem; text-align: center; }
        input { padding: 0.75rem; width: 300px; margin: 1rem 0; border: none; border-radius: 6px; }
        .link-box { background: #222; padding: 1rem; border-radius: 8px; word-break: break-all; margin: 1rem auto; max-width: 600px; }
        a { color: #e50914; }
      </style>
    </head>
    <body>
      <h2>⚙️ Configure Your Add-on</h2>
      <p>Enter your Real-Debrid API token<br>(<a href="https://real-debrid.com/apitoken" target="_blank">get it here</a>)</p>
      <input type="text" id="apikey" placeholder="Paste your RD API key" oninput="updateLink()" />
      <div id="result"></div>
      <script>
        function updateLink() {
          const key = document.getElementById("apikey").value.trim();
          if (!key) { document.getElementById("result").innerHTML = ""; return; }
          const link = window.location.origin + "/" + key + "/manifest.json";
          document.getElementById("result").innerHTML =
            "<div class='link-box'><strong>Your Stremio install link:</strong><br><code>" + link + "</code><br><br>" +
            "<button onclick=\"navigator.clipboard.writeText('"+link+"')\">📋 Copy to Clipboard</button></div>";
        }
      </script>
    </body>
    </html>
  `);
});

// ===================== TORRENT FETCHING (via proxy) =====================
async function fetchTorrents(query) {
  const q = query || "";
  for (const api of TORRENT_APIS) {
    try {
      const targetUrl = api.url(q);
      const proxyUrl = PROXY + encodeURIComponent(targetUrl);
      console.log(`Trying ${api.name} via proxy: ${proxyUrl}`);
      const resp = await fetch(proxyUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
      });
      const data = await resp.json();
      const results = api.parse(data);
      if (results.length > 0) {
        console.log(`${api.name} returned ${results.length} torrents`);
        return results;
      }
    } catch (e) {
      console.log(`${api.name} failed: ${e.message}`);
    }
  }
  return [];
}

// ===================== CATALOG HANDLER =====================
async function handleCatalog(type, id, extra = {}) {
  let query = "";
  if (extra.search) {
    query = extra.search;
  } else if (extra.genre && extra.genre !== "All Content") {
    query = extra.genre === "Adult (XXX)" ? "XXX" : extra.genre;
  }

  const torrents = await fetchTorrents(query);

  return torrents
    .filter(t => t && t.info_hash)
    .map(t => ({
      id: `raw_${t.info_hash}`,
      type: type,
      name: t.name || "Unknown",
      poster: `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent((t.name||"").slice(0,25))}`,
      description: `🌱 ${t.seeders||0} seeds | 💾 ${t.size ? (t.size/1e9).toFixed(2)+" GB" : "? GB"} | 📅 ${t.added ? new Date(t.added*1000).toLocaleDateString() : "N/A"}`
    }));
}

// ===================== STREAM HANDLER (Real-Debrid) =====================
async function handleStream(streamId, rdApiKey) {
  if (!rdApiKey) return [{ title: "⚠️ Real-Debrid API key missing", url: "" }];

  let torrents = [];
  if (streamId.startsWith("raw_")) {
    torrents.push({ infoHash: streamId.replace("raw_", ""), title: "Feed stream" });
  } else if (streamId.startsWith("tt")) {
    try {
      const imdb = streamId.split(":")[0];
      const res = await fetch(`https://torrentio.strem.fun/api/search?imdb=${imdb}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const data = await res.json();
      torrents = (data.streams || []).map(s => ({
        infoHash: s.infoHash,
        title: s.title || s.name
      }));
    } catch (e) {}
  }
  if (!torrents.length) return [];

  const limit = pLimit(2);
  const streamPromises = torrents.slice(0,5).map(torrent =>
    limit(async () => {
      const hash = torrent.infoHash;
      try {
        const addResp = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
          method: "POST",
          headers: { "Authorization": `Bearer ${rdApiKey}`, "User-Agent": "RawStreamer/1.0" },
          body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${hash}` })
        });
        const addData = await addResp.json();
        if (!addData.id) return null;

        await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addData.id}`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${rdApiKey}`, "User-Agent": "RawStreamer/1.0" },
          body: new URLSearchParams({ files: "all" })
        });

        const infoResp = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`, {
          headers: { "Authorization": `Bearer ${rdApiKey}`, "User-Agent": "RawStreamer/1.0" }
        });
        const infoData = await infoResp.json();
        if (!infoData.links?.length) return null;

        const unrestrictResp = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
          method: "POST",
          headers: { "Authorization": `Bearer ${rdApiKey}`, "User-Agent": "RawStreamer/1.0" },
          body: new URLSearchParams({ link: infoData.links[0] })
        });
        const unrestrictData = await unrestrictResp.json();
        return unrestrictData.download
          ? { title: `🚀 [RD] ${torrent.title || "Stream"}`, url: unrestrictData.download }
          : null;
      } catch (err) {
        return null;
      }
    })
  );
  const streams = await Promise.all(streamPromises);
  return streams.filter(s => s && s.url);
}

// ===================== ROUTES =====================
app.get("/manifest.json", (req, res) => {
  res.json({ error: "Please configure via the web page at /" });
});

app.get(["/:rd_api/manifest.json", "/:rd_api/manifest.json/"], (req, res) => {
  res.json(MANIFEST);
});

app.get(["/:rd_api/catalog/:type/:id.json", "/:rd_api/catalog/:type/:id.json/"], async (req, res) => {
  try {
    const metas = await handleCatalog(req.params.type, req.params.id, req.query);
    res.json({ metas });
  } catch (e) {
    console.error("Catalog error:", e);
    res.json({ metas: [] });
  }
});

app.get(["/:rd_api/stream/:type/:id.json", "/:rd_api/stream/:type/:id.json/"], async (req, res) => {
  try {
    const streams = await handleStream(req.params.id, req.params.rd_api);
    res.json({ streams });
  } catch (e) {
    console.error("Stream error:", e);
    res.json({ streams: [] });
  }
});

// Diagnostic endpoint – see which APIs work
app.get("/test", async (req, res) => {
  const results = {};
  for (const api of TORRENT_APIS) {
    try {
      const proxyUrl = PROXY + encodeURIComponent(api.url(""));
      const resp = await fetch(proxyUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await resp.json();
      results[api.name] = api.parse(data).length;
    } catch(e) {
      results[api.name] = "error: " + e.message;
    }
  }
  res.json(results);
});

app.use((req, res) => {
  console.log(`❌ 404 Not Found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "Not Found", url: req.originalUrl });
});

// ===================== START =====================
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`✅ RawStreamer running on port ${PORT}`));
