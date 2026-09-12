const fs = require('fs');
const path = require('path');
const StorageBase = require('./base');

class LocalStorage extends StorageBase {
  constructor() {
    super('local', 'Local', '💻');
  }

  async list(dirPath) {
    const resolved = path.resolve(dirPath);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) throw new Error('Not a directory');
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      if (entry.name.startsWith('.') && entry.name !== '..') continue;
      const fullPath = path.join(resolved, entry.name);
      let isDir = false, size = 0, mtime = null;
      try {
        if (entry.isDirectory()) isDir = true;
        else { const s = fs.statSync(fullPath); size = s.size; mtime = s.mtime; }
      } catch {}
      items.push({ name: entry.name, path: fullPath, isDir, size, mtime });
    }
    items.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });
    return { path: resolved, items, parent: path.dirname(resolved) };
  }

  async read(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
  }

  async write(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  }

  async mkdir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return { success: true };
  }

  async delete(filePath) {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
    else fs.unlinkSync(filePath);
    return { success: true };
  }

  async rename(oldPath, newPath) {
    fs.renameSync(oldPath, newPath);
    return { success: true };
  }

  async stat(filePath) {
    const s = fs.statSync(filePath);
    return { isDir: s.isDirectory(), size: s.size, mtime: s.mtime };
  }
}

module.exports = LocalStorage;
