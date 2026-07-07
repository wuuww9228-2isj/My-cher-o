const express = require("express");
const fetch = require("node-fetch");
const pLimit = require("p-limit");

// ===================== CONFIG =====================
const GENRES = [
  "All Content", "Action", "Animation", "Comedy", "Drama",
  "Horror", "Sci-Fi", "Thriller", "Documentary", "Adult (XXX)"
];

const TPB_ENDPOINTS = [
  "https://apibay.org",
  "https://piratebay.party/apibay"  // fallback mirror
];

const CATEGORY_MAP = {
  movie: 201,    // Movies
  series: 205,   // TV shows
  other: 200     // Video (VOD)
};

const MANIFEST = {
  id: "community.rawstreamer.rd",
  version: "9.0.0",
  name: "Pure Raw Torrent Streamer",
  description: "100% Uncensored torrent feed for Movies, Series & Videos. Powered by Real-Debrid + multiple TPB mirrors.",
  resources: ["catalog", "stream"],
  types: ["movie", "series", "other"],
  idPrefixes: ["tt", "raw_"],
  catalogs: [
    {
      type: "movie",
      id: "raw_movie_feed",
      name: "🔞 Movies (Raw Feed)",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", options: GENRES, isRequired: false }
      ]
    },
    {
      type: "series",
      id: "raw_series_feed",
      name: "🔞 Series (Raw Feed)",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", options: GENRES, isRequired: false }
      ]
    },
    {
      type: "other",
      id: "raw_video_feed",
      name: "🔞 Videos (Raw Feed)",
      extra: [
        { name: "search", isRequired: false },
        { name: "genre", options: GENRES, isRequired: false }
      ]
    }
  ],
  configurable: false
};

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// ===================== HELPER: Search across TPB mirrors =====================
async function searchTPB(query, cat) {
  for (const base of TPB_ENDPOINTS) {
    try {
      const url = `${base}/q.php?q=${encodeURIComponent(query)}&cat=${cat || 0}`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0 && data[0].id !== "0") {
        return data;  // first successful mirror returns the data
      }
    } catch (err) {
      // try next mirror
    }
  }
  return [];
}

// ===================== CATALOG =====================
async function handleCatalog(type, id, extraQuery) {
  let query = ""; // empty = latest torrents
  if (extraQuery && extraQuery.search) {
    query = extraQuery.search;
  } else if (extraQuery && extraQuery.genre && extraQuery.genre !== "All Content") {
    query = extraQuery.genre === "Adult (XXX)" ? "XXX" : extraQuery.genre;
  }

  const cat = CATEGORY_MAP[type] || 0;
  const torrents = await searchTPB(query, cat);

  return torrents.map(torrent => {
    const hash = torrent.info_hash;
    const titleText = torrent.name || "Unknown Release";
    const sizeGb = (torrent.size / 1e9).toFixed(2);
    const uploadDate = new Date(torrent.added * 1000).toLocaleDateString();
    return {
      id: `raw_${hash}`,
      type: type,
      name: titleText,
      poster: `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent(titleText.substring(0, 25))}`,
      description: `Seeders: ${torrent.seeders} | Size: ${sizeGb} GB | Added: ${uploadDate}`,
    };
  });
}

// ===================== STREAM (with Real-Debrid) =====================
async function handleStream(streamId, rdApiKey) {
  if (!rdApiKey) return [{ title: "⚠️ Real-Debrid API key missing", url: "" }];

  let torrents = [];

  // 1. Our own raw_ hashes
  if (streamId.startsWith("raw_")) {
    torrents.push({ infoHash: streamId.replace("raw_", ""), title: "Feed stream" });
  }
  // 2. IMDB IDs from Stremio (movies/series)
  else if (streamId.startsWith("tt")) {
    try {
      const cleanImdb = streamId.split(":")[0];
      const res = await fetch(`https://torrent-io.xyz/api/v1/search?imdb=${cleanImdb}`);
      const data = await res.json();
      torrents = (data.results || []).map(r => ({
        infoHash: r.infoHash,
        title: r.title
      }));
    } catch (e) { /* ignore */ }
  }

  if (!torrents.length) return [];

  // Process with concurrency to avoid RD 429 errors
  const limit = pLimit(2);
  const streamPromises = torrents.slice(0, 10).map(torrent =>
    limit(async () => {
      const hash = torrent.infoHash;
      try {
        // Add magnet
        const addResp = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${rdApiKey}`,
            "User-Agent": "StremioRawFeed/1.0"
          },
          body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${hash}` })
        });
        const addData = await addResp.json();
        if (!addData.id) return null;

        // Select all files
        await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addData.id}`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${rdApiKey}`,
            "User-Agent": "StremioRawFeed/1.0"
          },
          body: new URLSearchParams({ files: "all" })
        });

        // Get file links
        const infoResp = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`, {
          headers: {
            "Authorization": `Bearer ${rdApiKey}`,
            "User-Agent": "StremioRawFeed/1.0"
          }
        });
        const infoData = await infoResp.json();
        if (!infoData.links || !infoData.links.length) return null;

        // Unrestrict first link
        const unrestrictResp = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${rdApiKey}`,
            "User-Agent": "StremioRawFeed/1.0"
          },
          body: new URLSearchParams({ link: infoData.links[0] })
        });
        const unrestrictData = await unrestrictResp.json();
        if (unrestrictData.download) {
          return {
            title: `🚀 [RD] ${torrent.title}`,
            url: unrestrictData.download
          };
        }
        return null;
      } catch (e) {
        return null;
      }
    })
  );

  const streams = await Promise.all(streamPromises);
  return streams.filter(Boolean);
}

// ===================== ROUTES =====================
app.get("/manifest.json", (req, res) => res.json(MANIFEST));
app.get("/:rd_api/manifest.json", (req, res) => res.json(MANIFEST));

// Only one catalog route – Stremio sends extra as query string
app.get("/:rd_api/catalog/:type/:id.json", async (req, res) => {
  const metas = await handleCatalog(req.params.type, req.params.id, req.query);
  res.json({ metas });
});

app.get("/:rd_api/stream/:type/:id.json", async (req, res) => {
  const streams = await handleStream(req.params.id, req.params.rd_api);
  res.json({ streams });
});

// ===================== START =====================
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
