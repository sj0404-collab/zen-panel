class StorageBase {
  constructor(id, name, icon) {
    this.id = id;
    this.name = name;
    this.icon = icon;
  }

  async list(dirPath) { throw new Error('Not implemented'); }
  async read(filePath) { throw new Error('Not implemented'); }
  async write(filePath, content) { throw new Error('Not implemented'); }
  async mkdir(dirPath) { throw new Error('Not implemented'); }
  async delete(filePath) { throw new Error('Not implemented'); }
  async rename(oldPath, newPath) { throw new Error('Not implemented'); }
  async stat(filePath) { throw new Error('Not implemented'); }
  async getInfo() { return { id: this.id, name: this.name, icon: this.icon }; }
}

module.exports = StorageBase;
