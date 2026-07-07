const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

const manifest = {
    id: "community.rawstreamer.rd",
    version: "6.0.0",
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
                { name: "search", isRequired: false }
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
// [1] HIGH-AVAILABILITY UNFILTERED CATALOG HANDLER
// ==========================================
builder.defineCatalogHandler(async (args) => {
    // Using an incredibly stable open scrapers array to fetch real-time raw torrent data
    let query = "latest";
    if (args.extra && args.extra.search) {
        query = args.extra.search;
    }

    // Direct open text pipeline that accepts adult keywords, movies, and unrated releases
    let url = `https://torrent-io.xyz/api/v1/search?imdb=tt0000000&q=${encodeURIComponent(query)}`; 
    
    if (query === "latest") {
        // Fallback to absolute raw global dumping grounds if no active search
        url = `https://torrent-io.xyz/api/v1/search?imdb=tt1111111`; 
    }

    try {
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await response.json();

        if (data && data.results && data.results.length > 0) {
            // Sort by absolute newest timestamp first
            const sortedResults = data.results.sort((a, b) => new Date(b.upload_date || 0) - new Date(a.upload_date || 0));

            const metas = sortedResults.map(torrent => {
                const titleText = torrent.title || "Uncensored Torrent Pack";
                const hash = torrent.info_hash || torrent.hash;
                const fallbackPoster = `https://images.placeholders.dev/?width=300&height=450&text=${encodeURIComponent(titleText.substring(0, 22))}&theme=dark`;

                return {
                    id: `raw_${hash}`,
                    type: "movie",
                    name: titleText,
                    poster: fallbackPoster,
                    description: `Seeds: ${torrent.seeders || 0} | Uploaded: ${torrent.upload_date || "Just Now"}\nHash: ${hash}`,
                    releaseInfo: "LIVE"
                };
            });
            return { metas: metas };
        }
    } catch (err) {
        console.error("High-Avail Catalog Error, trying fallback standard catalog...", err);
    }

    // Ironclad Backup Source: If the dynamic scrapper takes a hit, populate with stable high-volume trending releases
    try {
        const fallbackRes = await fetch("https://v3-cinemeta.strem.io/catalog/movie/top.json");
        const fallbackData = await fallbackRes.json();
        if (fallbackData && fallbackData.metas) return { metas: fallbackData.metas.slice(0, 20) };
    } catch (e) {
        console.error("Critical fallback failure:", e);
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
        if (streamId.startsWith("raw_")) {
            const hash = streamId.replace("raw_", "");
            // Standardizing properties to pass directly to Real Debrid link-unrestrict pipeline
            torrents.push({
                hash: hash,
                title: "Selected Raw Video Stream"
            });
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
                        const selectedLink = rdInfoData.links[0];

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
