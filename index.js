const express = require("express");
const fetch = require("node-fetch");

// Unfiltered Genres
const GENRES = [
    "All Content", "Action", "Animation", "Comedy", "Drama", 
    "Horror", "Sci-Fi", "Thriller", "Documentary", "Adult (XXX)"
];

// Manifest supporting Movies, Series, and Videos (Other)
const manifest = {
    id: "community.rawstreamer.rd",
    version: "8.0.0",
    name: "Pure Raw Torrent Streamer",
    description: "100% Uncensored global torrent feed for Movies, Series, and Videos. Powered by Real-Debrid.",
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

// Native CORS bypass to prevent Render 502 / Status 1 crashes
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    next();
});

// ==========================================
// [1] OPEN CATALOG ENGINE (THE PIRATE BAY)
// ==========================================
async function handleCatalog(type, id, extraQuery) {
    let query = "2024"; // Default broad search for recent active torrents
    
    // Parse user search or genre selection
    if (extraQuery && extraQuery.search) {
        query = extraQuery.search;
    } else if (extraQuery && extraQuery.genre && extraQuery.genre !== "All Content") {
        query = extraQuery.genre === "Adult (XXX)" ? "XXX" : extraQuery.genre;
    }

    // Direct API call to Apibay (The Pirate Bay open tracker)
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`; 

    try {
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await response.json();

        // Ensure valid array is returned and not the empty "0" ID placeholder
        if (Array.isArray(data) && data.length > 0 && data[0].id !== "0") {
            return data.map(torrent => {
                const hash = torrent.info_hash;
                const titleText = torrent.name || "Unknown Release";
                const sizeGb = (torrent.size / (1024 * 1024 * 1024)).toFixed(2);
                const uploadDate = new Date(torrent.added * 1000).toLocaleDateString();

                return {
                    id: `raw_${hash}`,
                    type: type, // Matches the category (movie, series, or other)
                    name: titleText,
                    poster: `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent(titleText.substring(0, 25))}&theme=dark`,
                    description: `Seeders: ${torrent.seeders} | Leechers: ${torrent.leechers}\nSize: ${sizeGb} GB\nDate: ${uploadDate}`,
                    releaseInfo: "RAW TORRENT"
                };
            });
        }
    } catch (err) {
        console.error("Catalog Engine Error:", err);
    }
    
    // Returns empty array if nothing is found (Prevents Stremio errors)
    return [];
}

// ==========================================
// [2] REAL-DEBRID STREAM RESOLVER
// ==========================================
async function handleStream(streamId, rdApiKey) {
    if (!rdApiKey) {
        return [{ title: "⚠️ Error", description: "Real-Debrid API Key Missing", url: "" }];
    }

    let torrents = [];

    try {
        // [A] Extract hash from our raw feed
        if (streamId.startsWith("raw_")) {
            torrents.push({ hash: streamId.replace("raw_", ""), title: "Selected Feed Stream" });
        } 
        // [B] Extract streams if user searched via global Stremio IMDB search
        else if (streamId.startsWith("tt")) {
            const cleanImdbId = streamId.split(":")[0];
            const resId = await fetch(`https://torrent-io.xyz/api/v1/search?imdb=${cleanImdbId}`);
            const dataId = await resId.json();
            const items = dataId.results || dataId.streams || [];
            torrents = torrents.concat(items);
        }

        if (torrents.length === 0) return [];

        // Limit stream resolution to top 10 results to prevent Render timeout
        const streamPromises = torrents.slice(0, 10).map(async (torrent) => {
            const hash = torrent.info_hash || torrent.hash;
            const titleName = torrent.title || "Stream Link";
            
            try {
                // 1. Add magnet to RD
                const rdAdd = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${rdApiKey}` },
                    body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${hash}` })
                });
                const rdAddData = await rdAdd.json();
                
                if (rdAddData.id) {
                    // 2. Select all files for the torrent
                    await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${rdAddData.id}`, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${rdApiKey}` },
                        body: new URLSearchParams({ files: "all" })
                    });

                    // 3. Get generated links
                    const rdInfo = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${rdAddData.id}`, {
                        headers: { "Authorization": `Bearer ${rdApiKey}` }
                    });
                    const rdInfoData = await rdInfo.json();

                    // 4. Unrestrict the first available link
                    if (rdInfoData.links && rdInfoData.links.length > 0) {
                        const unrestrict = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
                            method: "POST",
                            headers: { "Authorization": `Bearer ${rdApiKey}` },
                            body: new URLSearchParams({ link: rdInfoData.links[0] })
                        });
                        const unrestrictData = await unrestrict.json();
                        
                        if (unrestrictData.download) {
                            return { 
                                title: `🚀 [RD Cached]\n${titleName}`, 
                                url: unrestrictData.download 
                            };
                        }
                    }
                }
            } catch (e) {
                console.error("Real-Debrid Resolution Error:", e);
            }
            
            // Fallback: Return raw torrent if RD fails
            return { title: `🎬 [🌐 Torrent]\n${titleName}`, infoHash: hash };
        });

        // Resolve all requests in parallel
        const streams = await Promise.all(streamPromises);
        return streams.filter(s => s !== null);

    } catch (error) {
        console.error("Global Stream Error:", error);
    }
    
    return [];
}

// ==========================================
// [3] EXPRESS ROUTING MATRIX
// ==========================================

// Base Manifest Route
app.get("/manifest.json", (req, res) => res.json(manifest));
app.get("/:rd_api/manifest.json", (req, res) => res.json(manifest));

// Catalog Routing (Handles Standard Query)
app.get("/:rd_api/catalog/:type/:id.json", async (req, res) => {
    const metas = await handleCatalog(req.params.type, req.params.id, req.query);
    res.json({ metas });
});

// Catalog Routing (Handles Stremio Dynamic Parameters)
app.get("/:rd_api/catalog/:type/:id/:extra.json", async (req, res) => {
    let extra = {};
    try {
        const cleanParams = req.params.extra.replace(".json", "");
        extra = Object.fromEntries(new URLSearchParams(cleanParams));
    } catch (e) {}
    
    const metas = await handleCatalog(req.params.type, req.params.id, extra);
    res.json({ metas });
});

// Stream Routing
app.get("/:rd_api/stream/:type/:id.json", async (req, res) => {
    const streams = await handleStream(req.params.id, req.params.rd_api);
    res.json({ streams });
});

// Server Initialization
const port = process.env.PORT || 7000;
app.listen(port, () => console.log(`Server is active and listening on port ${port}`));
