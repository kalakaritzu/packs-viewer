const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell, Menu, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const AUDIO = new Set(['.wav', '.aif', '.aiff', '.flac', '.mp3', '.ogg']);
const DEFAULT_ROOT = path.join('C:\\Users\\Alexander\\Music\\FL Studio\\Packs');

let win;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const cacheFile = () => path.join(app.getPath('userData'), 'index-cache.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s)); } catch {}
}
function getRoot() {
  const s = loadSettings();
  if (s.root && fs.existsSync(s.root)) return s.root;
  if (fs.existsSync(DEFAULT_ROOT)) return DEFAULT_ROOT;
  return path.join(app.getPath('music'), 'FL Studio', 'Packs');
}

// ---------- metadata parsing ----------
const TYPE_RULES = [
  ['FX', /(^|[^a-z])(fx|sfx|riser|risers|uplifter|downlifter|lifter|impact|impacts|sweep|sweeps|swell|transition|whoosh)([^a-z]|$)/],
  ['Kick', /(^|[^a-z])(kicks?|bd|bassdrum)([^a-z]|$)/],
  ['Snare', /(^|[^a-z])(snares?|snr|rimshots?)([^a-z]|$)/],
  ['Clap', /(^|[^a-z])(claps?|clp|snaps?)([^a-z]|$)/],
  ['Hi-Hat', /(^|[^a-z])((open|closed|hi)-?hats?|hats?|hh|ohh|chh)([^a-z]|$)/],
  ['Cymbal', /(^|[^a-z])(cymbals?|crash|crashes|ride|rides)([^a-z]|$)/],
  ['Tom', /(^|[^a-z])(toms?)([^a-z]|$)/],
  ['Shaker', /(^|[^a-z])(shakers?|tambourines?|tambs?)([^a-z]|$)/],
  ['Perc', /(^|[^a-z])(perc|percs|percussions?|congas?|bongos?|rims?|woodblocks?|cowbells?|clave)([^a-z]|$)/],
  ['Drum Loop', /break[ -]?chops?/],
  ['Vocal', /(^|[^a-z])(vocals?|vocoded|vocoder|vox|voice|chops?|acapella|adlibs?)([^a-z]|$)/],
  ['Drum Loop', /(^|[^a-z])(breakbeats?|breaks?|amen|drum ?loops?|fills?|top ?loops?)([^a-z]|$)/],
  ['808 / Bass', /(^|[^a-z])(808s?|bass|sub|bassline|reese)([^a-z]|$)/],
  ['Synth', /(^|[^a-z])(synths?|leads?|plucks?|arps?|chords?|pads?|melody|melodies|keys|piano|stabs?|guitar)([^a-z]|$)/],
  ['FX', /(^|[^a-z])(noise|atmos?|ambience|texture|glitch)([^a-z]|$)/],
];
const NOTE_FLAT = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

function classify(name, folders) {
  const n = name.toLowerCase();
  for (const [t, re] of TYPE_RULES) if (re.test(n)) return t;
  for (let i = folders.length - 1; i >= 0; i--) {
    const f = folders[i].toLowerCase();
    for (const [t, re] of TYPE_RULES) if (re.test(f)) return t;
  }
  return 'Other';
}

function parseBpm(name) {
  let m = name.match(/(\d{2,3}(?:\.\d+)?)\s?bpm/i);
  if (m) { const v = Math.round(parseFloat(m[1])); if (v >= 50 && v <= 220) return v; }
  m = name.match(/[_\- ](\d{2,3})(?=[_\s]|$)/);
  if (m && /(loop|amen|break|perc|_\d{2,3}_)/i.test(name + '_')) { const v = +m[1]; if (v >= 60 && v <= 200) return v; }
  return null;
}

function parseKey(name) {
  let m = name.match(/(?:^|[\s_\-])([A-G])([#b]?)(maj(?:or)?|min(?:or)?|m)(?=$|[\s_\-.])/);
  if (m) {
    let note = m[1] + (m[2] || '');
    note = NOTE_FLAT[note] || note;
    return note + (/^maj/i.test(m[3]) ? '' : 'm');
  }
  m = name.match(/\s-\s([A-G])([#b]?)$/);
  if (m) { const note = m[1] + (m[2] || ''); return NOTE_FLAT[note] || note; }
  return null;
}

async function wavInfo(p, size) {
  let fh;
  try {
    fh = await fsp.open(p, 'r');
    const b = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(b, 0, 65536, 0);
    if (bytesRead < 44 || b.toString('ascii', 0, 4) !== 'RIFF') return {};
    let o = 12, fmt = null;
    while (o + 8 <= bytesRead) {
      const id = b.toString('ascii', o, o + 4);
      const sz = b.readUInt32LE(o + 4);
      if (id === 'fmt ') {
        fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), br: b.readUInt32LE(o + 16), bits: b.readUInt16LE(o + 22) };
      } else if (id === 'data') {
        if (!fmt || !fmt.br) return {};
        const bytes = Math.min(sz, Math.max(0, size - o - 8));
        return { dur: bytes / fmt.br, sr: fmt.sr, ch: fmt.ch, bits: fmt.bits };
      }
      o += 8 + sz + (sz & 1);
    }
    return {};
  } catch { return {}; }
  finally { if (fh) await fh.close().catch(() => {}); }
}

async function walk(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (AUDIO.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
}

async function scan(root, force) {
  let cache = {};
  if (!force) { try { cache = JSON.parse(await fsp.readFile(cacheFile(), 'utf8')); } catch {} }
  const files = [];
  await walk(root, files);
  const items = [];
  const newCache = {};
  let done = 0;
  const total = files.length;
  const BATCH = 48;
  for (let i = 0; i < files.length; i += BATCH) {
    await Promise.all(files.slice(i, i + BATCH).map(async (p) => {
      let st;
      try { st = await fsp.stat(p); } catch { return; }
      const ext = path.extname(p).toLowerCase();
      const c = cache[p];
      let info;
      if (c && c.m === st.mtimeMs && c.s === st.size) info = c.i;
      else info = ext === '.wav' ? await wavInfo(p, st.size) : {};
      newCache[p] = { m: st.mtimeMs, s: st.size, i: info };

      const rel = path.relative(root, p).split(path.sep);
      const pack = rel[0];
      const folders = rel.slice(1, -1);
      const name = path.basename(p, path.extname(p));
      const type = classify(name, folders);
      const bpm = parseBpm(name);
      const loop = bpm !== null || /(loop|amen|break|groove)/i.test([name, ...folders].join(' '));
      items.push({
        path: p, name, ext: ext.slice(1), pack,
        folder: folders.slice(-2).join(' / '),
        rel: rel.join(' / '),
        type, loop, bpm, key: parseKey(name),
        dur: info.dur ?? null, sr: info.sr ?? null, ch: info.ch ?? null, bits: info.bits ?? null,
        size: st.size,
      });
    }));
    done = Math.min(total, i + BATCH);
    if (win && !win.isDestroyed()) win.webContents.send('scan-progress', { done, total });
  }
  fsp.writeFile(cacheFile(), JSON.stringify(newCache)).catch(() => {});
  return items;
}

// ---------- window ----------
function dragIcon() {
  const w = 32, h = 32, buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { buf[i * 4] = 0x2f; buf[i * 4 + 1] = 0x7a; buf[i * 4 + 2] = 0xff; buf[i * 4 + 3] = 0xff; } // BGRA orange
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

function createWindow() {
  const saved = loadSettings().bounds || {};
  const SIZE = 780;
  win = new BrowserWindow({
    width: SIZE, height: SIZE, useContentSize: true, resizable: false, maximizable: false, fullscreenable: false, frame: false,
    ...(saved.x != null && screen.getDisplayMatching(saved).bounds.width ? { x: saved.x, y: saved.y } : {}),
    backgroundColor: '#0f1115', title: 'Packs Viewer', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  let t;
  const keep = () => { clearTimeout(t); t = setTimeout(() => { if (!win.isDestroyed() && !win.isMaximized() && !win.isMinimized()) saveSettings({ ...loadSettings(), bounds: win.getBounds() }); }, 400); };
  win.on('move', keep);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  ipcMain.handle('get-root', () => getRoot());
  ipcMain.handle('scan', (_e, force) => scan(getRoot(), !!force));
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: getRoot() });
    if (r.canceled || !r.filePaths[0]) return null;
    saveSettings({ ...loadSettings(), root: r.filePaths[0] });
    return r.filePaths[0];
  });
  ipcMain.handle('read-file', async (_e, p) => fsp.readFile(p));
  ipcMain.on('drag-start', (e, p) => e.sender.startDrag({ file: p, icon: dragIcon() }));
  ipcMain.on('win-close', () => win.close());
  ipcMain.on('win-min', () => win.minimize());
  ipcMain.on('reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.on('copy-path', (_e, p) => clipboard.writeText(p));
  createWindow();
});

app.on('window-all-closed', () => app.quit());
