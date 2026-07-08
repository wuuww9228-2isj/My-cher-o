const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const manifest = {
  id: 'com.personal.rdscraper',
  version: '1.0.1',
  name: 'My Personal RD Addon',
  description: 'Personal torrent scraper with Real-Debrid (Adult included)',
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

builder.defineCatalogHandler(async (args) => {
  return { metas: [] }; // Will add real catalogs later
});

builder.defineStreamHandler(async (args) => {
  const rdKey = args.config?.rdApiKey;
  if (!rdKey) {
    return { streams: [{ name: "Setup RD Key", title: "Configure your Real-Debrid API Key" }] };
  }
  return {
    streams: [
      {
        url: "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        name: "✅ Test RD Stream",
        title: "Works with your Real-Debrid"
      }
    ]
  };
});

module.exports = builder.getInterface();
