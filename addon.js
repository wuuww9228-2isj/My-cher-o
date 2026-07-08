const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const manifest = {
  id: 'com.personal.rdscraper',
  version: '2.0.0',
  name: 'My Personal RD Addon',
  description: 'Real-Debrid streaming + Multi-genre catalogs',
  resources: ['catalog', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    { type: 'movie', id: 'latest-movies', name: 'Latest Movies' },
    { type: 'series', id: 'latest-series', name: 'Latest Series' },
    { type: 'movie', id: 'action-movies', name: 'Action Movies' },
    { type: 'movie', id: 'adult-movies', name: 'Adult Movies' }
  ],
  config: [
    { key: 'rdApiKey', type: 'text', title: 'Real-Debrid API Key', required: true }
  ]
};

const builder = new addonBuilder(manifest);
const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

// Simple torrent search
async function searchTorrents(query) {
  try {
    const url = `https://1337x.to/search/${encodeURIComponent(query)}/1/`;
    const { data } = await axios.get(url, { timeout: 8000 });
    const $ = cheerio.load(data);
    const results = [];

    $('tr').slice(1, 10).each((i, el) => {
      const name = $(el).find('.name').text().trim();
      const magnet = $(el).find('a[href^="magnet:"]').attr('href');
      if (name && magnet) {
        results.push({ name, magnet });
      }
    });
    return results;
  } catch (e) {
    return [];
  }
}

// Real-Debrid streaming logic
async function getRdStreams(magnets, rdKey) {
  if (!magnets.length) return [];
  const streams = [];

  for (const item of magnets) {
    try {
      // Extract hash from magnet
      const hashMatch = item.magnet.match(/btih:([a-fA-F0-9]+)/);
      if (!hashMatch) continue;
      const hash = hashMatch[1].toLowerCase();

      // Check if cached on RD
      const check = await axios.post(
        `${RD_BASE}/torrents/instantAvailability/${hash}`,
        {},
        { headers: { Authorization: `Bearer ${rdKey}` } }
      );

      if (check.data && check.data[hash]) {
        // Cached! Get direct link
        const addTorrent = await axios.post(
          `${RD_BASE}/torrents/addMagnet`,
          `magnet=${encodeURIComponent(item.magnet)}`,
          { headers: { Authorization: `Bearer ${rdKey}` } }
        );

        const torrentId = addTorrent.data.id;

        // Select all files
        await axios.post(
          `${RD_BASE}/torrents/selectFiles/${torrentId}`,
          'files=all',
          { headers: { Authorization: `Bearer ${rdKey}` } }
        );

        // Get torrent info
        const info = await axios.get(`${RD_BASE}/torrents/info/${torrentId}`, {
          headers: { Authorization: `Bearer ${rdKey}` }
        });

        if (info.data.links && info.data.links.length > 0) {
          streams.push({
            url: info.data.links[0],
            name: `✅ RD Cached - ${item.name.substring(0, 50)}`,
            title: item.name
          });
        }
      }
    } catch (e) {
      // Not cached or error - skip
    }
  }
  return streams;
}

builder.defineCatalogHandler(async (args) => {
  // Use the genre data from previous version
  const GENRE_DATA = {
    'latest-movies': [{ id: 'tt0111161', name: 'The Shawshank Redemption', poster: 'https://picsum.photos/id/20/300/450' }],
    'latest-series': [{ id: 'tt0903747', name: 'Breaking Bad', poster: 'https://picsum.photos/id/201/300/450' }],
    'action-movies': [{ id: 'tt0468569', name: 'The Dark Knight', poster: 'https://picsum.photos/id/160/300/450' }],
    'adult-movies': [{ id: 'tt0111161', name: 'Adult Example', poster: 'https://picsum.photos/id/1005/300/450' }]
  };
  const data = GENRE_DATA[args.id] || GENRE_DATA['latest-movies'];
  return { metas: data.map(item => ({ ...item, type: args.type || 'movie' })) };
});

builder.defineStreamHandler(async (args) => {
  const rdKey = args.config?.rdApiKey;
  if (!rdKey) {
    return { streams: [{ name: "Add RD Key", title: "Configure in settings" }] };
  }

  // Search torrents for this title
  const title = "popular movie"; // Will be improved with real title later
  const torrents = await searchTorrents(title);
  const rdStreams = await getRdStreams(torrents, rdKey);

  if (rdStreams.length > 0) {
    return { streams: rdStreams };
  }

  // Fallback test stream
  return {
    streams: [{
      url: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      name: "✅ Test Stream",
      title: "Fallback test"
    }]
  };
});

module.exports = builder.getInterface();
