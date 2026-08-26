'use strict';
/**
 * GitHub REST helper used by github_* tools.
 * Lives next to zen-agent.js so a runner checkout does not depend on ../lib.
 */
const https = require('https');

class GitHubApi {
  constructor(tokenFn, repoFn) {
    this._tokenFn = tokenFn;
    this._repoFn = repoFn;
  }

  token() {
    const t = typeof this._tokenFn === 'function' ? this._tokenFn() : this._tokenFn;
    return String(t || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  }

  defaultRepo(args) {
    const fromArgs = args && (args.repo || args.repository || args.full);
    if (fromArgs) {
      return String(fromArgs).replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
    }
    const fromFn = typeof this._repoFn === 'function' ? this._repoFn() : this._repoFn;
    return String(fromFn || process.env.GITHUB_REPOSITORY || '').replace(/\.git$/i, '');
  }

  request(method, apiPath, body) {
    const token = this.token();
    if (!token) {
      return Promise.reject(new Error('Нет GitHub-токена. На Actions он уже есть как GITHUB_TOKEN — перезапустите агент. Не вставляйте PAT в чат.'));
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'User-Agent': 'zen-panel-agent',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.github.com',
        port: 443,
        path: apiPath,
        method,
        headers,
        timeout: 25000
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = raw;
          try { data = raw ? JSON.parse(raw) : null; } catch {}
          if (res.statusCode === 204) { resolve({ ok: true, status: 204 }); return; }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = (data && (data.message || data.error)) || raw.slice(0, 240) || ('HTTP ' + res.statusCode);
            reject(new Error(msg));
            return;
          }
          resolve(data);
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('GitHub API timeout')));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async myRepos() {
    const rows = await this.request('GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
    const list = Array.isArray(rows) ? rows : [];
    return {
      count: list.length,
      repos: list.map(r => ({
        full_name: r.full_name,
        private: !!r.private,
        description: r.description || '',
        default_branch: r.default_branch,
        updated_at: r.updated_at,
        html_url: r.html_url
      }))
    };
  }

  async repoInfo(args) {
    const repo = this.defaultRepo(args);
    if (!repo) throw new Error('Укажите repo как owner/name');
    const r = await this.request('GET', '/repos/' + repo);
    return {
      full_name: r.full_name, private: r.private, description: r.description,
      default_branch: r.default_branch, html_url: r.html_url,
      pushed_at: r.pushed_at, language: r.language
    };
  }

  async list(args) {
    const repo = this.defaultRepo(args);
    if (!repo) throw new Error('Укажите repo как owner/name');
    const p = encodeURI((args.path || args.dir || '').replace(/^\/+/, ''));
    const ref = args.ref || args.branch || '';
    const q = ref ? '?ref=' + encodeURIComponent(ref) : '';
    const data = await this.request('GET', `/repos/${repo}/contents/${p}${q}`);
    const items = Array.isArray(data) ? data : [data];
    return {
      repo, path: args.path || '',
      items: items.map(it => ({ name: it.name, path: it.path, type: it.type, size: it.size, sha: it.sha }))
    };
  }

  async readFile(args) {
    const repo = this.defaultRepo(args);
    const file = args.path || args.file;
    if (!repo || !file) throw new Error('Нужны repo и path');
    const ref = args.ref || args.branch || '';
    const q = ref ? '?ref=' + encodeURIComponent(ref) : '';
    const data = await this.request('GET', `/repos/${repo}/contents/${encodeURI(file)}${q}`);
    if (data.encoding === 'base64' && data.content) {
      const text = Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8');
      return { repo, path: data.path, sha: data.sha, size: data.size, content: text };
    }
    return { repo, path: data.path, sha: data.sha, download_url: data.download_url };
  }

  async writeFile(args) {
    const repo = this.defaultRepo(args);
    const file = args.path || args.file;
    if (!repo || !file) throw new Error('Нужны repo и path');
    const message = args.message || ('update ' + file);
    const branch = args.branch || args.ref;
    let sha;
    try {
      const cur = await this.request('GET', `/repos/${repo}/contents/${encodeURI(file)}${branch ? '?ref=' + encodeURIComponent(branch) : ''}`);
      sha = cur.sha;
    } catch {}
    const body = {
      message,
      content: Buffer.from(String(args.content || ''), 'utf8').toString('base64')
    };
    if (sha) body.sha = sha;
    if (branch) body.branch = branch;
    const data = await this.request('PUT', `/repos/${repo}/contents/${encodeURI(file)}`, body);
    return {
      repo, path: file,
      commit: data.commit && data.commit.sha,
      html_url: data.commit && data.commit.html_url
    };
  }

  async deleteFile(args) {
    const repo = this.defaultRepo(args);
    const file = args.path || args.file;
    if (!repo || !file) throw new Error('Нужны repo и path');
    const cur = await this.request('GET', `/repos/${repo}/contents/${encodeURI(file)}`);
    const data = await this.request('DELETE', `/repos/${repo}/contents/${encodeURI(file)}`, {
      message: args.message || ('delete ' + file),
      sha: cur.sha,
      branch: args.branch
    });
    return { repo, path: file, commit: data.commit && data.commit.sha };
  }

  async commitFiles(args) {
    const files = args.files || args.changes;
    if (!Array.isArray(files) || !files.length) throw new Error('Нужен files: [{path, content}]');
    const results = [];
    for (const f of files) {
      results.push(await this.writeFile({
        repo: args.repo, path: f.path, content: f.content,
        message: args.message || f.message, branch: args.branch
      }));
    }
    return { commits: results };
  }

  async search(args) {
    const repo = this.defaultRepo(args);
    const q = [args.q || args.query || '', repo ? 'repo:' + repo : ''].filter(Boolean).join(' ');
    const data = await this.request('GET', '/search/code?q=' + encodeURIComponent(q));
    return {
      total: data.total_count,
      items: (data.items || []).slice(0, 20).map(it => ({
        path: it.path, repo: it.repository && it.repository.full_name, html_url: it.html_url
      }))
    };
  }

  async commits(args) {
    const repo = this.defaultRepo(args);
    if (!repo) throw new Error('Укажите repo');
    const data = await this.request('GET', `/repos/${repo}/commits?per_page=${Math.min(30, Number(args.limit) || 15)}`);
    return {
      repo,
      commits: data.map(c => ({
        sha: c.sha.slice(0, 7), message: (c.commit && c.commit.message || '').split('\n')[0],
        author: c.commit && c.commit.author && c.commit.author.name, date: c.commit && c.commit.author && c.commit.author.date,
        html_url: c.html_url
      }))
    };
  }

  async branches(args) {
    const repo = this.defaultRepo(args);
    if (!repo) throw new Error('Укажите repo');
    const data = await this.request('GET', `/repos/${repo}/branches?per_page=50`);
    return { repo, branches: data.map(b => ({ name: b.name, sha: b.commit && b.commit.sha })) };
  }

  async createBranch(args) {
    const repo = this.defaultRepo(args);
    const name = args.name || args.branch;
    const from = args.from || args.sha || args.base;
    if (!repo || !name || !from) throw new Error('Нужны repo, name и from (sha или ветка)');
    let sha = from;
    if (!/^[0-9a-f]{40}$/i.test(from)) {
      const ref = await this.request('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(from)}`);
      sha = ref.object && ref.object.sha;
    }
    const data = await this.request('POST', `/repos/${repo}/git/refs`, { ref: 'refs/heads/' + name, sha });
    return { repo, ref: data.ref, sha: data.object && data.object.sha };
  }

  async pullRequest(args) {
    const repo = this.defaultRepo(args);
    if (!repo) throw new Error('Укажите repo');
    const data = await this.request('POST', `/repos/${repo}/pulls`, {
      title: args.title || 'PR',
      head: args.head,
      base: args.base || 'main',
      body: args.body || ''
    });
    return { number: data.number, html_url: data.html_url, title: data.title };
  }

  async runs(args) {
    const repo = this.defaultRepo(args);
    if (!repo) throw new Error('Укажите repo');
    const data = await this.request('GET', `/repos/${repo}/actions/runs?per_page=15`);
    return {
      repo,
      runs: (data.workflow_runs || []).map(r => ({
        id: r.id, name: r.name, status: r.status, conclusion: r.conclusion,
        html_url: r.html_url, created_at: r.created_at
      }))
    };
  }

  async dispatch(args) {
    const repo = this.defaultRepo(args);
    const wf = args.workflow || args.file;
    if (!repo || !wf) throw new Error('Нужны repo и workflow (имя файла yml)');
    await this.request('POST', `/repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/dispatches`, {
      ref: args.ref || args.branch || 'main',
      inputs: args.inputs || {}
    });
    return { ok: true, repo, workflow: wf };
  }
}

module.exports = { GitHubApi };
