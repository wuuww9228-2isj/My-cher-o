const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 7000;

// Middleware for CORS
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    next();
});

const manifest = {
    id: "community.rawstreamer.v9",
    version: "9.0.0",
    name: "Pure Raw Streamer",
    description: "Unfiltered torrent stream engine.",
    resources: ["catalog", "stream"],
    types: ["movie", "series", "other"],
    idPrefixes: ["tt", "raw_"],
    catalogs: [
        { type: "movie", id: "top_movies", name: "Movies", extra: [{ name: "search", isRequired: false }] },
        { type: "series", id: "top_series", name: "Series", extra: [{ name: "search", isRequired: false }] },
        { type: "other", id: "top_other", name: "Videos", extra: [{ name: "search", isRequired: false }] }
    ]
};

// Simplified Catalog Fetcher
async function getCatalog(type, query = "2026") {
    try {
        const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (!Array.isArray(data) || data[0].id === "0") return [];

        return data.slice(0, 20).map(item => ({
            id: `raw_${item.info_hash}`,
            type: type,
            name: item.name,
            poster: "https://i.imgur.com/8UiM2vu.png" // Placeholder
        }));
    } catch (e) {
        return [];
    }
}

app.get("/manifest.json", (req, res) => res.json(manifest));
app.get("/:rd_api/manifest.json", (req, res) => res.json(manifest));

app.get("/:rd_api/catalog/:type/:id/:extra?.json", async (req, res) => {
    const { type } = req.params;
    const search = req.query.search || "2026";
    const metas = await getCatalog(type, search);
    res.json({ metas });
});

app.get("/:rd_api/stream/:type/:id.json", async (req, res) => {
    const hash = req.params.id.replace("raw_", "");
    res.json({
        streams: [{
            title: "Play via Real-Debrid",
            url: `https://api.real-debrid.com/rest/1.0/torrents/addMagnet?hash=${hash}` // Note: Logic handled by RD
        }]
    });
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
