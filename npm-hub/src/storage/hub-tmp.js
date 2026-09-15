// One shared temporary directory for the whole hub: ~/.npm-hub/tmp.
// Nothing touches the OS /tmp, which is invisible to CLI agents and may be
// wiped by the machine. Call hubTmp() to get the (already created) path.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HUB_TMP = path.join(os.homedir(), '.npm-hub', 'tmp');
try { fs.mkdirSync(HUB_TMP, { recursive: true }); } catch {}

module.exports = () => HUB_TMP;