const fs = require("fs");
const fetch = require("node-fetch");

const sources = [
  {
    name: "TorrentProject",
    url: (cat) => `https://torrentproject.cc/api/v1/torrents?limit=100&search=${cat}`,
    parse: (json) => json.torrents?.map(i => ({
      info_hash: i.hash,
      name: i.title,
      size: i.size || 0,
      seeders: i.seeders || 0,
      added: i.uploaded || Math.floor(Date.now()/1000)
    })) || []
  },
  {
    name: "DHT",
    url: (cat) => `https://dht.lc/search?q=${cat}`,
    parse: (data) => Array.isArray(data) ? data.map(i => ({
      info_hash: i.info_hash,
      name: i.name,
      size: i.size || 0,
      seeders: i.seeders || 0,
      added: i.added || 0
    })) : []
  },
  {
    name: "TPB (apibay)",
    url: (cat) => `https://apibay.org/q.php?q=${cat}&cat=0`,
    parse: (data) => Array.isArray(data) && data[0]?.id !== "0" ? data.map(i => ({
      info_hash: i.info_hash,
      name: i.name,
      size: i.size,
      seeders: i.seeders,
      added: i.added
    })) : []
  }
];

const categories = {
  movie: "movies",
  series: "tv",
  video: "videos",
  adult: "xxx"
};

async function fetchAll() {
  let allTorrents = [];

  // Load existing list
  try {
    if (fs.existsSync("torrents.json")) {
      const old = JSON.parse(fs.readFileSync("torrents.json", "utf8"));
      allTorrents = old.torrents || [];
    }
  } catch (e) {}

  for (const source of sources) {
    for (const [cat, query] of Object.entries(categories)) {
      try {
        const url = source.url(query);
        console.log(`Trying ${source.name} (${cat}): ${url}`);
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const results = source.parse(json);
        console.log(`  -> ${results.length} torrents`);
        for (const t of results) {
          t.category = cat;
          if (!allTorrents.find(ex => ex.info_hash === t.info_hash)) {
            allTorrents.push(t);
          }
        }
      } catch (e) {
        console.log(`  -> Failed: ${e.message}`);
      }
    }
  }

  allTorrents.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  allTorrents = allTorrents.slice(0, 5000);

  // Always write a valid file (even if empty)
  fs.writeFileSync("torrents.json", JSON.stringify({
    updated: new Date().toISOString(),
    torrents: allTorrents
  }));
  console.log(`Saved ${allTorrents.length} torrents total.`);
}

// Catch any fatal error and still write an empty file
(async () => {
  try {
    await fetchAll();
  } catch (e) {
    console.error("Fatal error, writing empty torrents.json:", e.message);
    fs.writeFileSync("torrents.json", JSON.stringify({ updated: new Date().toISOString(), torrents: [] }));
  }
})();
