const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

const manifest = {
    id: "community.flexibletorrent.rd",
    version: "3.0.0",
    name: "Universal Torrent Explorer",
    description: "Multi-source torrent searcher (by ID or Name) sorted by latest. Powered by Real-Debrid.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "yts_", "bt_"],
    catalogs: [
        {
            type: "movie",
            id: "universal_movies",
            name: "🆕 Torrent Movies (Latest)",
            extra: [{ name: "search", isRequired: false }]
        },
        {
            type: "series",
            id: "universal_series",
            name: "🆕 Torrent Series (Latest)",
            extra: [{ name: "search", isRequired: false }]
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
// [1] CATALOG HANDLER (DISCOVER & TEXT SEARCH)
// ==========================================
builder.defineCatalogHandler(async (args) => {
    let type = args.type;
    let url = `https://v3-cinemeta.strem.io/catalog/${type}/top/skip=0.json`;

    if (args.extra && args.extra.search) {
        url = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(args.extra.search)}.json`;
    }

    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data && data.metas) {
            return { metas: data.metas };
        }
    } catch (err) {
        console.error("Catalog fetch error:", err);
    }

    return { metas: [] };
});

// ==========================================
// [2] FLEXIBLE STREAM HANDLER (ID & NAME SEARCH)
// ==========================================
builder.defineStreamHandler(async (args) => {
    const streamId = args.id;
    const rdApiKey = args.config && args.config.rd_api;

    if (!rdApiKey) {
        return { streams: [{ title: "⚠️ Real-Debrid API Key Missing", url: "" }] };
    }

    let torrents = [];
    
    try {
        // Source 1: If it's a standard IMDB ID (starts with tt)
        if (streamId.startsWith("tt")) {
            const cleanImdbId = streamId.split(":")[0];
            
            // Fetching from primary multi-source API using IMDB ID
            const resId = await fetch(`https://torrent-io.xyz/api/v1/search?imdb=${cleanImdbId}`);
            const dataId = await resId.json();
            if (dataId.results) torrents = torrents.concat(dataId.results);
            
            // Backup Source: Fetching from YTS directly using IMDB ID
            const resYts = await fetch(`https://yts.mx/api/v2/list_movies.json?query_term=${cleanImdbId}`);
            const dataYts = await resYts.json();
            if (dataYts.data && dataYts.data.movies && dataYts.data.movies[0]) {
                const ytsTorrents = dataYts.data.movies[0].torrents.map(t => ({
                    hash: t.hash,
                    title: `[YTS] ${dataYts.data.movies[0].title} ${t.quality} ${t.type}`,
                    upload_date: t.date_uploaded
                }));
                torrents = torrents.concat(ytsTorrents);
            }
        } 
        
        // Source 2: Fallback text search if IMDB fails or if it's a custom query ID
        if (torrents.length === 0) {
            // We fetch the name from Cinemeta to search by text globally across public indexers
            const cleanId = streamId.split(":")[0];
            const metaRes = await fetch(`https://v3-cinemeta.strem.io/meta/${args.type}/${cleanId}.json`);
            const metaData = await metaRes.json();
            
            if (metaData && metaData.meta && metaData.meta.name) {
                const searchQuery = metaData.meta.name;
                // Querying a global open-search API that scrapes by text query (PirateBay/1337x/SolidTorrents combined)
                const resText = await fetch(`https://solidtorrents.net/api/v1/search?q=${encodeURIComponent(searchQuery)}&sort=date`);
                const dataText = await resText.json();
                
                if (dataText.results) {
                    const mappedText = dataText.results.map(t => ({
                        hash: t.infoHash,
                        title: t.title,
                        upload_date: t.createdAt || new Date()
                    }));
                    torrents = torrents.concat(mappedText);
                }
            }
        }

        // ==========================================
        // [3] SORT & STREAM VIA REAL-DEBRID
        // ==========================================
        
        // Remove duplicates based on torrent hash
        const uniqueTorrents = Array.from(new Map(torrents.map(item => [item.hash || item.info_hash, item])).values());

        // Sort all aggregated torrents by latest upload date
        uniqueTorrents.sort((a, b) => new Date(b.upload_date) - new Date(a.upload_date));

        // Process top 8 results for optimal response time
        const topTorrents = uniqueTorrents.slice(0, 8);

        const streamPromises = topTorrents.map(async (torrent) => {
            const hash = torrent.info_hash || torrent.hash;
            const titleName = torrent.title || "Universal Stream";
            
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
                        
                        if (streamId.includes(":")) {
                            const parts = streamId.split(":");
                            const episode = parseInt(parts[2]);
                            if (rdInfoData.links[episode - 1]) {
                                selectedLink = rdInfoData.links[episode - 1];
                            }
                        }

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
                console.error("RD Error:", e);
            }

            return {
                title: `🎬 [🌐 Torrent] | Newest 🆕\n${titleName}`,
                infoHash: hash
            };
        });

        const streams = await Promise.all(streamPromises);
        return { streams: streams.filter(s => s !== null) };

    } catch (error) {
        console.error("Global handler error:", error);
    }

    return { streams: [] };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
