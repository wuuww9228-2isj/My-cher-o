const express = require("express");
const fetch = require("node-fetch");
const pLimit = require("p-limit");

// ===================== CONFIG =====================
const GENRES = [
  "All Content", "Action", "Animation", "Comedy", "Drama",
  "Horror", "Sci-Fi", "Thriller", "Documentary", "Adult (XXX)"
];

// No Cloudflare – works from any Render region
const TORRENTPROJECT_API = "https://torrentproject.cc/api/v1/torrents";
const DHT_API = "https://dht.lc/search";

const MANIFEST = {
  id: "community.rawstreamer.config",
  version: "7.0.0",
  name: "Raw Torrent Streamer",
  description: "Unfiltered latest torrents (Movies, Series, Videos) via Real-Debrid.",
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
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ===================== CONFIG PAGE (auto‑generates link) =====================
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Raw Torrent Streamer – Setup</title>
      <style>
        body { font-family: Arial, sans-serif; background: #1e1e1e; color: #eee; padding: 2rem; text-align: center; }
        input { padding: 0.75rem; width: 300px; margin: 1rem 0; border: none; border-radius: 6px; }
        .link-box { background: #333; padding: 1rem; border-radius: 8px; word-break: break-all; margin: 1rem auto; max-width: 600px; }
        a { color: #e50914; }
      </style>
    </head>
    <body>
      <h2>⚙️ Configure Your Add-on</h2>
      <p>Paste your Real-Debrid API token (<a href="https://real-debrid.com/apitoken" target="_blank">get it here</a>)</p>
      <input type="text" id="apikey" placeholder="Paste your RD API key" oninput="updateLink()" />
      <div id="result"></div>
      <script>
        function updateLink() {
          var key = document.getElementById("apikey").value.trim();
          if (!key) {
            document.getElementById("result").innerHTML = "";
            return;
          }
          var installLink = window.location.origin + "/" + key + "/manifest.json";
          document.getElementById("result").innerHTML =
            "<div class='link-box'>" +
            "<strong>Your Stremio install link:</strong><br/>" +
            "<code>" + installLink + "</code><br/><br/>" +
            "<button onclick=\"navigator.clipboard.writeText('" + installLink + "')\">📋 Copy to Clipboard</button>" +
            "</div>";
        }
      </script>
    </body>
    </html>
  `);
});

// ===================== TORRENT SEARCH =====================

// TorrentProject – returns latest torrents, accepts query, no Cloudflare
async function searchTorrentProject(query) {
  try {
    const params = new URLSearchParams();
    params.set("limit", "100");
    if (query) params.set("search", query);
    const url = `${TORRENTPROJECT_API}?${params.toString()}`;
    console.log(`Trying TorrentProject: ${url}`);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    const json = await resp.json();
    if (json.torrents && json.torrents.length > 0) {
      console.log(`TorrentProject returned ${json.torrents.length} results`);
      return json.torrents.map(item => ({
        info_hash: item.hash,
        name: item.title,
        size: item.size || 0,
        seeders: item.seeders || 0,
        added: item.uploaded || Math.floor(Date.now() / 1000)
      }));
    }
  } catch (err) {
    console.log(`TorrentProject failed: ${err.message}`);
  }
  return [];
}

// Fallback: DHT search (no Cloudflare)
async function searchDHT(query) {
  try {
    const url = `${DHT_API}?q=${encodeURIComponent(query || "1080p")}`;
    console.log(`Trying DHT: ${url}`);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    const data = await resp.json();
    if (Array.isArray(data) && data.length > 0) {
      console.log(`DHT returned ${data.length} results`);
      return data.map(item => ({
        info_hash: item.info_hash,
        name: item.name,
        size: item.size || 0,
        seeders: item.seeders || 0,
        added: item.added || 0
      }));
    }
  } catch (err) {
    console.log(`DHT failed: ${err.message}`);
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

  // Try TorrentProject first (returns latest if no query)
  let torrents = await searchTorrentProject(query);
  // Fallback to DHT
  if (!torrents.length) {
    torrents = await searchDHT(query);
  }

  // If still nothing, try a generic fallback
  if (!torrents.length) {
    console.log("Trying fallback search '1080p'");
    torrents = await searchDHT("1080p");
  }

  // Filter and map to Stremio meta (strict null removal)
  return torrents
    .filter(t => t && t.info_hash)
    .map(t => {
      const hash = t.info_hash;
      const name = t.name || "Unknown";
      const seeders = t.seeders || 0;
      const size = t.size ? (t.size / 1e9).toFixed(2) + " GB" : "? GB";
      const added = t.added ? new Date(t.added * 1000).toLocaleDateString() : "N/A";
      return {
        id: `raw_${hash}`,
        type: type,
        name: name,
        poster: `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent(name.slice(0, 25))}`,
        description: `🌱 ${seeders} seeds | 💾 ${size} | 📅 ${added}`
      };
    });
}

// ===================== STREAM HANDLER (Real-Debrid) =====================
async function handleStream(streamId, rdApiKey) {
  if (!rdApiKey) {
    return [{ title: "⚠️ Real-Debrid API key missing", url: "" }];
  }

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
    } catch (e) { /* ignore */ }
  }

  if (!torrents.length) return [];

  const limit = pLimit(2);
  const streamPromises = torrents.slice(0, 5).map(torrent =>
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
        if (!infoData.links || infoData.links.length === 0) return null;

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

// ===================== ROUTES (bulletproof trailing‑slash handling) =====================
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

app.use((req, res) => {
  console.log(`❌ 404 Not Found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "Not Found", url: req.originalUrl });
});

// ===================== START =====================
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`✅ RawStreamer running on port ${PORT}`));
