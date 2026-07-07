const express = require("express");
const fetch = require("node-fetch");
const pLimit = require("p-limit");

// --------------- CONFIG ---------------
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

// --------------- MANIFEST ---------------
const MANIFEST = {
  id: "community.rawstreamer.rd",
  version: "1.0.0",
  name: "Raw Torrent Streamer",
  description: "Unfiltered torrent catalog (Movies, Series, Videos) via Real-Debrid",
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
  ],
  configurable: false
};

// --------------- EXPRESS SETUP ---------------
const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// Log every request (useful for Render logs)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// --------------- TORRENT SEARCH ---------------
// Search across all TPB mirrors, return raw data from first successful one
async function searchTPB(query, category) {
  for (const base of TPB_MIRRORS) {
    try {
      const url = `${base}/q.php?q=${encodeURIComponent(query)}&cat=${category || 0}`;
      console.log(`Trying TPB mirror: ${base}`);
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await resp.json();
      // TPB returns an array where the first item has id "0" if no results
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

// Fallback: SolidTorrents (aggregates many public trackers)
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
      // Convert to TPB-like format for uniform mapping
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

// --------------- CATALOG HANDLER ---------------
async function handleCatalog(type, id, extra = {}) {
  // Determine search term
  let query = "";
  if (extra.search) {
    query = extra.search;
  } else if (extra.genre && extra.genre !== "All Content") {
    query = extra.genre === "Adult (XXX)" ? "XXX" : extra.genre;
  }

  // Try TPB first, then SolidTorrents
  let torrents = await searchTPB(query, CATEGORY_MAP[type]);
  if (!torrents.length) {
    torrents = await searchSolidTorrents(query, type);
  }

  // Map to Stremio meta format
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

// --------------- STREAM HANDLER ---------------
async function handleStream(streamId, rdApiKey) {
  if (!rdApiKey) {
    return [{ title: "⚠️ Real-Debrid API key missing", url: "" }];
  }

  let torrents = [];

  // Our own feed hash
  if (streamId.startsWith("raw_")) {
    torrents.push({ infoHash: streamId.replace("raw_", ""), title: "Feed stream" });
  }
  // IMDB ID (from Stremio search)
  else if (streamId.startsWith("tt")) {
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

  // Limit concurrent RD requests
  const limit = pLimit(2);
  const streamPromises = torrents.slice(0, 5).map(torrent =>
    limit(async () => {
      const hash = torrent.infoHash;
      try {
        // 1. Add magnet
        const addResp = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
          method: "POST",
          headers: { "Authorization": `Bearer ${rdApiKey}`, "User-Agent": "RawStreamer/1.0" },
          body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${hash}` })
        });
        const addData = await addResp.json();
        if (!addData.id) return null;

        // 2. Select all files
        await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addData.id}`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${rdApiKey}`, "User-Agent": "RawStreamer/1.0" },
          body: new URLSearchParams({ files: "all" })
        });

        // 3. Get info
        const infoResp = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`, {
          headers: { "Authorization": `Bearer ${rdApiKey}`, "User-Agent": "RawStreamer/1.0" }
        });
        const infoData = await infoResp.json();
        if (!infoData.links || infoData.links.length === 0) return null;

        // 4. Unrestrict first link
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

// --------------- ROUTES ---------------
app.get("/", (req, res) => {
  res.send(`<h2>RawStreamer Add-on is Running</h2><p>Use <code>/YOUR_RD_API_KEY/manifest.json</code> to install in Stremio.</p>`);
});

app.get("/manifest.json", (req, res) => res.json(MANIFEST));
app.get("/:rd_api/manifest.json", (req, res) => res.json(MANIFEST));

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

// --------------- START ---------------
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`✅ RawStreamer listening on port ${PORT}`));
