const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

const GENRES = [
    "All Content", "Action", "Animation", "Comedy", "Drama", 
    "Horror", "Sci-Fi", "Thriller", "Unrated", "Adult & More"
];

const manifest = {
    id: "community.rawstreamer.rd",
    version: "6.3.0",
    name: "Pure Raw Torrent Streamer",
    description: "100% Uncensored & Unfiltered global live torrent feed sorted strictly by latest upload. Powered by Real-Debrid.",
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

const initAddon = (rdApiKey = "") => {
    const builder = new addonBuilder(manifest);

    // ==========================================
    // [1] UPGRADED CATALOG HANDLER (FIXED SEARCH)
    // ==========================================
    builder.defineCatalogHandler(async (args) => {
        let query = "latest";
        
        // Dynamic detection of global Stremio search query
        if (args.extra && args.extra.search) {
            query = args.extra.search;
            console.log("User is actively searching for:", query);
        } else if (args.extra && args.extra.genre && args.extra.genre !== "All Content") {
            query = args.extra.genre.toLowerCase();
        }

        // Adjust endpoints based on context: Global search vs Newest live feed
        let url = `https://torrent-io.xyz/api/v1/search?imdb=tt0000000&q=${encodeURIComponent(query)}`; 
        if (query === "latest") {
            url = `https://torrent-io.xyz/api/v1/search?imdb=tt1111111`; 
        }

        try {
            const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const data = await response.json();

            if (data && data.results && data.results.length > 0) {
                // If it's a regular feed, sort by date. If it's a search, keep highest relevance/seeders
                let sortedResults = data.results;
                if (query === "latest") {
                    sortedResults = data.results.sort((a, b) => new Date(b.upload_date || 0) - new Date(a.upload_date || 0));
                }

                const metas = sortedResults.map(torrent => {
                    const titleText = torrent.title || "Uncensored Torrent Pack";
                    const hash = torrent.info_hash || torrent.hash;
                    const fallbackPoster = `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent(titleText.substring(0, 22))}&theme=dark`;

                    return {
                        id: `raw_${hash}`,
                        type: "movie",
                        name: titleText,
                        poster: fallbackPoster,
                        description: `Seeds: ${torrent.seeders || 0} | Size: ${(torrent.size / (1024 * 1024 * 1024)).toFixed(2)} GB\nUploaded: ${torrent.upload_date || "Live"}`,
                        releaseInfo: "TORRENT"
                    };
                });
                return { metas: metas };
            }
        } catch (err) {
            console.error("Catalog Search Error:", err);
        }

        // Only default to fallback if not explicitly searching to prevent wrong results
        if (!args.extra || !args.extra.search) {
            try {
                const fallbackRes = await fetch("https://v3-cinemeta.strem.io/catalog/movie/top.json");
                const fallbackData = await fallbackRes.json();
                if (fallbackData && fallbackData.metas) return { metas: fallbackData.metas.slice(0, 20) };
            } catch (e) {
                console.error("Fallback failure:", e);
            }
        }

        return { metas: [] };
    });

    // ==========================================
    // [2] STREAM RESOLVER VIA REAL-DEBRID
    // ==========================================
    builder.defineStreamHandler(async (args) => {
        const streamId = args.id;
        const currentKey = rdApiKey; 

        if (!currentKey) {
            return { streams: [{ title: "⚠️ Real-Debrid API Key Missing", url: "" }] };
        }

        let torrents = [];

        try {
            if (streamId.startsWith("raw_")) {
                const hash = streamId.replace("raw_", "");
                torrents.push({ hash: hash, title: "Selected Video Stream" });
            } 
            else if (streamId.startsWith("tt")) {
                const cleanImdbId = streamId.split(":")[0];
                const resId = await fetch(`https://torrent-io.xyz/api/v1/search?imdb=${cleanImdbId}`);
                const dataId = await resId.json();
                if (dataId.results) torrents = torrents.concat(dataId.results);
            }

            if (torrents.length === 0) return { streams: [] };

            const streamPromises = torrents.map(async (torrent) => {
                const hash = torrent.info_hash || torrent.hash;
                const titleName = torrent.title || "Raw Stream";
                
                try {
                    const rdAddResponse = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${currentKey}` },
                        body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${hash}` })
                    });
                    const rdAddData = await rdAddResponse.json();
                    
                    if (rdAddData.id) {
                        const torrentId = rdAddData.id;
                        await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, {
                            method: "POST",
                            headers: { "Authorization": `Bearer ${currentKey}` },
                            body: new URLSearchParams({ files: "all" })
                        });

                        const rdInfoResponse = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
                            headers: { "Authorization": `Bearer ${currentKey}` }
                        });
                        const rdInfoData = await rdInfoResponse.json();

                        if (rdInfoData.links && rdInfoData.links.length > 0) {
                            const selectedLink = rdInfoData.links[0];
                            const unrestrictResponse = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
                                method: "POST",
                                headers: { "Authorization": `Bearer ${currentKey}` },
                                body: new URLSearchParams({ link: selectedLink })
                            });
                            const unrestrictData = await unrestrictResponse.json();

                            if (unrestrictData.download) {
                                return {
                                    title: `🚀 [RD Cached] | Newest 🆕\n${titleName}`,
                                    url: unrestrictData.download
                                };
                            }
                        }
                    }
                } catch (e) {
                    console.error("RD Processing Error:", e);
                }

                return { title: `🎬 [🌐 Torrent]\n${titleName}`, infoHash: hash };
            });

            const streams = await Promise.all(streamPromises);
            return { streams: streams.filter(s => s !== null) };

        } catch (error) {
            console.error("Stream resolver error:", error);
        }

        return { streams: [] };
    });

    return builder.getInterface();
};

// ==========================================
// [3] FIXED EXPRESS ROUTER FOR ADVANCED QUERY STRINGS
// ==========================================
const express = require("express");
const app = express();
const cors = require("cors");
app.use(cors());

app.all("/:rd_api/manifest.json", (req, res) => {
    const addonInterface = initAddon(req.params.rd_api);
    res.json(addonInterface.manifest);
});

// Intercepts and parses query strings like search= and genre= from path params cleanly
app.all("/:rd_api/catalog/:type/:id/:extra?.json", async (req, res) => {
    const addonInterface = initAddon(req.params.rd_api);
    let extra = {};
    
    // Check both req.query (standard) and req.params (path rewrite) to capture the search term
    if (req.query && Object.keys(req.query).length > 0) {
        extra = req.query;
    } else if (req.params.extra) {
        const cleanParams = req.params.extra.replace(".json", "");
        extra = Object.fromEntries(new URLSearchParams(cleanParams));
    }
    
    const args = { type: req.params.type, id: req.params.id, extra };
    const idx = addonInterface.handlers.findIndex(h => h.key === "catalog");
    const result = await addonInterface.handlers[idx].handler(args);
    res.json(result);
});

app.all("/:rd_api/stream/:type/:id.json", async (req, res) => {
    const addonInterface = initAddon(req.params.rd_api);
    const args = { type: req.params.type, id: req.params.id };
    const idx = addonInterface.handlers.findIndex(h => h.key === "stream");
    const result = await addonInterface.handlers[idx].handler(args);
    res.json(result);
});

app.all("/manifest.json", (req, res) => {
    res.json(manifest);
});

const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`Addon listening on port ${port}`);
});
