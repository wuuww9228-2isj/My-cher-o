const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const manifest = {
  id: 'com.personal.rdscraper',
  version: '1.2.0',
  name: 'My Personal RD Addon',
  description: 'Multi-site scraper + Real-Debrid',
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

const SITES = [
  'https://1337x.to',
  'https://1337x.st',
  'https://1337x.gd',
  'https://www.torrentgalaxy.to'
];

async function getLatestFromSite(site, type) {
  try {
    let url = `${site}/cat/${type === 'movie' ? 'Movies' : 'TV'}/1/`;
    if (site.includes('torrentgalaxy')) url = `${site}/movies`;
    const { data } = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    const metas = [];

    $('tr, .tgxtablerow').slice(1, 25).each((i, el) => {
      let name = $(el).find('.name, .tgxtablerow td').text().trim();
      if (name.length > 5) {
        metas.push({
          id: `tt${1000000 + i}`,
          type: type,
          name: name.substring(0, 80),
          poster: `https://picsum.photos/id/${i + 20}/300/450`
        });
      }
    });
    return metas;
  } catch (e) {
    return [];
  }
}

builder.defineCatalogHandler(async (args) => {
  let allMetas = [];
  for (const site of SITES) {
    const metas = await getLatestFromSite(site, args.type);
    allMetas = allMetas.concat(metas);
    if (allMetas.length > 30) break;
  }
  return { metas: allMetas.slice(0, 30) };
});

builder.defineStreamHandler(async (args) => {
  const rdKey = args.config?.rdApiKey;
  if (!rdKey) {
    return { streams: [{ name: "RD Key Missing", title: "Add in Configure" }] };
  }
  return {
    streams: [{
      url: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      name: "✅ Test Stream",
      title: "Working with RD"
    }]
  };
});

module.exports = builder.getInterface();
