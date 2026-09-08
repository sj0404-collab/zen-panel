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
    let b = null;
    switch (config.storageType) {
      case 'adb': b = new AdbStorage(config.deviceId); break;
      case 'ftp': b = new FtpStorage(config); break;
      case 'gdrive': b = new GDriveStorage(config); break;
      case 'github': b = new GithubStorage(config); break;
      case 'http': b = new HttpStorage(config); break;
      case 'webdav': b = new WebDavStorage(config); break;
    }
    // The map key is the one true id: backends invent their own (github
    // used owner/repo while the key held the display name), so lookups
    // missed and every browse silently showed the local disk instead.
    if (b) { b.id = id; b.config = b.config || config; this.backends.set(id, b); }
  }

  get(id) {
    const b = this.backends.get(id);
    if (!b) throw new Error(`unknown backend: ${id}`);
    return b;
  }

  exact(id) {
    return this.backends.get(id) || null;
  }

  listAll() {
    return Array.from(this.backends.entries()).map(([id, b]) => ({
      id, name: b.name, icon: b.icon, type: (b.config && b.config.storageType) || (id === 'local' ? 'local' : null)
    }));
  }

  async addStorage(config) {
    const id = `${config.storageType}-${Date.now().toString(36)}`;
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
