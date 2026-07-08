const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const manifest = {
  id: 'com.personal.rdscraper',
  version: '1.1.1',
  name: 'My Personal RD Addon',
  description: 'Real scraping + Real-Debrid',
  resources: ['catalog', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    { type: 'movie', id: 'latest-movies', name: 'Latest Movies' },
    { type: 'series', id: 'latest-series', name: 'Latest Series' }
  ],
  config: [
    { key: 'rdApiKey', type: 'text', title: 'Real-Debrid API Key', required: true }
  ]
};

const builder = new addonBuilder(manifest);

async function getLatestTorrents(type) {
  try {
    const url = type === 'movie' ? 'https://1337x.to/cat/Movies/1/' : 'https://1337x.to/cat/TV/1/';
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    const metas = [];

    $('tr').slice(1, 30).each((i, el) => {
      const name = $(el).find('.name').text().trim();
      if (name) {
        metas.push({
          id: `tt${1000000 + i}`,
          type: type,
          name: name,
          poster: 'https://picsum.photos/id/' + (i + 10) + '/300/450'
        });
      }
    });
    return metas;
  } catch (e) {
    return [];
  }
}

builder.defineCatalogHandler(async (args) => {
  const metas = await getLatestTorrents(args.type);
  return { metas };
});

builder.defineStreamHandler(async (args) => {
  const rdKey = args.config?.rdApiKey;
  if (!rdKey) {
    return { streams: [{ name: "RD Key Missing", title: "Configure in add-on settings" }] };
  }

  // Test stream for now (real RD will be added next)
  return {
    streams: [
      {
        url: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        name: "✅ Test Stream (Working)",
        title: "Big Buck Bunny - RD Ready"
      }
    ]
  };
});

module.exports = builder.getInterface();
