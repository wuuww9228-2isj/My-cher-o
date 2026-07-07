const express = require("express");
const fetch = require("node-fetch");
const pLimit = require("p-limit");

// ===================== CONFIG =====================
const GENRES = [
  "All Content", "Action", "Animation", "Comedy", "Drama",
  "Horror", "Sci-Fi", "Thriller", "Documentary", "Adult (XXX)"
];

// Multiple TPB API mirrors (all unfiltered)
const TPB_MIRRORS = [
  "https://apibay.org",
  "https://apibay.cc",
  "https://tpb.party/apibay"
];

// Category IDs for TPB
const CATEGORY_MAP = {
  movie: 201,    // Movies
  series: 205,   // TV shows
  other: 200     // Video/VOD
};

// Manifest (no configurable flag – user configures via our web page)
const MANIFEST = {
  id: "community.rawstreamer.config",
  version: "1.0.0",
  name: "Raw Torrent Streamer (configurable)",
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

// Log requests for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ===================== CONFIGURATION PAGE =====================
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
        button { padding: 0.75rem 2rem; background: #e50914; color: white; border: none; border-radius: 6px; cursor: pointer; }
        .link { background: #333; padding: 1rem; border-radius: 8px; word-break: break-all; margin: 1rem auto; max-width: 600px; }
        a { color: #e50914; }
      </style>
    </head>
    <body>
      <h2>⚙️ Configure Your Add-on</h2>
      <p>Enter your Real-Debrid API token (<a href="https://real-debrid.com/apitoken" target="_blank">get it here</a>)</p>
      <input type="text" id="apikey" placeholder="Paste your RD API key" />
      <br/>
      <button onclick="generate()">Generate Install Link</button>
      <div id="result" style="margin-top:1.5rem;"></div>
      <script>
        function generate() {
          const key = document.getElementById("apikey").value.trim();
          if (!key) return alert("Please enter your API key");
          const base = window.location.origin;
          const installLink = base + "/" + key + "/manifest.json";
          document.getElementById("result").innerHTML = 
            "<div class='link'>" +
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
async function searchTPB(query, category) {
  for (const base of TPB_MIRRORS) {
    try {
      const url = `${base}/q.php?q=${encodeURIComponent(query)}&cat=${category || 0}`;
      console.log(`Trying TPB: ${base}`);
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await resp.json();
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

async function searchSolidTorrents(query, type) {
  const catMap = { movie: "movies", series: "tv", other: "videos" };
  const cat = catMap[type] || "all";
  try {
    const url = `https://solidtorrents.net/api/v1/search?q=${encodeURIComponent(query)}&category=${cat}&sort=seeders`;
    console.log(`Trying SolidTorrents: ${url}`);
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await resp.json();
    if (json.results && json.results.length > 0) {
      console.log(`SolidTorrents returned ${json.results.length} results`);
      return json.results.map(item => ({
        info_hash: item.info_hash,
        name: item.title,
        size: item.size,
        seeders: item.seeders,
        added: item.added ? Math.floor(new Date(item.added).getTime() / 1000) : Math.floor(Date.now() / 1000)
      }));
    }
  } catch (err) {
    console.log(`SolidTorrents failed: ${err.message}`);
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

  let torrents = await searchTPB(query, CATEGORY_MAP[type]);
  if (!torrents.length) {
    torrents = await searchSolidTorrents(query, type);
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
        // Add magnet to RD
        const addResp = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
          method: "POST",
          headers: { "Authorization": `Bearer ${rdApiKey}`, "User-Agent": "RawStreamer/1.0" },
          body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${hash}` })
        });
        const addData = await addResp.json();
        if (!addData.id) return null;

        // Select all files
        await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addData.id}`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${rdApiKey}`, "User-Agent": "RawStreamer/1.0" },
          body: new URLSearchParams({ files: "all" })
        });

        // Get file info
        const infoResp = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`, {
          headers: { "Authorization": `Bearer ${rdApiKey}`, "User-Agent": "RawStreamer/1.0" }
        });
        const infoData = await infoResp.json();
        if (!infoData.links || infoData.links.length === 0) return null;

        // Unrestrict first link
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
// Base manifest (no API key, just for Stremio to detect the addon? Not used)
app.get("/manifest.json", (req, res) => {
  res.json({ error: "Please configure via the web page at /" });
});

// API-key-specific routes
app.get("/:rd_api/manifest.json", (req, res) => {
  // We can validate the key quickly? Not necessary.
  res.json(MANIFEST);
});

app.get("/:rd_api/catalog/:type/:id.json", async (req, res) => {
  try {
    const metas = await handleCatalog(req.params.type, req.params.id, req.query);
    res.json({ metas });
  } catch (e) {
    console.error("Catalog error:", e);
    res.json({ metas: [] });
  }
});

app.get("/:rd_api/stream/:type/:id.json", async (req, res) => {
  try {
    const streams = await handleStream(req.params.id, req.params.rd_api);
    res.json({ streams });
  } catch (e) {
    console.error("Stream error:", e);
    res.json({ streams: [] });
  }
});

// ===================== START SERVER =====================
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`✅ RawStreamer config page running on port ${PORT}`));
