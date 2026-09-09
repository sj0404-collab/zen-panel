const fs = require('fs');
const path = require('path');
const os = require('os');
const LocalStorage = require('./local');
const AdbStorage = require('./adb');
const FtpStorage = require('./ftp');
const GDriveStorage = require('./gdrive');
const GithubStorage = require('./github');
const HttpStorage = require('./http');
const WebDavStorage = require('./webdav');

const HOME = os.homedir();
const STORAGE_FILE = path.join(HOME, '.npm-hub-storages.json');

class StorageManager {
  constructor() {
    this.backends = new Map();
    this.backends.set('local', new LocalStorage());
    this._loadSaved();
  }

  _loadSaved() {
    try {
      if (fs.existsSync(STORAGE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf-8'));
        for (const [id, entry] of Object.entries(data)) {
          this._addBackend(id, entry.config);
        }
      }
    } catch {}
  }

  _save() {
    const data = {};
    for (const [id, backend] of this.backends) {
      if (id === 'local') continue;
      data[id] = { config: backend.config || {} };
    }
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
  }

  _addBackend(id, config) {
    if (!config || !config.storageType) return;
    switch (config.storageType) {
      case 'adb': return this.backends.set(id, new AdbStorage(config.deviceId));
      case 'ftp': return this.backends.set(id, new FtpStorage(config));
      case 'gdrive': return this.backends.set(id, new GDriveStorage(config));
      case 'github': return this.backends.set(id, new GithubStorage(config));
      case 'http': return this.backends.set(id, new HttpStorage(config));
      case 'webdav': return this.backends.set(id, new WebDavStorage(config));
    }
  }

  get(id) {
    return this.backends.get(id) || this.backends.get('local');
  }

  listAll() {
    return Array.from(this.backends.values()).map(b => ({
      id: b.id, name: b.name, icon: b.icon
    }));
  }

  async addStorage(config) {
    const id = `${config.storageType}:${config.name || config.host || config.url || Date.now()}`;
    this._addBackend(id, config);
    this._save();
    return { success: true, id };
  }

  async removeStorage(id) {
    this.backends.delete(id);
    this._save();
    return { success: true };
  }

  async discoverDevices() {
    const devices = [];
    devices.push({ type: 'local', id: path.join(HOME, 'hub-work'), name: 'hub-work', icon: '📁' });
    // Local drives
    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        const ps = execSync('powershell -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name,Root,@{N=Free;E={$_.Free}},@{N=Used;E={$_.Used}} | ConvertTo-Json"', {
          stdio: 'pipe', timeout: 8000
        }).toString();
        let drives = JSON.parse(ps);
        if (!Array.isArray(drives)) drives = [drives];
        for (const d of drives) {
          const root = d.Root || (d.Name + ':\\');
          devices.push({ type: 'local', id: root, name: `${d.Name}: (${root})`, icon: '💾', free: d.Free || 0, used: d.Used || 0 });
        }
      } else {
        devices.push({ type: 'local', id: '/', name: 'Root (/)', icon: '💾' });
        devices.push({ type: 'local', id: HOME, name: 'Home', icon: '🏠' });
      }
    } catch {}

    // ADB devices
    try {
      const adbDevices = await AdbStorage.discover();
      for (const d of adbDevices) {
        devices.push({ type: 'adb', id: d.id, name: d.name, icon: '📱' });
      }
    } catch {}

    return devices;
  }
}

module.exports = StorageManager;
