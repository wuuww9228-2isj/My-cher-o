const { addonBuilder } = require("stremio-addon-sdk");
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const GENRES = [
    "All Content", "Action", "Animation", "Comedy", "Drama", 
    "Horror", "Sci-Fi", "Thriller", "Unrated", "Adult & More"
];

const manifest = {
    id: "community.rawstreamer.rd",
    version: "6.4.0",
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

const app = express();
app.use(cors());

// Global Catalog Logic
async function handleCatalog(args) {
    let query = "latest";
    
    if (args.extra && args.extra.search) {
        query = args.extra.search;
    } else if (args.extra && args.extra.genre && args.extra.genre !== "All Content") {
        query = args.extra.genre.toLowerCase();
    }

    let url = `https://torrent-io.xyz/api/v1/search?imdb=tt0000000&q=${encodeURIComponent(query)}`; 
    if (query === "latest") {
        url = `https://torrent-io.xyz/api/v1/search?imdb=tt1111111`; 
    }

    try {
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await response.json();

        if (data && data.results && data.results.length > 0) {
            let sortedResults = data.results;
            if (query === "latest") {
                sortedResults = data.results.sort((a, b) => new Date(b.upload_date || 0) - new Date(a.upload_date || 0));
            }

            return sortedResults.map(torrent => {
                const titleText = torrent.title || "Uncensored Torrent Pack";
                const hash = torrent.info_hash || torrent.hash;
                return {
                    id: `raw_${hash}`,
                    type: "movie",
                    name: titleText,
                    poster: `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent(titleText.substring(0, 22))}&theme=dark`,
                    description: `Seeds: ${torrent.seeders || 0} | Size: ${(torrent.size / (1024 * 1024 * 1024)).toFixed(2)} GB\nUploaded: ${torrent.upload_date || "Live"}`,
                    releaseInfo: "TORRENT"
                };
            });
        }
    } catch (err) {
        console.error("Catalog Fetch Error:", err);
    }

    return [];
}

// Global Stream Logic
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
            if (dataId.results) torrents = torrents.concat(dataId.results);
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
            } catch (e) { console.error("RD Error:", e); }
            return { title: `🎬 [🌐 Torrent]\n${titleName}`, infoHash: hash };
        });

        const streams = await Promise.all(streamPromises);
        return streams.filter(s => s !== null);
    } catch (error) { console.error("Stream Error:", error); }
    return [];
}

// Express HTTP Routes (Rock-Solid Router)
app.get("/manifest.json", (req, res) => res.json(manifest));
app.get("/:rd_api/manifest.json", (req, res) => res.json(manifest));

app.get("/:rd_api/catalog/:type/:id.json", async (req, res) => {
    const args = { type: req.params.type, id: req.params.id, extra: req.query };
    const metas = await handleCatalog(args);
    res.json({ metas });
});

app.get("/:rd_api/catalog/:type/:id/:extra.json", async (req, res) => {
    let extra = {};
    try {
        const cleanParams = req.params.extra.replace(".json", "");
        extra = Object.fromEntries(new URLSearchParams(cleanParams));
    } catch (e) {}
    const args = { type: req.params.type, id: req.params.id, extra };
    const metas = await handleCatalog(args);
    res.json({ metas });
});

app.get("/:rd_api/stream/:type/:id.json", async (req, res) => {
    const streams = await handleStream(req.params.id, req.params.rd_api);
    res.json({ streams });
});

const port = process.env.PORT || 7000;
app.listen(port, () => console.log(`Addon listening on port ${port}`));
