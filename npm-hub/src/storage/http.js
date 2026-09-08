const https = require('https');
const http = require('http');
const StorageBase = require('./base');
const path = require('path');

class HttpStorage extends StorageBase {
  constructor(config) {
    super(`http:${config.url}`, config.name || `HTTP: ${config.url}`, '🌐');
    this.config = config;
    this.url = config.url.replace(/\/$/, '');
    this.auth = config.auth || null;
  }

  _fetch(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const headers = { 'User-Agent': 'NPM-Hub' };
      if (this.auth) headers['Authorization'] = this.auth;
      mod.get(url, { headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return this._fetch(res.headers.location).then(resolve).catch(reject);
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
      }).on('error', reject);
    });
  }

  async list(dirPath) {
    const url = `${this.url}${dirPath}`;
    const res = await this._fetch(url);
    const items = this._parseListing(res.data, dirPath);
    return { path: dirPath, items, parent: dirPath === '/' ? null : path.dirname(dirPath) };
  }

  _parseListing(html, basePath) {
    const items = [];
    const linkRegex = /href="([^"]+)"/g;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const name = decodeURIComponent(match[1]);
      if (name === '/' || name === '..' || name === '../') continue;
      if (name.startsWith('?')) continue;
      const cleanName = name.replace(/\/$/, '');
      const isDir = name.endsWith('/');
      items.push({
        name: cleanName,
        isDir,
        path: `${basePath === '/' ? '' : basePath}/${cleanName}`,
        size: 0
      });
    }
    return items;
  }

  async read(filePath) {
    const url = `${this.url}${filePath}`;
    const res = await this._fetch(url);
    return res.data;
  }

  async getInfo() {
    return { id: this.id, name: this.name, icon: '🌐', url: this.url };
  }
}

module.exports = HttpStorage;
