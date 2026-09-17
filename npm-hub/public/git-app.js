/* =========================================================================
 * git-app.js — страница «Git».
 * Локальный репозиторий + GitHub: репозитории, ветки, коммиты, workflow,
 * сборки, релизы, клонирование. Общее состояние и топбар — в bridge.js.
 * ========================================================================= */

let gitPathRef = '';
let ghRepos = [];
let ghCurrentRepo = null;
let ghCurrentPath = '';
let ghCurrentBranch = '';
let ghCloneFullName = '';
let ghCloneBranch = '';
let ghDeleteFullName = '';
let ghReleaseRepo = '';

function pageInit() {
  loadGit();
  ghLoadRepos();
}

// ===== GIT VIEW (локальный) =====
async function loadGit() {
  const pathEl = document.getElementById('git-path');
  if (gitPathRef && !pathEl.value) pathEl.value = gitPathRef;
  const q = pathEl.value.trim();
  const [st, df, lg, repos] = await Promise.all([
    fetch('/api/git/status' + (q ? '?path=' + encodeURIComponent(q) : '')).then(r => r.json()),
    fetch('/api/git/diff' + (q ? '?path=' + encodeURIComponent(q) : '')).then(r => r.json()),
    fetch('/api/git/log' + (q ? '?path=' + encodeURIComponent(q) : '')).then(r => r.json()),
    fetch('/api/git/repos').then(r => r.json())
  ]);
  if (!pathEl.value && repos && repos.repos && repos.repos[0]) pathEl.value = repos.repos[0];
  const repoEl = document.getElementById('git-repo');
  const stEl = document.getElementById('git-status');
  const dfEl = document.getElementById('git-diff');
  const lgEl = document.getElementById('git-log');
  if (!st.success) {
    if (stEl) stEl.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(st.error || 'нет данных') + '</div>';
    if (lgEl) lgEl.textContent = '';
    if (dfEl) dfEl.textContent = '';
    return;
  }
  gitPathRef = st.repo;
  if (repoEl) repoEl.textContent = st.repo + ' · ' + st.branch + (st.ahead ? ' · ' + st.ahead + ' ahead' : '') + (st.behind ? ' · ' + st.behind + ' behind' : '');
  if (stEl) stEl.innerHTML =
    (st.lastCommit ? '<div style="font-size:11px;color:var(--t2);margin-bottom:6px">' + escHtml(st.lastCommit) + '</div>' : '') +
    (st.files.length
      ? st.files.map(f => '<div class="git-file"><span class="git-code">' + escHtml(f.code) + '</span><span>' + escHtml(f.path) + '</span></div>').join('')
      : '<div style="color:var(--ok);font-size:12px">✓ Рабочее дерево чистое</div>');
  if (dfEl) dfEl.textContent = df.diff ? df.diff : '(нет изменений)';
  if (lgEl) lgEl.textContent = lg.log ? lg.log : '(нет коммитов)';
}

// ===== GITHUB REPO BROWSER =====
async function ghLoadRepos() {
  const grid = document.getElementById('gh-repos-grid');
  if (!grid) return;
  grid.innerHTML = '<div style="color:var(--t3);font-size:12px;grid-column:1/-1">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos?per_page=50');
    const d = await r.json();
    if (!d.success) { grid.innerHTML = '<div style="color:var(--err);font-size:12px;grid-column:1/-1">' + escHtml(d.error || 'ошибка') + '</div>'; return; }
    ghRepos = d.repos || [];
    document.getElementById('gh-repos-count').textContent = ghRepos.length + ' репозиториев';
    grid.innerHTML = ghRepos.map(r => `
      <div class="card" style="cursor:pointer;padding:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;cursor:pointer" onclick="ghOpenRepo('${escAttr(r.full_name)}')">
          <span style="font-size:14px">${r.private ? '🔒' : '📂'}</span>
          <span style="font-size:13px;font-weight:600;color:var(--acc)">${escHtml(r.full_name)}</span>
        </div>
        <div style="font-size:11px;color:var(--t2);margin-bottom:4px;min-height:28px;cursor:pointer" onclick="ghOpenRepo('${escAttr(r.full_name)}')">${escHtml(r.description || '(нет описания)')}</div>
        <div style="display:flex;gap:8px;font-size:10px;color:var(--t3);cursor:pointer" onclick="ghOpenRepo('${escAttr(r.full_name)}')">
          ${r.language ? '<span>' + escHtml(r.language) + '</span>' : ''}
          ${r.stargazers_count ? '<span>⭐ ' + r.stargazers_count + '</span>' : ''}
          <span>🌿 ${escHtml(r.default_branch)}</span>
          <span>${r.updated_at ? new Date(r.updated_at).toLocaleDateString('ru') : ''}</span>
        </div>
        <div class="gh-repo-actions" onclick="event.stopPropagation()">
          <button class="btn btn-sm gh-repo-btn-open" onclick="ghOpenInRepo('${escAttr(r.full_name)}','${escAttr(r.default_branch)}')" title="Клонировать и открыть в CLI-агенте">▶ Открыть в</button>
          <button class="btn btn-sm gh-repo-btn-dl" onclick="ghDownloadRepo('${escAttr(r.full_name)}')" title="Скачать zip-архив репозитория">📥 Скачать</button>
          <button class="btn btn-sm" onclick="ghDownloadReleaseModal('${escAttr(r.full_name)}')" title="Скачать файл из релиза по тегу">📦 Релиз</button>
          <button class="btn btn-sm gh-repo-btn-del" onclick="ghDeleteRepoModal('${escAttr(r.full_name)}')" title="Удалить репозиторий">🗑</button>
        </div>
      </div>
    `).join('');
  } catch (e) { grid.innerHTML = '<div style="color:var(--err);font-size:12px;grid-column:1/-1">' + escHtml(e.message) + '</div>'; }
}

async function ghOpenRepo(fullName) {
  ghCurrentRepo = fullName;
  ghCurrentPath = '';
  ghCurrentBranch = '';
  const section = document.getElementById('gh-repos-section');
  if (section) section.style.display = 'none';
  const detail = document.getElementById('gh-repo-detail');
  detail.style.display = 'block';
  document.getElementById('gh-repo-name').textContent = fullName;
  // Load repo info + contents
  try {
    const r = await fetch('/api/gh/repos/' + fullName);
    const d = await r.json();
    document.getElementById('gh-repo-desc').textContent = d.description || '';
    document.getElementById('gh-repo-name').innerHTML = escHtml(fullName) + (d.language ? ' <span style="font-size:11px;color:var(--t3);font-weight:400">' + escHtml(d.language) + '</span>' : '');
  } catch {}
  ghShowTab('contents', document.querySelector('.gh-tab'));
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function ghBackToList() {
  const section = document.getElementById('gh-repos-section');
  if (section) section.style.display = '';
  document.getElementById('gh-repo-detail').style.display = 'none';
  if (ghCurrentRepo) {
    const el = document.querySelector('#gh-repos-section');
    if (el) el.scrollIntoView({ block: 'start' });
  }
  ghCurrentRepo = null;
}

function ghShowTab(tab, btn) {
  document.querySelectorAll('.gh-tab').forEach(b => b.classList.remove('on'));
  if (btn) btn.classList.add('on');
  ['contents','branches','commits','workflows','runs','releases'].forEach(t => {
    const el = document.getElementById('gh-repo-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  if (!ghCurrentRepo) return;
  if (tab === 'contents') ghLoadContents();
  if (tab === 'branches') ghLoadBranches();
  if (tab === 'commits') ghLoadCommits();
  if (tab === 'workflows') ghLoadWorkflows();
  if (tab === 'runs') ghLoadRuns();
  if (tab === 'releases') ghLoadReleases();
}

async function ghLoadContents(path) {
  if (path !== undefined) ghCurrentPath = path;
  const el = document.getElementById('gh-repo-contents');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    // Get default branch if not set
    if (!ghCurrentBranch) {
      const repoInfo = await fetch('/api/gh/repos/' + ghCurrentRepo).then(r => r.json());
      ghCurrentBranch = repoInfo.default_branch || 'main';
    }
    let url = '/api/gh/repos/' + ghCurrentRepo + '/contents';
    if (ghCurrentPath) url += '?path=' + encodeURIComponent(ghCurrentPath);
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    const items = d.items || [];
    // Breadcrumb
    let breadcrumb = '<div style="margin-bottom:8px;font-size:12px"><span style="cursor:pointer;color:var(--acc)" onclick="ghLoadContents(\'\')">📁 корень</span>';
    if (ghCurrentPath) {
      const parts = ghCurrentPath.split('/');
      parts.forEach((p, i) => {
        const pth = parts.slice(0, i + 1).join('/');
        breadcrumb += ' / <span style="cursor:pointer;color:var(--acc)" onclick="ghLoadContents(\'' + escAttr(pth) + '\')">' + escHtml(p) + '</span>';
      });
    }
    breadcrumb += '</div>';
    // Sort: dirs first, then files
    items.sort((a, b) => (a.type === 'dir' ? -1 : 1) - (b.type === 'dir' ? -1 : 1));
    el.innerHTML = breadcrumb + items.map(it => {
      const icon = it.type === 'dir' ? '📁' : fileIcon(it.name);
      const click = it.type === 'dir' ? `ghLoadContents('${escAttr(it.path)}')` : `ghViewFile('${escAttr(it.path)}','${escAttr(it.sha)}')`;
      return `<div class="gh-file-row" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px;border:1px solid transparent;transition:all .1s" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''" onclick="${click}">
        <span>${icon}</span>
        <span style="flex:1;color:var(--t1)">${escHtml(it.name)}</span>
        <span style="font-size:10px;color:var(--t3)">${it.size ? formatSize(it.size) : ''}</span>
        ${it.type !== 'dir' ? `<div class="gh-file-actions" onclick="event.stopPropagation()">
          <button class="btn btn-sm" onclick="ghDownloadFile('${escAttr(ghCurrentRepo)}','${escAttr(it.path)}','${escAttr(ghCurrentBranch || 'main')}')" title="Скачать файл">📥</button>
          <button class="btn btn-sm gh-repo-btn-del" onclick="ghDeleteFile('${escAttr(ghCurrentRepo)}','${escAttr(it.name)}','${escAttr(it.path)}','${escAttr(it.sha || '')}')" title="Удалить файл">🗑</button>
        </div>` : ''}
      </div>`;
    }).join('');
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghViewFile(path, sha) {
  const el = document.getElementById('gh-repo-contents');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка файла...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/contents?path=' + encodeURIComponent(path));
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    // Decode base64 content if present
    let content = d.download_url ? '(ссылка на скачивание)' : '';
    if (d.download_url) {
      const fr = await fetch(d.download_url);
      content = await fr.text().catch(() => '(не удалось загрузить)');
    }
    el.innerHTML = `
      <div style="margin-bottom:8px;font-size:12px">
        <span style="cursor:pointer;color:var(--acc)" onclick="ghLoadContents('${escAttr(ghCurrentPath)}')">← Назад</span>
        <span style="margin-left:8px;font-weight:600">${escHtml(path)}</span>
        <span style="margin-left:8px;font-size:10px;color:var(--t3)">${formatSize(d.size || 0)}</span>
      </div>
      <pre style="background:var(--bg0);border:1px solid var(--bdr);border-radius:8px;padding:12px;font-size:11px;font-family:monospace;color:var(--t1);overflow:auto;max-height:500px;white-space:pre-wrap">${escHtml(content)}</pre>`;
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghLoadBranches() {
  const el = document.getElementById('gh-repo-branches');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/branches');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    el.innerHTML = (d.branches || []).map(b => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;font-size:12px;border:1px solid var(--bdr);margin-bottom:4px">
        <span>🌿</span>
        <span style="color:var(--acc)">${escHtml(b.name)}</span>
        <span style="font-size:10px;color:var(--t3);margin-left:auto;font-family:monospace">${b.sha || ''}</span>
      </div>
    `).join('') || '<div style="color:var(--t3);font-size:12px">Нет веток</div>';
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghLoadCommits() {
  const el = document.getElementById('gh-repo-commits');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/commits?per_page=30');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    el.innerHTML = (d.commits || []).map(c => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:6px;font-size:12px;border:1px solid var(--bdr);margin-bottom:4px">
        <span style="font-family:monospace;font-size:11px;color:var(--pur);min-width:50px">${escHtml(c.sha || '')}</span>
        <div style="flex:1">
          <div style="color:var(--t1)">${escHtml(c.message || '')}</div>
          <div style="font-size:10px;color:var(--t3);margin-top:2px">${escHtml(c.author || '')} · ${c.date ? new Date(c.date).toLocaleString('ru') : ''}</div>
        </div>
        ${c.html_url ? '<a href="' + escAttr(c.html_url) + '" target="_blank" style="font-size:10px;color:var(--acc);text-decoration:none;flex-shrink:0">↗</a>' : ''}
      </div>
    `).join('') || '<div style="color:var(--t3);font-size:12px">Нет коммитов</div>';
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghLoadWorkflows() {
  const el = document.getElementById('gh-repo-workflows');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/workflows');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    el.innerHTML = (d.workflows || []).map(w => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;font-size:12px;border:1px solid var(--bdr);margin-bottom:6px">
        <span style="font-size:16px">${w.state === 'active' ? '🟢' : '⚪'}</span>
        <div style="flex:1">
          <div style="color:var(--t1);font-weight:500">${escHtml(w.name)}</div>
          <div style="font-size:10px;color:var(--t3)">${escHtml(w.path)}</div>
        </div>
        <span class="tag ${w.state === 'active' ? 'tag-on' : 'tag-off'}">${escHtml(w.state)}</span>
        ${w.html_url ? '<a href="' + escAttr(w.html_url) + '" target="_blank" style="font-size:10px;color:var(--acc);text-decoration:none">↗</a>' : ''}
      </div>
    `).join('') || '<div style="color:var(--t3);font-size:12px">Нет workflow</div>';
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghLoadRuns() {
  const el = document.getElementById('gh-repo-runs');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/runs?per_page=20');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    el.innerHTML = (d.runs || []).map(run => {
      const icon = run.conclusion === 'success' ? '✅' : run.conclusion === 'failure' ? '❌' : run.status === 'in_progress' ? '🔄' : '⏳';
      return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;font-size:12px;border:1px solid var(--bdr);margin-bottom:6px">
        <span style="font-size:16px">${icon}</span>
        <div style="flex:1">
          <div style="color:var(--t1);font-weight:500">${escHtml(run.name)} #${run.run_number}</div>
          <div style="font-size:10px;color:var(--t3)">🌿 ${escHtml(run.head_branch || '')} · ${run.created_at ? new Date(run.created_at).toLocaleString('ru') : ''}</div>
        </div>
        <span class="tag ${run.conclusion === 'success' ? 'tag-on' : run.conclusion === 'failure' ? 'tag-off' : ''}">${escHtml(run.status)}${run.conclusion ? ' → ' + run.conclusion : ''}</span>
        ${run.html_url ? '<a href="' + escAttr(run.html_url) + '" target="_blank" style="font-size:10px;color:var(--acc);text-decoration:none">↗</a>' : ''}
        <button class="btn btn-sm" onclick="ghLoadArtifacts('${run.id}',this.parentElement)" title="Артефакты сборки">📦</button>
      </div>`;
    }).join('') || '<div style="color:var(--t3);font-size:12px">Нет сборок</div>';
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghLoadArtifacts(runId, container) {
  if (!ghCurrentRepo) return;
  const existing = container.querySelector('.gh-artifacts');
  if (existing) { existing.remove(); return; }
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/runs/' + runId + '/artifacts');
    const d = await r.json();
    const div = document.createElement('div');
    div.className = 'gh-artifacts';
    div.style.cssText = 'padding:6px 8px;margin-top:4px;background:var(--bg3);border-radius:6px;font-size:11px';
    if (d.artifacts && d.artifacts.length) {
      div.innerHTML = d.artifacts.map(a => `
        <div style="display:flex;align-items:center;gap:6px;padding:3px 0">
          <span>📄 ${escHtml(a.name)}</span>
          <span style="color:var(--t3)">${formatSize(a.size_in_bytes)}</span>
          <a href="/api/gh/repos/${escAttr(ghCurrentRepo)}/artifacts/${a.id}/download" class="btn btn-sm" style="margin-left:auto;text-decoration:none;font-size:10px" download>📥 Скачать</a>
        </div>
      `).join('');
    } else {
      div.innerHTML = '<div style="color:var(--t3)">Нет артефактов</div>';
    }
    container.appendChild(div);
  } catch {}
}

async function ghLoadReleases() {
  const el = document.getElementById('gh-repo-releases');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/releases');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    el.innerHTML = (d.releases || []).map(rel => `
      <div style="padding:10px;border-radius:8px;border:1px solid var(--bdr);margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:14px">📦</span>
          <span style="font-size:13px;font-weight:600;color:var(--t1)">${escHtml(rel.name || rel.tag_name)}</span>
          <span class="tag tag-on">${escHtml(rel.tag_name)}</span>
          ${rel.draft ? '<span class="tag tag-off">draft</span>' : ''}
          ${rel.prerelease ? '<span class="tag" style="color:var(--warn);background:rgba(210,153,34,.12)">pre-release</span>' : ''}
        </div>
        <div style="font-size:10px;color:var(--t3);margin-bottom:6px">${rel.created_at ? new Date(rel.created_at).toLocaleString('ru') : ''}</div>
        ${(rel.assets || []).map(a => `
          <div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px">
            <span>📄 ${escHtml(a.name)}</span>
            <span style="color:var(--t3)">${formatSize(a.size)}</span>
            <a href="${escAttr(a.browser_download_url)}" class="btn btn-sm" style="margin-left:auto;text-decoration:none;font-size:10px" download>📥 Скачать</a>
          </div>
        `).join('')}
      </div>
    `).join('') || '<div style="color:var(--t3);font-size:12px">Нет релизов</div>';
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

// ===== GITHUB REPO: CLONE + OPEN IN AGENT =====
async function ghOpenInRepo(fullName, defaultBranch) {
  ghCloneFullName = fullName;
  ghCloneBranch = defaultBranch || 'main';
  const btn = document.getElementById('clone-title');
  const info = document.getElementById('clone-repo-info');
  const dirInput = document.getElementById('clone-dir');
  const branchInput = document.getElementById('clone-branch');
  const status = document.getElementById('clone-status');
  const agents = document.getElementById('clone-agents');
  btn.textContent = '▶ Открыть репозиторий';
  info.textContent = fullName;
  dirInput.value = fullName.split('/')[1];
  branchInput.value = ghCloneBranch;
  status.textContent = '';
  // Load auto-approve state from the hub so the checkbox matches reality.
  try {
    const rr = await fetch('/api/auto-approve'); const dd = await rr.json();
    document.getElementById('clone-auto-approve').checked = !!dd.enabled;
  } catch {}
  // Show available agents (installed CLI tools)
  const installed = tools.filter(t => t.installed);
  const cells = installed.map(t => `
    <div class="newterm-tool" onclick="cloneAndOpen('${escAttr(fullName)}','${t.id}')">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color};width:26px;height:26px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:9px">${t.icon}</div>
      <div><div style="font-size:12px;font-weight:500">${t.name}</div></div>
    </div>`).join('');
  agents.innerHTML = cells + (installed.length ? '' : '<div style="color:var(--t3);font-size:11px;grid-column:1/-1">Нет установленных CLI-агентов. Сначала установи инструмент на вкладке Dashboard.</div>');
  bindModalBgs();
  document.getElementById('modal-clone').classList.add('on');
}

async function cloneAndOpen(fullName, toolId) {
  const branch = document.getElementById('clone-branch').value.trim() || 'main';
  const status = document.getElementById('clone-status');
  status.textContent = 'Клонирую ' + fullName + ' (' + branch + ')...';
  status.style.color = 'var(--warn)';
  try {
    const r = await fetch('/api/gh/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: fullName, branch })
    });
    const d = await r.json();
    if (!d.success) {
      status.textContent = '✗ ' + (d.error || 'не удалось клонировать');
      status.style.color = 'var(--err)';
      return;
    }
    status.textContent = '✓ Клонировано в ' + d.path + (d.pulled ? ' (обновлено)' : '');
    status.style.color = 'var(--ok)';
    // Persist and push the auto-approve toggle to the hub before the agent starts.
    const autoOn = document.getElementById('clone-auto-approve').checked;
    fetch('/api/auto-approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: autoOn }) }).catch(() => {});
    // Register path in history + last-dir
    await fetch('/api/path-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: d.path }) });
    if (!recentPaths.includes(d.path)) recentPaths.unshift(d.path);
    toolDirs[toolId] = d.path;
    await fetch('/api/last-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId, dir: d.path }) });
    setTimeout(() => {
      closeModal('modal-clone');
      openTermPage(toolId, d.path);
    }, 800);
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    status.style.color = 'var(--err)';
  }
}

// ===== GITHUB REPO: DOWNLOAD ZIP =====
function ghDownloadRepo(fullName) {
  dlNow('/api/gh/download-repo?full_name=' + encodeURIComponent(fullName), fullName.split('/')[1] + '.zip');
}

// ===== GITHUB REPO: DELETE =====
function ghDeleteRepoModal(fullName) {
  ghDeleteFullName = fullName;
  document.getElementById('delrepo-info').textContent = 'Вы уверены, что хотите удалить ' + fullName + '?';
  document.getElementById('delrepo-confirm').value = '';
  document.getElementById('delrepo-confirm').oninput = function() {
    document.getElementById('delrepo-btn').disabled = this.value.trim() !== fullName;
  };
  document.getElementById('delrepo-btn').disabled = true;
  bindModalBgs();
  document.getElementById('modal-delrepo').classList.add('on');
}

async function confirmDeleteRepo() {
  const btn = document.getElementById('delrepo-btn');
  btn.disabled = true;
  btn.textContent = 'Удаляю...';
  try {
    const r = await fetch('/api/gh/delete-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: ghDeleteFullName })
    });
    const d = await r.json();
    if (d.success) {
      closeModal('modal-delrepo');
      await fmInfo('Репозиторий ' + ghDeleteFullName + ' удалён.');
      ghLoadRepos();
    } else {
      await fmInfo('Ошибка: ' + (d.error || 'не удалось удалить'));
      btn.textContent = 'Удалить навсегда';
      btn.disabled = false;
    }
  } catch (e) {
    await fmInfo('Ошибка: ' + e.message);
    btn.textContent = 'Удалить навсегда';
    btn.disabled = false;
  }
}

// ===== GITHUB REPO: DELETE FILE =====
async function ghDeleteFile(fullName, fileName, filePath, sha) {
  if (!(await fmConfirm('Удалить файл «' + fileName + '» из ' + fullName + '?', 'Удалить'))) return;
  try {
    const r = await fetch('/api/gh/delete-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: fullName, path: filePath, branch: ghCurrentBranch || 'main' })
    });
    const d = await r.json();
    if (d.success) {
      await fmInfo('Файл удалён.');
      ghLoadContents();
    } else {
      await fmInfo('Ошибка: ' + (d.error || 'не удалось удалить'));
    }
  } catch (e) {
    await fmInfo('Ошибка: ' + e.message);
  }
}

// ===== GITHUB REPO: DOWNLOAD FILE =====
function ghDownloadFile(fullName, filePath, branch) {
  const ref = branch || ghCurrentBranch || 'main';
  dlNow('/api/gh/download-file?full_name=' + encodeURIComponent(fullName) + '&path=' + encodeURIComponent(filePath) + '&ref=' + encodeURIComponent(ref), filePath.split('/').pop());
}

// ===== GITHUB REPO: DOWNLOAD RELEASE ASSET =====
async function ghDownloadReleaseModal(fullName) {
  ghReleaseRepo = fullName;
  const list = document.getElementById('release-dl-list');
  list.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка релизов...</div>';
  bindModalBgs();
  document.getElementById('modal-release-dl').classList.add('on');
  try {
    const r = await fetch('/api/gh/repos/' + fullName + '/releases?per_page=10');
    const d = await r.json();
    if (d.releases && d.releases.length) {
      list.innerHTML = d.releases.map(rel => `
        <div style="padding:8px;border:1px solid var(--bdr);border-radius:8px;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-size:13px;font-weight:600;color:var(--t1)">${escHtml(rel.name || rel.tag_name)}</span>
            <span class="tag tag-on" style="font-size:9px">${escHtml(rel.tag_name)}</span>
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
            <a class="btn btn-sm btn-ok" style="text-decoration:none" href="/api/gh/download-release-asset?full_name=${encodeURIComponent(fullName)}&tag=${encodeURIComponent(rel.tag_name)}" download title="Исходники (tar.gz)">📦 Исходники</a>
            ${(rel.assets || []).map(a => `
              <a class="btn btn-sm" style="text-decoration:none" href="/api/gh/download-release-asset?full_name=${encodeURIComponent(fullName)}&tag=${encodeURIComponent(rel.tag_name)}&asset_id=${a.id}" download title="${escAttr(a.name)}">${escHtml(a.name)} (${formatSize(a.size)})</a>
            `).join('')}
          </div>
        </div>
      `).join('') || '<div style="color:var(--t3);font-size:12px">Релизов нет</div>';
    } else {
      list.innerHTML = '<div style="color:var(--t3);font-size:12px">Релизов нет</div>';
    }
  } catch (e) {
    list.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>';
  }
}