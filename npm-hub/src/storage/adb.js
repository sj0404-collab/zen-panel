const { execSync } = require('child_process');
const StorageBase = require('./base');
const path = require('path');

class AdbStorage extends StorageBase {
  constructor(deviceId) {
    super(`adb:${deviceId || 'default'}`, 'ADB Device', '📱');
    this.config = { deviceId };
    this.deviceId = deviceId || null;
  }

  // Device ids and paths reach the shell: whitelist the id, strip quoting
  // metachars from paths. Invalid ids throw instead of running adb wrongly.
  _safeId() {
    if (!this.deviceId) return null;
    if (/[^A-Za-z0-9_.:-]/.test(this.deviceId)) throw new Error('Bad ADB device id');
    return this.deviceId;
  }
  _safePath(p) {
    return String(p).replace(/["$`\\;\n\r]/g, '');
  }
  _cmd(c) {
    const id = this._safeId();
    const prefix = id ? `adb -s ${id}` : 'adb';
    return `${prefix} ${c}`;
  }

  async list(dirPath) {
    const cmd = this._cmd(`shell ls -la "${this._safePath(dirPath)}"`);
    const output = execSync(cmd, { stdio: 'pipe', timeout: 10000, encoding: 'utf-8' });
    const lines = output.trim().split('\n').filter(l => l.trim() && !l.startsWith('total'));
    const items = lines.map(l => {
      const parts = l.trim().split(/\s+/);
      const isDir = (parts[0] || '').startsWith('d');
      const name = parts.slice(isDir ? 7 : 8).join(' ');
      const fullPath = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;
      return { name, isDir, path: fullPath, size: isDir ? 0 : parseInt(parts[4] || 0) };
    }).filter(i => i.name && i.name !== '.' && i.name !== '..');
    return { path: dirPath, items, parent: dirPath === '/' ? null : dirPath.split('/').slice(0, -1).join('/') || '/' };
  }

  async read(filePath) {
    const tmpFile = `/tmp/adb_read_${Date.now()}`;
    execSync(this._cmd(`pull "${this._safePath(filePath)}" "${tmpFile}"`), { stdio: 'pipe', timeout: 30000 });
    const fs = require('fs');
    const content = fs.readFileSync(tmpFile, 'utf-8');
    fs.unlinkSync(tmpFile);
    return content;
  }

  async write(filePath, content) {
    const fs = require('fs');
    const tmpFile = `/tmp/adb_write_${Date.now()}`;
    fs.writeFileSync(tmpFile, content, 'utf-8');
    execSync(this._cmd(`push "${tmpFile}" "${this._safePath(filePath)}"`), { stdio: 'pipe', timeout: 30000 });
    fs.unlinkSync(tmpFile);
    return { success: true };
  }

  async mkdir(dirPath) {
    execSync(this._cmd(`shell mkdir -p "${this._safePath(dirPath)}"`), { stdio: 'pipe', timeout: 5000 });
    return { success: true };
  }

  async delete(filePath) {
    execSync(this._cmd(`shell rm -rf "${this._safePath(filePath)}"`), { stdio: 'pipe', timeout: 10000 });
    return { success: true };
  }

  async rename(oldPath, newPath) {
    execSync(this._cmd(`shell mv "${this._safePath(oldPath)}" "${this._safePath(newPath)}"`), { stdio: 'pipe', timeout: 5000 });
    return { success: true };
  }

  static async discover() {
    const devices = [];
    try {
      const output = execSync('adb devices -l', { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' });
      const lines = output.trim().split('\n').slice(1).filter(l => l.trim());
      for (const l of lines) {
        const parts = l.trim().split(/\s+/);
        if (parts[1] === 'device') {
          const info = parts.slice(2).join(' ');
          const model = info.match(/model:(\S+)/)?.[1] || parts[0];
          devices.push({ id: parts[0], name: model, type: 'phone', icon: '📱' });
        }
      }
    } catch {}
    return devices;
  }

  static async connectTcp(host, port) {
    if (!/^[A-Za-z0-9_.-]+$/.test(String(host || ''))) return { success: false, error: 'Bad host' };
    const p = /^\\d{1,5}$/.test(String(port || '')) ? port : 5555;
    try {
      execSync(`adb connect ${host}:${p}`, { stdio: 'pipe', timeout: 10000, encoding: 'utf-8' });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  static async disconnect(deviceId) {
    if (/[^A-Za-z0-9_.:-]/.test(String(deviceId || ''))) return { success: false, error: 'Bad device id' };
    try {
      execSync(`adb disconnect ${deviceId}`, { stdio: 'pipe', timeout: 5000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async getInfo() {
    let info = { id: this.id, name: this.name, icon: '📱' };
    try {
      const output = execSync(this._cmd('shell getprop ro.product.model'), { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' });
      info.model = output.trim();
    } catch {}
    try {
      const output = execSync(this._cmd('shell getprop ro.build.version.release'), { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' });
      info.androidVersion = output.trim();
    } catch {}
    try {
      const output = execSync(this._cmd('shell df /sdcard'), { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' });
      const parts = output.trim().split('\n')[1]?.split(/\s+/);
      if (parts) {
        info.totalSize = parseInt(parts[1]) * 1024;
        info.freeSize = parseInt(parts[3]) * 1024;
      }
    } catch {}
    return info;
  }
}

module.exports = AdbStorage;
