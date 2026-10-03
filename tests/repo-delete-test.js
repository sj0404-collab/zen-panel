// Deleting a repo: the type-to-confirm guard, driven for real.
//
// The complaint was "I type the name and nothing happens, the list still says
// 50". No request was ever sent, so nothing failed and nothing was logged — the
// button simply never lit up. Cause: the guard compared the typed text to
// `owner/repo` case sensitively, and every phone keyboard capitalises the first
// letter of each word, so what landed in the box was "Sj0404-collab/Zen-panel".
//
// These tests slice the actual functions out of the three clients and run them
// against a stub DOM, so the behaviour is checked, not the source text.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

const CLIENTS = ['mobile-app', 'desktop-app', 'git-app'];

// The guard and the modal opener, lifted verbatim out of the client.
function loadGuard(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'npm-hub', 'public', file + '.js'), 'utf8');
  const from = src.indexOf('function delrepoTyped(');
  const to = src.indexOf('async function confirmDeleteRepo', from);
  if (from < 0 || to < 0) return null;
  const els = {};
  const mk = () => ({ id: '', value: '', textContent: '', style: {}, disabled: false, focus() {}, classList: { add() {} } });
  const sandbox = {
    console,
    document: {
      getElementById: id => (id in els ? els[id] : (els[id] = mk())),
      querySelectorAll: () => [],
      createElement: mk
    },
    setTimeout: (f) => f(),
    fetch: async () => ({ json: async () => ({ success: true }) }),
    closeModal() {}, fmInfo() {}, bindModalBgs() {}, ghLoadRepos() {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src.slice(from, to), sandbox);
  return { open: sandbox.ghDeleteRepoModal, els, sandbox };
}

const FULL = 'sj0404-collab/zen-panel';

for (const client of CLIENTS) {
  const g = loadGuard(client);
  check(`${client}: the guard is present`, !!g);
  if (!g) continue;

  g.open(FULL);
  const btn = g.els['delrepo-btn'];
  const input = g.els['delrepo-confirm'];
  const verdict = g.els['delrepo-verdict'];
  check(`${client}: the button waits for a name`, btn.disabled === true);
  check(`${client}: the box starts empty and says what is expected`,
    input.value === '' && /ждём/.test(verdict.textContent), verdict.textContent);

  // The reported case: the keyboard capitalised it. This used to leave the
  // button grey for good.
  input.value = 'Sj0404-collab/Zen-panel';
  input.oninput.call(input);
  check(`${client}: a capitalised name is accepted`, btn.disabled === false);
  check(`${client}: and it says it matches`, /совпадает/.test(verdict.textContent), verdict.textContent);

  // The plain form still has to work — nothing was wrong with it.
  input.value = FULL;
  input.oninput.call(input);
  check(`${client}: the exact name works`, btn.disabled === false);

  // People paste the name out of the card, which is often the short one.
  input.value = 'zen-panel';
  input.oninput.call(input);
  check(`${client}: the bare repo name works`, btn.disabled === false);

  // A wrong name must still be refused, or the guard means nothing.
  for (const wrong of ['zen-pane', 'other/zen-panel', 'zen-panel-2', '']) {
    input.value = wrong;
    input.oninput.call(input);
    check(`${client}: "${wrong}" stays refused`, btn.disabled === true);
  }
  input.value = 'zen-pane';
  input.oninput.call(input);
  check(`${client}: a mismatch explains itself`, /не совпадает/.test(verdict.textContent), verdict.textContent);

  // A second repo must not inherit the first one's verdict.
  g.open('sj0404-collab/yomikai');
  check(`${client}: a new repo resets the box`,
    g.els['delrepo-confirm'].value === '' && g.els['delrepo-btn'].disabled === true);
  g.els['delrepo-confirm'].value = 'sj0404-collab/zen-panel';
  g.els['delrepo-confirm'].oninput.call(g.els['delrepo-confirm']);
  check(`${client}: the previous repo's name is refused for another one`,
    g.els['delrepo-btn'].disabled === true);
}

// The field itself has to stop the keyboard from doing this in the first place.
for (const page of ['mobile', 'git', 'desktop']) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'npm-hub', 'public', page + '.html'), 'utf8');
  const input = (html.match(/<input[^>]*id="delrepo-confirm"[^>]*>/) || [''])[0];
  check(`${page}.html: the field refuses autocapitalisation`,
    /autocapitalize="off"/.test(input) && /autocorrect="off"/.test(input) &&
    /autocomplete="off"/.test(input) && /spellcheck="false"/.test(input), input);
  check(`${page}.html: the field can say why it is still refused`,
    html.includes('id="delrepo-verdict"'));
}

// per_page=50 was a silent ceiling: at 51 repos the counter would sit at "50"
// again after every deletion, which is exactly what "it stayed 50" looks like.
for (const client of CLIENTS) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'npm-hub', 'public', client + '.js'), 'utf8');
  check(`${client}: the repo list is not capped at 50`,
    src.includes("/api/gh/repos?per_page=100") && !src.includes("/api/gh/repos?per_page=50"));
}

console.log(`REPO-DELETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);