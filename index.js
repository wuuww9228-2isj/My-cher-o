const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const GENRES = [
    "All Content", "Action", "Animation", "Comedy", "Drama", 
    "Horror", "Sci-Fi", "Thriller", "Documentary", "Adult (XXX)"
];

const manifest = {
    id: "community.rawstreamer.rd",
    version: "7.1.0",
    name: "Pure Raw Torrent Streamer",
    description: "100% Uncensored global torrent feed. Powered by Real-Debrid.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "raw_"],
    catalogs: [
        {
            type: "movie",
            id: "raw_live_feed",
            name: "🔞 Live Torrent Feed",
            extra: [
                { name: "search", isRequired: false },
                { name: "genre", options: GENRES, isRequired: false }
            ]
        }
    ],
    configurable: false
};

const app = express();
app.use(cors());

// ==========================================
// [1] THE PIRATE BAY (APIBAY) CATALOG ENGINE
// ==========================================
async function handleCatalog(type, id, extraQuery) {
    // Default search word for "All Content" to bring up recent releases
    let query = "2024"; 
    
    if (extraQuery && extraQuery.search) {
        query = extraQuery.search;
    } else if (extraQuery && extraQuery.genre && extraQuery.genre !== "All Content") {
        // Explicit route for adult content without censorship
        query = extraQuery.genre === "Adult (XXX)" ? "XXX" : extraQuery.genre;
    }

    // Direct connection to the world's largest unfiltered raw torrent database
    let url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`; 

    try {
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await response.json();

        // Apibay returns id "0" if absolutely no torrents are found
        if (Array.isArray(data) && data.length > 0 && data[0].id !== "0") {
            return data.map(torrent => {
                const hash = torrent.info_hash;
                const titleText = torrent.name || "Unknown Torrent";
                return {
                    id: `raw_${hash}`,
                    type: "movie",
                    name: titleText,
                    poster: `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent(titleText.substring(0, 25))}&theme=dark`,
                    description: `Seeders: ${torrent.seeders} | Leechers: ${torrent.leechers}\nSize: ${(torrent.size / (1024 * 1024 * 1024)).toFixed(2)} GB\nDate: ${new Date(torrent.added * 1000).toLocaleDateString()}`,
                    releaseInfo: "RAW TORRENT"
                };
            });
        }
    } catch (err) {
        console.error("Apibay Engine Error:", err);
    }

    // Removed the fake 20-movie fallback so you get exactly what you filter for!
    return [];
}

// ==========================================
// [2] STREAM RESOLVER VIA REAL-DEBRID
// ==========================================
async function handleStream(streamId, rdApiKey) {
    if (!rdApiKey) return [{ title: "⚠️ Real-Debrid API Key Missing", url: "" }];
    let torrents = [];

    try {
        // Direct hash streaming from our raw catalog
        if (streamId.startsWith("raw_")) {
            torrents.push({ hash: streamId.replace("raw_", ""), title: "Selected Video Stream" });
        } 
        // Standard streaming if clicked via Stremio global search
        else if (streamId.startsWith("tt")) {
            const cleanImdbId = streamId.split(":")[0];
            const resId = await fetch(`https://torrent-io.xyz/api/v1/search?imdb=${cleanImdbId}`);
            const dataId = await resId.json();
            const items = dataId.results || dataId.streams || [];
            torrents = torrents.concat(items);
        }

        if (torrents.length === 0) return [];

        const streamPromises = torrents.slice(0, 10).map(async (torrent) => {
            const hash = torrent.info_hash || torrent.hash;
            const titleName = torrent.title || "Raw Stream";
            
            try {
                const rdAdd = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${rdApiKey}` },
                    body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${hash}` })
                });
                const rdAddData = await rdAdd.json();
                
                if (rdAddData.id) {
                    await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${rdAddData.id}`, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${rdApiKey}` },
                        body: new URLSearchParams({ files: "all" })
                    });

                    const rdInfo = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${rdAddData.id}`, {
                        headers: { "Authorization": `Bearer ${rdApiKey}` }
                    });
                    const rdInfoData = await rdInfo.json();

                    if (rdInfoData.links && rdInfoData.links.length > 0) {
                        const unrestrict = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
                            method: "POST",
                            headers: { "Authorization": `Bearer ${rdApiKey}` },
                            body: new URLSearchParams({ link: rdInfoData.links[0] })
                        });
                        const unrestrictData = await unrestrict.json();
                        if (unrestrictData.download) {
                            return { title: `🚀 [RD Cached]\n${titleName}`, url: unrestrictData.download };
                        }
                    }
                }
            } catch (e) { console.error("RD Engine Error:", e); }
            return { title: `🎬 [🌐 Torrent]\n${titleName}`, infoHash: hash };
        });

        const streams = await Promise.all(streamPromises);
        return streams.filter(s => s !== null);
    } catch (error) { console.error("Stream Global Error:", error); }
    return [];
}

// ==========================================
// [3] ROUTING MATRIX
// ==========================================
app.get("/manifest.json", (req, res) => res.json(manifest));
app.get("/:rd_api/manifest.json", (req, res) => res.json(manifest));

app.get("/:rd_api/catalog/:type/:id.json", async (req, res) => {
    const metas = await handleCatalog(req.params.type, req.params.id, req.query);
    res.json({ metas });
});

app.get("/:rd_api/catalog/:type/:id/:extra.json", async (req, res) => {
    let extra = {};
    try {
        const cleanParams = req.params.extra.replace(".json", "");
        extra = Object.fromEntries(new URLSearchParams(cleanParams));
    } catch (e) {}
    const metas = await handleCatalog(req.params.type, req.params.id, extra);
    res.json({ metas });
});

app.get("/:rd_api/stream/:type/:id.json", async (req, res) => {
    const streams = await handleStream(req.params.id, req.params.rd_api);
    res.json({ streams });
});

const port = process.env.PORT || 7000;
app.listen(port, () => console.log(`Apibay Server active on port ${port}`));

const GENRES = [
    "All Content", "Action", "Animation", "Comedy", "Drama", 
    "Horror", "Sci-Fi", "Thriller", "Unrated", "Adult & More"
];

const manifest = {
    id: "community.rawstreamer.rd",
    version: "7.0.0",
    name: "Pure Raw Torrent Streamer",
    description: "100% Uncensored & Unfiltered global torrent feed sorted strictly by latest upload. Powered by Real-Debrid.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "raw_"],
    catalogs: [
        {
            type: "movie",
            id: "raw_live_feed",
            name: "🔞 Live Torrent Feed (Newest)",
            extra: [
                { name: "search", isRequired: false },
                { name: "genre", options: GENRES, isRequired: false }
            ]
        }
    ],
    configurable: false
};

const app = express();
app.use(cors());

// ==========================================
// [1] CORE CATALOG LOGIC (FIXED SEARCH & FEEDS)
// ==========================================
async function handleCatalog(type, id, extraQuery) {
    let query = "latest";
    
    // Catch active search from Stremio
    if (extraQuery && extraQuery.search) {
        query = extraQuery.search;
    } else if (extraQuery && extraQuery.genre && extraQuery.genre !== "All Content") {
        query = extraQuery.genre.toLowerCase();
    }

    // Dynamic fallback URL if it's a global feed vs dedicated query
    let url = `https://torrent-io.xyz/api/v1/search?imdb=tt0000000&q=${encodeURIComponent(query)}`; 
    if (query === "latest") {
        url = `https://torrent-io.xyz/api/v1/search?imdb=tt1111111`; 
    }

    try {
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await response.json();

        // High-compatibility mapping (Supports both .results and .streams arrays)
        const rawItems = data.results || data.streams || [];

        if (rawItems.length > 0) {
            // Sort strictly by latest upload date if it's the general live feed
            if (query === "latest") {
                rawItems.sort((a, b) => new Date(b.upload_date || 0) - new Date(a.upload_date || 0));
            }

            return rawItems.map(torrent => {
                const titleText = torrent.title || "Uncensored Torrent Pack";
                const hash = torrent.info_hash || torrent.hash;
                return {
                    id: `raw_${hash}`,
                    type: "movie",
                    name: titleText,
                    poster: `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent(titleText.substring(0, 20))}&theme=dark`,
                    description: `Seeds: ${torrent.seeders || 0} | Size: ${(torrent.size / (1024 * 1024 * 1024)).toFixed(2)} GB\nUploaded: ${torrent.upload_date || "Live"}`,
                    releaseInfo: "TORRENT"
                };
            });
        }
    } catch (err) {
        console.error("Catalog Engine Error:", err);
    }

    // Ironclad Backup Catalog: If everything fails, never return empty! Populate with Stremio Top Movies
    try {
        const fallback = await fetch("https://v3-cinemeta.strem.io/catalog/movie/top.json");
        const fallbackData = await fallback.json();
        if (fallbackData && fallbackData.metas) return fallbackData.metas.slice(0, 20);
    } catch (e) {}

    return [];
}

// ==========================================
// [2] STREAM RESOLVER VIA REAL-DEBRID
// ==========================================
async function handleStream(streamId, rdApiKey) {
    if (!rdApiKey) return [{ title: "⚠️ Real-Debrid API Key Missing", url: "" }];
    let torrents = [];

    try {
        if (streamId.startsWith("raw_")) {
            torrents.push({ hash: streamId.replace("raw_", ""), title: "Selected Video Stream" });
        } else if (streamId.startsWith("tt")) {
            const cleanImdbId = streamId.split(":")[0];
            const resId = await fetch(`https://torrent-io.xyz/api/v1/search?imdb=${cleanImdbId}`);
            const dataId = await resId.json();
            const items = dataId.results || dataId.streams || [];
            torrents = torrents.concat(items);
        }

        if (torrents.length === 0) return [];

        const streamPromises = torrents.slice(0, 10).map(async (torrent) => {
            const hash = torrent.info_hash || torrent.hash;
            const titleName = torrent.title || "Raw Stream";
            
            try {
                const rdAdd = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${rdApiKey}` },
                    body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${hash}` })
                });
                const rdAddData = await rdAdd.json();
                
                if (rdAddData.id) {
                    await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${rdAddData.id}`, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${rdApiKey}` },
                        body: new URLSearchParams({ files: "all" })
                    });

                    const rdInfo = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${rdAddData.id}`, {
                        headers: { "Authorization": `Bearer ${rdApiKey}` }
                    });
                    const rdInfoData = await rdInfo.json();

                    if (rdInfoData.links && rdInfoData.links.length > 0) {
                        const unrestrict = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
                            method: "POST",
                            headers: { "Authorization": `Bearer ${rdApiKey}` },
                            body: new URLSearchParams({ link: rdInfoData.links[0] })
                        });
                        const unrestrictData = await unrestrict.json();
                        if (unrestrictData.download) {
                            return { title: `🚀 [RD Cached] | Newest 🆕\n${titleName}`, url: unrestrictData.download };
                        }
                    }
                }
            } catch (e) { console.error("RD Engine Error:", e); }
            return { title: `🎬 [🌐 Torrent]\n${titleName}`, infoHash: hash };
        });

        const streams = await Promise.all(streamPromises);
        return streams.filter(s => s !== null);
    } catch (error) { console.error("Stream Global Error:", error); }
    return [];
}

// ==========================================
// [3] ROCK-SOLID EXPRESS ROUTING MATRIX
// ==========================================
app.get("/manifest.json", (req, res) => res.json(manifest));
app.get("/:rd_api/manifest.json", (req, res) => res.json(manifest));

// Strict interceptor for standard Stremio catalog calls with query strings (?search=)
app.get("/:rd_api/catalog/:type/:id.json", async (req, res) => {
    const metas = await handleCatalog(req.params.type, req.params.id, req.query);
    res.json({ metas });
});

// Strict interceptor for inline parameters rewrite catalogs (e.g. /genre=action.json)
app.get("/:rd_api/catalog/:type/:id/:extra.json", async (req, res) => {
    let extra = {};
    try {
        const cleanParams = req.params.extra.replace(".json", "");
        extra = Object.fromEntries(new URLSearchParams(cleanParams));
    } catch (e) {}
    const metas = await handleCatalog(req.params.type, req.params.id, extra);
    res.json({ metas });
});

// Stream Injection Route
app.get("/:rd_api/stream/:type/:id.json", async (req, res) => {
    const streams = await handleStream(req.params.id, req.params.rd_api);
    res.json({ streams });
});

const port = process.env.PORT || 7000;
app.listen(port, () => console.log(`Rock-Solid Addon Server active on port ${port}`));
