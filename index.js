const express = require("express");
const fetch = require("node-fetch");
const pLimit = require("p-limit");

const GENRES = [
  "All Content", "Action", "Animation", "Comedy", "Drama",
  "Horror", "Sci-Fi", "Thriller", "Documentary", "Adult (XXX)"
];

const WORKER_URL = "https://empty-shadow-f28c.k77wny498c.workers.dev/";

const MANIFEST = {
  id: "community.rawstreamer.torrentio",
  version: "1.0.0",
  name: "Raw Torrent Streamer",
  description: "Latest torrents + Real-Debrid streaming (Movies, Series, Videos).",
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

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// Config page
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><title>Setup</title>
    <style>body{font-family:Arial;background:#111;color:#eee;padding:2rem;text-align:center} input{padding:.75rem;width:300px;margin:1rem 0;border:none;border-radius:6px} .link-box{background:#222;padding:1rem;border-radius:8px;word-break:break-all;margin:1rem auto;max-width:600px} a{color:#e50914}</style></head>
    <body><h2>⚙️ Configure Your Add-on</h2>
    <p>Paste your Real-Debrid API token (<a href="https://real-debrid.com/apitoken" target="_blank">get it here</a>)</p>
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
    </script></body></html>
  `);
});

// Fetch torrents from the Cloudflare Worker
async function fetchTorrents(query, cat) {
  try {
    const resp = await fetch(`${WORKER_URL}/?q=${encodeURIComponent(query || "")}&cat=${cat || 0}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const json = await resp.json();
    return json.torrents || [];
  } catch (e) {
    return [];
  }
}

// Catalog handler
async function handleCatalog(type, id, extra = {}) {
  let query = "";
  let cat = 0;
  if (type === "movie") cat = 201;
  else if (type === "series") cat = 205;
  else if (type === "other") cat = 200;

  if (extra.search) {
    query = extra.search;
  } else if (extra.genre && extra.genre !== "All Content") {
    query = extra.genre === "Adult (XXX)" ? "XXX" : extra.genre;
  }

  const torrents = await fetchTorrents(query, cat);
  return torrents.map(t => ({
    id: `raw_${t.info_hash}`,
    type: type,
    name: t.name || "Unknown",
    poster: `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent((t.name||"").slice(0,25))}`,
    description: `🌱 ${t.seeders||0} seeds | 💾 ${t.size ? (t.size/1e9).toFixed(2)+" GB" : "? GB"}`
  }));
}

// Stream handler (Real-Debrid)
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

// Routes
app.get("/manifest.json", (req, res) => res.json({ error: "Please configure via the web page at /" }));
app.get(["/:rd_api/manifest.json", "/:rd_api/manifest.json/"], (req, res) => res.json(MANIFEST));
app.get(["/:rd_api/catalog/:type/:id.json", "/:rd_api/catalog/:type/:id.json/"], async (req, res) => {
  try {
    const metas = await handleCatalog(req.params.type, req.params.id, req.query);
    res.json({ metas });
  } catch (e) { res.json({ metas: [] }); }
});
app.get(["/:rd_api/stream/:type/:id.json", "/:rd_api/stream/:type/:id.json/"], async (req, res) => {
  try {
    const streams = await handleStream(req.params.id, req.params.rd_api);
    res.json({ streams });
  } catch (e) { res.json({ streams: [] }); }
});
app.use((req, res) => res.status(404).json({ error: "Not Found" }));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log("✅ RawStreamer running"));
