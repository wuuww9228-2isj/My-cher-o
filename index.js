const express = require("express");
const fetch = require("node-fetch");
const pLimit = require("p-limit");

// ===================== CONFIG =====================
const GENRES = [
  "All Content", "Action", "Animation", "Comedy", "Drama",
  "Horror", "Sci-Fi", "Thriller", "Documentary", "Adult (XXX)"
];

// All TPB API mirrors we'll try (in order)
const TPB_MIRRORS = [
  "https://apibay.org",
  "https://apibay.cc",
  "https://piratebay.party/apibay",
  "https://tpb23.ukpass.co/apibay",
  "https://tpb.party/apibay"
];

const CATEGORY_MAP = {
  movie: 201,    // Movies
  series: 205,   // TV shows
  other: 200     // Video/VOD
};

const MANIFEST = {
  id: "community.rawstreamer.rd",
  version: "9.1.0",
  name: "Pure Raw Torrent Streamer",
  description: "Uncensored feed (Movies, Series, Videos) via multiple torrent sources + Real-Debrid.",
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

// Optional request logger (helps debugging)
app.use((req, res, next) => {
  console.log(`→ ${req.method} ${req.url}`);
  next();
});

// ===================== SOURCE 1: TPB MIRRORS =====================
async function searchTPB(query, cat) {
  for (const base of TPB_MIRRORS) {
    try {
      const url = `${base}/q.php?q=${encodeURIComponent(query)}&cat=${cat || 0}`;
      console.log(`Trying TPB: ${url}`);
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000  // 8 sec timeout per mirror
      });
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0 && data[0].id !== "0") {
        console.log(`TPB success from ${base}, got ${data.length} results`);
        return data;
      }
    } catch (err) {
      console.log(`TPB mirror ${base} failed: ${err.message}`);
    }
  }
  return null;
}

// ===================== SOURCE 2: SOLIDTORRENTS =====================
async function searchSolidTorrents(query, cat) {
  // Map our category numbers to SolidTorrents categories
  const solidCatMap = {
    201: "movies",
    205: "tv",
    200: "videos"
  };
  const solidCat = solidCatMap[cat] || "all";
  try {
    const url = `https://solidtorrents.net/api/v1/search?q=${encodeURIComponent(query)}&category=${solidCat}&sort=seeders`;
    console.log(`Trying SolidTorrents: ${url}`);
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await resp.json();
    if (data.results && data.results.length > 0) {
      console.log(`SolidTorrents returned ${data.results.length} results`);
      // Convert to TPB-like format so we can reuse the same mapper
      return data.results.map(item => ({
        info_hash: item.info_hash,
        name: item.title,
        size: item.size,
        seeders: item.seeders,
        added: item.added ? Math.floor(new Date(item.added).getTime() / 1000) : 0
      }));
    }
  } catch (err) {
    console.log(`SolidTorrents failed: ${err.message}`);
  }
  return null;
}

// ===================== SOURCE 3: TORRENTGALAXY (optional) =====================
async function searchTorrentGalaxy(query, cat) {
  // TorrentGalaxy has a simple RSS/search endpoint
  // We'll use a proxy because direct might be blocked
  const tgCatMap = {
    201: "Movies",
    205: "TV",
    200: "Other"
  };
  const tgCat = tgCatMap[cat] || "";
  try {
    const url = `https://torrentgalaxy.to/torrents.php?search=${encodeURIComponent(query)}&cat=${encodeURIComponent(tgCat)}&sort=seeders&order=desc`;
    console.log(`Trying TorrentGalaxy: ${url}`);
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await resp.text();
    // Simple extraction of magnet links (very rough but works for common layout)
    const regex = /href="magnet:\?xt=urn:btih:([a-fA-F0-9]{40})[^"]*"[^>]*>([^<]+)</g;
    const results = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
      results.push({
        info_hash: match[1],
        name: match[2] || "Unknown",
        size: 0,
        seeders: 0,
        added: Math.floor(Date.now() / 1000)
      });
    }
    if (results.length > 0) {
      console.log(`TorrentGalaxy parsed ${results.length} results`);
      return results;
    }
  } catch (err) {
    console.log(`TorrentGalaxy failed: ${err.message}`);
  }
  return null;
}

// ===================== UNIFIED CATALOG ENGINE =====================
async function handleCatalog(type, id, extraQuery) {
  let query = "";
  if (extraQuery && extraQuery.search) {
    query = extraQuery.search;
  } else if (extraQuery && extraQuery.genre && extraQuery.genre !== "All Content") {
    query = extraQuery.genre === "Adult (XXX)" ? "XXX" : extraQuery.genre;
  }

  const cat = CATEGORY_MAP[type] || 0;
  let torrents = null;

  // Try sources in this order: TPB, SolidTorrents, TorrentGalaxy
  torrents = await searchTPB(query, cat);
  if (!torrents) {
    torrents = await searchSolidTorrents(query, cat);
  }
  if (!torrents) {
    torrents = await searchTorrentGalaxy(query, cat);
  }

  // If still nothing, return empty array
  if (!torrents || torrents.length === 0) {
    console.log(`No torrents found for type=${type}, query="${query}"`);
    return [];
  }

  // Map to Stremio meta objects
  return torrents.map(torrent => {
    const hash = torrent.info_hash;
    const titleText = torrent.name || "Unknown Release";
    const sizeGb = torrent.size ? (torrent.size / 1e9).toFixed(2) : "?";
    const seeders = torrent.seeders || 0;
    const addedStr = torrent.added ? new Date(torrent.added * 1000).toLocaleDateString() : "N/A";
    return {
      id: `raw_${hash}`,
      type: type,
      name: titleText,
      poster: `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent(titleText.substring(0, 25))}`,
      description: `Seeders: ${seeders} | Size: ${sizeGb} GB | Added: ${addedStr}`
    };
  });
}

// ===================== STREAM RESOLVER (Real-Debrid) =====================
async function handleStream(streamId, rdApiKey) {
  if (!rdApiKey) return [{ title: "⚠️ RD API key missing", url: "" }];

  let torrents = [];

  if (streamId.startsWith("raw_")) {
    torrents.push({ infoHash: streamId.replace("raw_", ""), title: "Feed stream" });
  } else if (streamId.startsWith("tt")) {
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

  const limit = pLimit(2);
  const streamPromises = torrents.slice(0, 10).map(torrent =>
    limit(async () => {
      const hash = torrent.infoHash;
      try {
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

        await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addData.id}`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${rdApiKey}`,
            "User-Agent": "StremioRawFeed/1.0"
          },
          body: new URLSearchParams({ files: "all" })
        });

        const infoResp = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`, {
          headers: {
            "Authorization": `Bearer ${rdApiKey}`,
            "User-Agent": "StremioRawFeed/1.0"
          }
        });
        const infoData = await infoResp.json();
        if (!infoData.links || !infoData.links.length) return null;

        const unrestrictResp = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${rdApiKey}`,
            "User-Agent": "StremioRawFeed/1.0"
          },
          body: new URLSearchParams({ link: infoData.links[0] })
        });
        const unrestrictData = await unrestrictResp.json();
        return unrestrictData.download
          ? { title: `🚀 [RD] ${torrent.title}`, url: unrestrictData.download }
          : null;
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

app.get("/:rd_api/catalog/:type/:id.json/?", async (req, res) => {
  try {
    const metas = await handleCatalog(req.params.type, req.params.id, req.query);
    res.json({ metas });
  } catch (err) {
    console.error("Catalog error:", err);
    res.json({ metas: [] });
  }
});

app.get("/:rd_api/stream/:type/:id.json", async (req, res) => {
  try {
    const streams = await handleStream(req.params.id, req.params.rd_api);
    res.json({ streams });
  } catch (err) {
    console.error("Stream error:", err);
    res.json({ streams: [] });
  }
});

// Catch-all for debugging
app.use((req, res) => {
  console.log(`404 Not Found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "Not Found", url: req.originalUrl });
});

// ===================== START =====================
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
