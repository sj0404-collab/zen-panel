const https = require('https');
const fs = require('fs');
const path = require('path');
const StorageBase = require('./base');

class GDriveStorage extends StorageBase {
  constructor(config) {
    super('gdrive', 'Google Drive', '☁️');
    this.config = config;
    this.accessToken = config.accessToken;
    this.refreshToken = config.refreshToken;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
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
      hostname: 'www.googleapis.com',
      path: `/drive/v3${urlPath}`,
      method,
      headers: { 'Authorization': `Bearer ${this.accessToken}` }
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }
    return this._request(options);
  }

  async list(dirPath) {
    const folderId = dirPath === '/' ? 'root' : dirPath;
    const res = await this._api('GET', `/files?q='${folderId}' in parents&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=200&orderBy=name`);
    const items = (res.files || []).map(f => ({
      name: f.name,
      isDir: f.mimeType === 'application/vnd.google-apps.folder',
      path: f.id,
      size: parseInt(f.size || 0),
      mtime: f.modifiedTime
    }));
    return { path: folderId, items, parent: null };
  }

  async read(fileId) {
    const res = await this._api('GET', `/files/${fileId}?alt=media`);
    return typeof res === 'string' ? res : JSON.stringify(res);
  }

  async write(filePath, content) {
    const metadata = { name: path.basename(filePath), parents: [path.dirname(filePath)] };
    const boundary = '----NPMHub' + Date.now();
    const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--`;
    const options = {
      hostname: 'www.googleapis.com',
      path: '/upload/drive/v3/files?uploadType=multipart',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    return this._request(options);
  }

  async mkdir(dirPath) {
    const parent = path.dirname(dirPath);
    const name = path.basename(dirPath);
    const metadata = { name, mimeType: 'application/vnd.google-apps.folder', parents: parent === '/' ? ['root'] : [parent] };
    const options = {
      hostname: 'www.googleapis.com',
      path: '/drive/v3/files',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(metadata))
      }
    };
    return this._request(options);
  }

  async delete(fileId) {
    await this._api('DELETE', `/files/${fileId}`);
    return { success: true };
  }

  async rename(fileId, newName) {
    const body = JSON.stringify({ name: newName });
    const options = {
      hostname: 'www.googleapis.com',
      path: `/drive/v3/files/${fileId}`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    return this._request(options);
  }

  async getInfo() {
    return { id: 'gdrive', name: 'Google Drive', icon: '☁️' };
  }
}

module.exports = GDriveStorage;
