const https = require('https');
const http = require('http');
const StorageBase = require('./base');
const path = require('path');

class WebDavStorage extends StorageBase {
  constructor(config) {
    super(`webdav:${config.url}`, config.name || `WebDAV: ${config.url}`, '📁');
    this.config = config;
    this.url = config.url.replace(/\/$/, '');
    this.user = config.user || '';
    this.pass = config.pass || '';
  }

  _request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const fullUrl = `${this.url}${urlPath}`;
      const parsed = new URL(fullUrl);
      const mod = parsed.protocol === 'https:' ? https : http;
      const auth = this.user ? Buffer.from(`${this.user}:${this.pass}`).toString('base64') : null;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          'User-Agent': 'NPM-Hub',
          'Depth': '1'
        }
      };
      if (auth) options.headers['Authorization'] = `Basic ${auth}`;
      if (body) {
        options.headers['Content-Type'] = 'application/xml';
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = mod.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async list(dirPath) {
    const body = `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><displayname/></prop></propfind>`;
    const res = await this._request('PROPFIND', dirPath, body);
    const items = this._parsePropfind(res.data, dirPath);
    return { path: dirPath, items, parent: dirPath === '/' ? null : path.dirname(dirPath) };
  }

  _parsePropfind(xml, basePath) {
    const items = [];
    const responseRegex = /<d:response>([\s\S]*?)<\/d:response>/g;
    let match;
    while ((match = responseRegex.exec(xml)) !== null) {
      const block = match[1];
      const hrefMatch = block.match(/<d:href>([\s\S]*?)<\/d:href>/);
      if (!hrefMatch) continue;
      const href = decodeURIComponent(hrefMatch[1]);
      const name = href.split('/').filter(Boolean).pop();
      if (!name || href === basePath + '/' || href === basePath) continue;
      const isCollection = block.includes('<d:resourcetype><d:collection/>');
      items.push({
        name,
        isDir: isCollection,
        path: `${basePath === '/' ? '' : basePath}/${name}`,
        size: 0
      });
    }
    return items;
  }

  async read(filePath) {
    const res = await this._request('GET', filePath);
    return res.data;
  }

  async write(filePath, content) {
    await this._request('PUT', filePath, content);
    return { success: true };
  }

  async mkdir(dirPath) {
    await this._request('MKCOL', dirPath);
    return { success: true };
  }

  async delete(filePath) {
    await this._request('DELETE', filePath);
    return { success: true };
  }

  async rename(oldPath, newPath) {
    const body = `<?xml version="1.0"?><mv xmlns="DAV:"><href>${newPath}</href></mv>`;
    await this._request('MOVE', oldPath, body);
    return { success: true };
  }

  async getInfo() {
    return { id: this.id, name: this.name, icon: '📁', url: this.url };
  }
}

module.exports = WebDavStorage;
