const express = require("express");
const fetch = require("node-fetch");
const pLimit = require("p-limit");
const cloudscraper = require("cloudscraper");

// ===================== CONFIG =====================
const GENRES = [
  "All Content", "Action", "Animation", "Comedy", "Drama",
  "Horror", "Sci-Fi", "Thriller", "Documentary", "Adult (XXX)"
];

// TPB mirrors – cloudscraper will bypass Cloudflare
const TPB_MIRRORS = [
  "https://apibay.org",
  "https://tpb.party/apibay"
];

const DHT_API = "https://dht.lc/search";

const MANIFEST = {
  id: "community.rawstreamer.config",
  version: "4.0.0",
  name: "Raw Torrent Streamer",
  description: "Unfiltered torrent catalog with Real-Debrid. Use the web config page to set your API key.",
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

// ===================== CONFIG PAGE – no button, auto‑generate link =====================
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
      <p>Paste your Real-Debrid API token below (<a href="https://real-debrid.com/apitoken" target="_blank">get it here</a>)</p>
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

// ===================== TORRENT SEARCH (with cloudscraper) =====================
async function searchTPB(query, category) {
  for (const base of TPB_MIRRORS) {
    try {
      const url = `${base}/q.php?q=${encodeURIComponent(query)}&cat=${category || 0}`;
      console.log(`Trying TPB (cloudscraper): ${url}`);
      const body = await cloudscraper.get(url);
      const data = JSON.parse(body);
      if (Array.isArray(data) && data.length > 0 && data[0].id !== "0") {
        console.log(`TPB success: ${data.length} torrents from ${base}`);
        return data;
      }
    } catch (err) {
      console.log(`TPB mirror ${base} failed: ${err.message}`);
    }
  }
  return [];
}

async function searchDHT(query) {
  try {
    const url = `${DHT_API}?q=${encodeURIComponent(query)}`;
    console.log(`Trying DHT: ${url}`);
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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

  if (!query) query = "1080p";   // default feed

  // Try TPB first (cloudscraper), then DHT
  let torrents = await searchTPB(query, 0); // category 0 = all (we rely on API, but filter is optional)
  if (!torrents.length) {
    torrents = await searchDHT(query);
  }

  // Fallback search term if nothing found
  if (!torrents.length && query === "1080p") {
    console.log("Fallback search '2024'");
    torrents = await searchTPB("2024", 0);
    if (!torrents.length) torrents = await searchDHT("2024");
  }

  return torrents.map(t => {
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
        if (unrestrictData.download) {
          return {
            title: `🚀 [RD] ${torrent.title || "Stream"}`,
            url: unrestrictData.download
          };
        }
        return null;
      } catch (err) {
        return null;
      }
    })
  );

  const streams = await Promise.all(streamPromises);
  return streams.filter(Boolean);
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

app.use((req, res) => {
  console.log(`❌ 404 Not Found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "Not Found", url: req.originalUrl });
});

// ===================== START =====================
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`✅ RawStreamer running on port ${PORT}`));
