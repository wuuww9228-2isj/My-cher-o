const fs = require("fs");
const cloudscraper = require("cloudscraper");

const mirrors = [
  "https://apibay.org",
  "https://tpb.party/apibay",
  "https://tpb23.ukpass.co/apibay"
];

const categories = {
  movie: 201,
  series: 205,
  video: 200,
  adult: 500
};

async function fetchCategory(mirror, catId) {
  const url = `${mirror}/q.php?q=&cat=${catId}`;
  const body = await cloudscraper.get(url);
  const data = JSON.parse(body);
  if (Array.isArray(data) && data[0]?.id !== "0") {
    return data.map(t => ({
      info_hash: t.info_hash,
      name: t.name,
      size: t.size,
      seeders: t.seeders,
      added: t.added,
      category: catId === 201 ? "movie" : catId === 205 ? "tv" : catId === 200 ? "video" : "adult"
    }));
  }
  return [];
}

(async () => {
  let allTorrents = [];
  try {
    if (fs.existsSync("torrents.json")) {
      const existing = JSON.parse(fs.readFileSync("torrents.json", "utf8"));
      allTorrents = existing.torrents || [];
    }
  } catch (e) {}

  for (const mirror of mirrors) {
    for (const [catName, catId] of Object.entries(categories)) {
      try {
        const results = await fetchCategory(mirror, catId);
        console.log(`${mirror} (${catName}): ${results.length} torrents`);
        for (const t of results) {
          if (!allTorrents.find(ex => ex.info_hash === t.info_hash)) {
            allTorrents.push(t);
          }
        }
      } catch (e) {
        console.log(`Failed ${mirror} ${catName}: ${e.message}`);
      }
    }
  }

  allTorrents.sort((a, b) => (b.added || 0) - (a.added || 0));
  allTorrents = allTorrents.slice(0, 5000);

  fs.writeFileSync("torrents.json", JSON.stringify({ updated: new Date().toISOString(), torrents: allTorrents }));
  console.log(`Saved ${allTorrents.length} torrents.`);
})();
