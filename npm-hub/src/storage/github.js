const https = require('https');
const StorageBase = require('./base');
const path = require('path');

class GithubStorage extends StorageBase {
  constructor(config) {
    super(`github:${config.owner}/${config.repo}`, `GitHub: ${config.owner}/${config.repo}`, '🐙');
    this.config = config;
    this.owner = config.owner;
    this.repo = config.repo;
    this.token = config.token;
    this.branch = config.branch || 'main';
  }

  _request(options) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async _api(method, urlPath, body) {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${this.owner}/${this.repo}${urlPath}`,
      method,
      headers: {
        'User-Agent': 'NPM-Hub',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    if (this.token) options.headers['Authorization'] = `token ${this.token}`;
    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }
    return this._request(options);
  }

  async list(dirPath) {
    const dir = dirPath === '/' ? '' : dirPath.replace(/^\//, '');
    const res = await this._api('GET', `/contents/${dir}?ref=${this.branch}`);
    if (!Array.isArray(res)) return { path: dirPath, items: [], parent: '/' };
    const items = res.map(f => ({
      name: f.name,
      isDir: f.type === 'dir',
      path: dirPath === '/' ? `/${f.name}` : `${dirPath}/${f.name}`,
      size: f.size || 0
    }));
    return { path: dirPath, items, parent: dirPath === '/' ? null : path.dirname(dirPath) };
  }

  async read(filePath) {
    const file = filePath.replace(/^\//, '');
    const res = await this._api('GET', `/contents/${file}?ref=${this.branch}`);
    if (res.content) return Buffer.from(res.content, 'base64').toString('utf-8');
    throw new Error('File not found or cannot be read');
  }

  async write(filePath, content) {
    const file = filePath.replace(/^\//, '');
    const body = JSON.stringify({
      message: `Update ${file}`,
      content: Buffer.from(content).toString('base64'),
      branch: this.branch
    });
    return this._api('PUT', `/contents/${file}`, body);
  }

  async mkdir(dirPath) {
    const dir = dirPath.replace(/^\//, '');
    const body = JSON.stringify({
      message: `Create directory ${dir}`,
      content: '',
      branch: this.branch
    });
    return this._api('PUT', `/contents/${dir}`, body);
  }

  async delete(filePath) {
    const file = filePath.replace(/^\//, '');
    const res = await this._api('GET', `/contents/${file}?ref=${this.branch}`);
    return this._api('DELETE', `/contents/${file}`, JSON.stringify({
      message: `Delete ${file}`,
      sha: res.sha,
      branch: this.branch
    }));
  }

  async getInfo() {
    const res = await this._api('GET', '');
    return {
      id: this.id,
      name: `GitHub: ${this.owner}/${this.repo}`,
      icon: '🐙',
      description: res.description || '',
      stars: res.stargazers_count || 0,
      language: res.language || ''
    };
  }
}

module.exports = GithubStorage;
