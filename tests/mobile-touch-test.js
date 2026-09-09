// Stage Q: phone taps + touch scroll + default work folder. Plain node,
// no deps — greps the original-based files for the exact fixes.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/mobile.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/src/server.js'), 'utf8');
const mob = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/mobile-app.js'), 'utf8');
const desk = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/desktop-app.js'), 'utf8');
const mgr = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/src/storage/manager.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

// q1: every terminal/arrow button re-fires its own onclick on touchend
// (the original had bare preventDefault = dead buttons on phones).
const btns = [...html.matchAll(/<button[^>]*class="(?:tc-btn|arr-btn)[^"]*"[^>]*>/g)];
const paired = btns.filter(b => {
  const oc = (b[0].match(/onclick="([^"]+)"/) || [])[1];
  const ot = (b[0].match(/ontouchend="([^"]+)"/) || [])[1];
  return oc && ot && ot === 'event.preventDefault();' + oc;
});
check('q1 touchend re-fires onclick', btns.length === 15 && paired.length === 15,
  `${paired.length}/${btns.length}`);

// q2: no dead preventDefault-only handlers left.
check('q2 no bare preventDefault', !/ontouchend="event\.preventDefault\(\)"/.test(html));

// q3: long-press menu suppressed on terminal buttons.
check('q3 contextmenu guard', (html.match(/oncontextmenu="event\.preventDefault\(\)"/g) || []).length === 15);

// q4: terminal scrolls by touch swipe.
check('q4 viewport touch-action', html.includes('.term .xterm-viewport{touch-action:pan-x pan-y!important}'));

// q5: buttons don't select text / call out on touch.
check('q5 no-select css', html.includes('.tc-btn,.arr-btn{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}'));

// q6: server defines the work folder and creates it on boot.
check('q6 server workdir', server.includes("path.join(HOME, 'hub-work')") &&
  server.includes('fs.mkdirSync(WORK_DIR, { recursive: true })'));

// q7: /api/info exposes it.
check('q7 info exposes workDir', /workDir:\s*WORK_DIR/.test(server));

// q8: both file managers boot into the work folder.
check('q8 fm boots to workdir', mob.includes('fmBrowse(workDir || homeDir)') &&
  desk.includes('fmBrowse(workDir || homeDir)') &&
  mob.includes('if (infoR.workDir) workDir = infoR.workDir;') &&
  desk.includes('if (infoR.workDir) workDir = infoR.workDir;'));

// q9: hub-work is first in the devices list.
check('q9 workdir first device', /devices\.push\(\{ type: 'local', id: path\.join\(HOME, 'hub-work'\), name: 'hub-work'/.test(mgr));

console.log(`MOBILE-TOUCH: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
