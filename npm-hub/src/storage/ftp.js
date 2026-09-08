const { execSync } = require('child_process');
const StorageBase = require('./base');
const path = require('path');

class FtpStorage extends StorageBase {
  constructor(config) {
    super(`ftp:${config.host}`, config.name || `FTP: ${config.host}`, '📂');
    this.config = config;
    if (!config.host || /[\s'"`$;&|<>()\\]/.test(String(config.host))) throw new Error('Bad FTP host');
    const port = parseInt(config.port || '21', 10);
    if (!port || port < 1 || port > 65535) throw new Error('Bad FTP port');
    this.host = config.host;
    this.port = port;
    this.user = config.user || 'anonymous';
    this.pass = config.pass || '';
    this.protocol = config.protocol || 'ftp'; // ftp or sftp
  }

  _q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  _qp(p) { return String(p).replace(/["$`\\;\n\r]/g, ''); }

  _curl(args) {
    const auth = this.user !== 'anonymous' ? `-u ${this._q(this.user + ':' + this.pass)}` : '';
    return `curl -s --max-time 15 ${auth} ${args}`;
  }

  async list(dirPath) {
    const url = `${this.protocol}://${this.host}:${this.port}${this._qp(dirPath)}`;
    const cmd = this._curl(`"${url}"`);
    const output = execSync(cmd, { stdio: 'pipe', timeout: 20000, encoding: 'utf-8' });
    const items = this._parseListing(output, dirPath);
    return { path: dirPath, items, parent: dirPath === '/' ? null : path.dirname(dirPath) };
  }

  _parseListing(output, basePath) {
    const items = [];
    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(/^d\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\w+\s+\d+\s+[\d:]+\s+(.+)$/);
      if (match) {
        const name = match[2].trim();
        if (name === '.' || name === '..') continue;
        items.push({ name, isDir: true, path: `${basePath === '/' ? '' : basePath}/${name}`, size: 0 });
        continue;
      }
      const fileMatch = line.match(/^-\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\w+\s+\d+\s+[\d:]+\s+(.+)$/);
      if (fileMatch) {
        const name = fileMatch[2].trim();
        items.push({ name, isDir: false, path: `${basePath === '/' ? '' : basePath}/${name}`, size: parseInt(fileMatch[1]) });
      }
    }
    return items;
  }

  async read(filePath) {
    const url = `${this.protocol}://${this.host}:${this.port}${this._qp(filePath)}`;
    const cmd = this._curl(`"${url}"`);
    return execSync(cmd, { stdio: 'pipe', timeout: 30000, encoding: 'utf-8' });
  }

  async write(filePath, content) {
    const fs = require('fs');
    const tmpFile = `/tmp/ftp_write_${Date.now()}`;
    fs.writeFileSync(tmpFile, content, 'utf-8');
    const url = `${this.protocol}://${this.host}:${this.port}${this._qp(filePath)}`;
    const auth = this.user !== 'anonymous' ? `-u ${this._q(this.user + ':' + this.pass)}` : '';
    execSync(`curl -s --max-time 30 ${auth} -T "${tmpFile}" "${url}"`, { stdio: 'pipe', timeout: 35000 });
    fs.unlinkSync(tmpFile);
    return { success: true };
  }

  async mkdir(dirPath) {
    const url = `${this.protocol}://${this.host}:${this.port}${this._qp(dirPath)}`;
    const auth = this.user !== 'anonymous' ? `-u ${this._q(this.user + ':' + this.pass)}` : '';
    execSync(`curl -s --max-time 10 ${auth} --ftp-create-dirs -X MKD "${url}"`, { stdio: 'pipe', timeout: 15000 });
    return { success: true };
  }

  async delete(filePath) {
    const url = `${this.protocol}://${this.host}:${this.port}${this._qp(filePath)}`;
    const auth = this.user !== 'anonymous' ? `-u ${this._q(this.user + ':' + this.pass)}` : '';
    execSync(`curl -s --max-time 10 ${auth} -X DELE "${url}"`, { stdio: 'pipe', timeout: 15000 });
    return { success: true };
  }

  async rename(oldPath, newPath) {
    const url = `${this.protocol}://${this.host}:${this.port}`;
    const auth = this.user !== 'anonymous' ? `-u ${this._q(this.user + ':' + this.pass)}` : '';
    execSync(`curl -s --max-time 10 ${auth} -Q "RNFR ${this._qp(oldPath)}" -Q "RNTO ${this._qp(newPath)}" "${url}"`, { stdio: 'pipe', timeout: 15000 });
    return { success: true };
  }

  async getInfo() {
    return { id: this.id, name: this.name, icon: '📂', host: this.host, port: this.port };
  }
}

module.exports = FtpStorage;
