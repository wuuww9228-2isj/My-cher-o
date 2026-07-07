const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

// Unfiltered Global Categories for All Content Types
const GENRES = [
    "All Content", "Action", "Animation", "Comedy", "Drama", 
    "Horror", "Sci-Fi", "Thriller", "Unrated", "Adult & More"
];

const manifest = {
    id: "community.unfilteredtorrent.rd",
    version: "5.0.0",
    name: "Pure & Unfiltered Torrent Explorer",
    description: "100% Uncensored, unrestricted torrent catalogs directly from global indexers, sorted by latest. Powered by Real-Debrid.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "solid_"],
    catalogs: [
        {
            type: "movie",
            id: "pure_unfiltered_movies",
            name: "🔞 Unfiltered Torrents (Latest)",
            extra: [
                { name: "search", isRequired: false },
                { name: "genre", options: GENRES, isRequired: false }
            ]
        }
    ],
    configurable: true,
    config: [
        {
            key: "rd_api",
            type: "text",
            title: "Real-Debrid API Key",
            required: true
        }
    ]
};

const builder = new addonBuilder(manifest);

// ==========================================
// [1] DIRECT RAW TORRENT CATALOG HANDLER (NO FILTERS)
// ==========================================
builder.defineCatalogHandler(async (args) => {
    let searchQuery = "all"; // Default query to fetch absolutely everything

    // If a specific genre tag is selected
    if (args.extra && args.extra.genre && args.extra.genre !== "All Content") {
        searchQuery = args.extra.genre.toLowerCase();
    }

    // Direct raw global text search into the torrent indexers (No content censorship)
    if (args.extra && args.extra.search) {
        searchQuery = args.extra.search;
    }

    // Querying the global unfiltered database strictly sorted by the exact upload date
    let url = `https://solidtorrents.net/api/v1/search?q=${encodeURIComponent(searchQuery)}&sort=date&limit=30`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data && data.results) {
            const metas = data.results.map(torrent => {
                const titleText = torrent.title || "Unknown Torrent";
                const fallbackPoster = `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent(titleText.substring(0, 25))}&theme=dark`;

                return {
                    id: `solid_${torrent.infoHash}`,
                    type: args.type,
                    name: titleText,
                    poster: fallbackPoster,
                    description: `Category: ${torrent.category || "General"} | Size: ${(torrent.size / (1024 * 1024 * 1024)).toFixed(2)} GB\nUploaded: ${new Date(torrent.createdAt).toLocaleString()}`,
                    releaseInfo: `${new Date(torrent.createdAt).getFullYear()}`
                };
            });
            return { metas: metas };
        }
    } catch (err) {
        console.error("Unfiltered Catalog Error:", err);
    }

    return { metas: [] };
});

// ==========================================
// [2] STREAM RESOLVER VIA REAL-DEBRID
// ==========================================
builder.defineStreamHandler(async (args) => {
    const streamId = args.id;
    const rdApiKey = args.config && args.config.rd_api;

    if (!rdApiKey) {
        return { streams: [{ title: "⚠️ Real-Debrid API Key Missing", url: "" }] };
    }

    let torrents = [];

    try {
        if (streamId.startsWith("solid_")) {
            const infoHash = streamId.replace("solid_", "");
            const detailsRes = await fetch(`https://solidtorrents.net/api/v1/details?infoHash=${infoHash}`);
            const detailsData = await detailsRes.json();
            if (detailsData && detailsData.result) {
                torrents.push({
                    hash: detailsData.result.infoHash,
                    title: detailsData.result.title,
                    upload_date: detailsData.result.createdAt
                });
            }
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
            const titleName = torrent.title || "Torrent Stream";
            
            try {
                const rdAddResponse = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${rdApiKey}` },
                    body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${hash}` })
                });
                const rdAddData = await rdAddResponse.json();
                
                if (rdAddData.id) {
                    const torrentId = rdAddData.id;
                    await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${rdApiKey}` },
                        body: new URLSearchParams({ files: "all" })
                    });

                    const rdInfoResponse = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
                        headers: { "Authorization": `Bearer ${rdApiKey}` }
                    });
                    const rdInfoData = await rdInfoResponse.json();

                    if (rdInfoData.links && rdInfoData.links.length > 0) {
                        let selectedLink = rdInfoData.links[0];

                        const unrestrictResponse = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
                            method: "POST",
                            headers: { "Authorization": `Bearer ${rdApiKey}` },
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

            return {
                title: `🎬 [🌐 Torrent] | Newest 🆕\n${titleName}`,
                infoHash: hash
            };
        });

        const streams = await Promise.all(streamPromises);
        return { streams: streams.filter(s => s !== null) };

    } catch (error) {
        console.error("Stream resolver error:", error);
    }

    return { streams: [] };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
