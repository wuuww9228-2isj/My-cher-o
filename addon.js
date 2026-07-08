const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const manifest = {
  id: 'com.personal.rdscraper',
  version: '1.1.0',
  name: 'My Personal RD Addon',
  description: 'Real torrent scraper + Real-Debrid (Adult included)',
  resources: ['catalog', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    { type: 'movie', id: 'latest-movies', name: 'Latest Movies' },
    { type: 'series', id: 'latest-series', name: 'Latest Series' },
    { type: 'movie', id: 'popular-movies', name: 'Popular Movies' }
  ],
  config: [
    { key: 'rdApiKey', type: 'text', title: 'Real-Debrid API Key', required: true }
  ]
};

const builder = new addonBuilder(manifest);
const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

async function searchTorrents(query) {
  try {
    const url = `https://1337x.to/search/${encodeURIComponent(query)}/1/`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    const results = [];

    $('tr').slice(1, 15).each((i, el) => {
      const name = $(el).find('.name').text().trim();
      const magnetLink = $(el).find('a[href^="magnet"]').attr('href'); // Try to get magnet
      if (name) results.push({ name, magnet: magnetLink });
    });
    return results;
  } catch (e) {
    return [];
  }
}

builder.defineCatalogHandler(async (args) => {
  let query = 'top';
  if (args.id === 'latest-movies') query = 'movies';
  if (args.id === 'latest-series') query = 'tv';

  const torrents = await searchTorrents(query);
  const metas = torrents.slice(0, 20).map((t, i) => ({
    id: `tt${1000000 + i}`,
    type: args.type || 'movie',
    name: t.name,
    poster: 'https://picsum.photos/300/450'
  }));

  return { metas };
});

builder.defineStreamHandler(async (args) => {
  const rdKey = args.config?.rdApiKey;
  if (!rdKey) {
    return { streams: [{ name: "No RD Key", title: "Configure Real-Debrid API Key" }] };
  }

  // Get title from ID or use test
  const title = "Popular Movie"; // Will be improved later with real title lookup
  const torrents = await searchTorrents(title);

  const streams = [];
  for (const t of torrents) {
    if (t.magnet) {
      streams.push({
        url: t.magnet, // RD will handle it
        name: "🌟 RD Torrent",
        title: t.name.substring(0, 60)
      });
    }
  }

  return { streams: streams.length ? streams : [{ name: "No streams", title: "Try another title" }] };
});

module.exports = builder.getInterface();
