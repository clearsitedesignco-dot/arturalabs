'use strict';
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const db = require('./store');   // JSON store — no native code, nothing to compile
const keys = require('./keys');
const providers = require('./providers');
const sitecheck = require('./sitecheck');
const { enrich } = require('./enrich');

const KEY_SEARCH = 'searchApiKey';   // provider-neutral on purpose
const MAX_PAGES = 3;
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 1000, minHeight: 680,
    backgroundColor: '#FBFBFC',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => win.show());

  // external links open in the real browser, never in the app
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); }
  });

  // Right-click menu. Electron ships none by default, which is why right-click
  // did nothing. In a text field this gives Cut/Copy/Paste (so a key can be
  // pasted with the mouse) and Select All; over selected text, Copy.
  win.webContents.on('context-menu', (_e, params) => {
    const { editFlags, isEditable, selectionText } = params;
    const items = [];
    if (isEditable) {
      items.push({ role: 'cut', enabled: editFlags.canCut });
      items.push({ role: 'copy', enabled: editFlags.canCopy });
      items.push({ role: 'paste', enabled: editFlags.canPaste });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll' });
    } else if (selectionText && selectionText.trim()) {
      items.push({ role: 'copy' });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

app.whenReady().then(() => {
  try { db.init(app); }
  catch (err) {
    dialog.showErrorBox('ArturaLabs could not start',
      'Your saved work could not be opened.\n\n' + err.message +
      '\n\nNothing has been deleted. Your data lives in:\n' + app.getPath('userData'));
    app.quit(); return;
  }
  app.on('before-quit', () => { try { db.saveNow(); } catch {} });
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  if (process.env.ARTURA_SCREENSHOT) runScreenshots();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, arg) => {
  try { return { ok: true, data: await fn(arg) }; }
  catch (err) { return { ok: false, code: err.code || 'UNKNOWN', message: err.message }; }
});

/* ---------------- keys ---------------- */
handle('keys:has',    name => keys.has(name));
handle('keys:set',    ({ name, value }) => { keys.set(name, value); return true; });
handle('keys:remove', name => { keys.remove(name); return true; });
handle('keys:test',   async ({ name, value }) => {
  if (name !== KEY_SEARCH) return { valid: !!value };
  const acct = await providers.get('serpapi').account(value);
  if (!acct) { const e = new Error('rejected'); e.code = 'BAD_KEY'; throw e; }
  keys.set(KEY_SEARCH, value);
  return { valid: true, ...acct };
});
handle('meter:get', async () => {
  const k = keys.get(KEY_SEARCH);
  if (!k) return null;
  return await providers.get('serpapi').account(k);
});

/* ---------------- profile ---------------- */
handle('profile:get', () => JSON.parse(db.getSetting('profile') || '{}'));
handle('profile:set', p => { db.setSetting('profile', JSON.stringify(p)); return true; });

/* ---------------- search ---------------- */
handle('leads:search', async ({ businessType, zip, fields = [], want = [], provider = 'serpapi' }) => {
  const prov = providers.get(provider);
  const apiKey = provider === 'mock' ? null : keys.get(KEY_SEARCH);
  if (provider !== 'mock' && !apiKey) { const e = new Error('no key'); e.code = 'BAD_KEY'; throw e; }

  let collected = [], calls = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await prov.search({ businessType, zip, page, apiKey });
    calls += res.billableCalls;
    collected = collected.concat(res.leads);
    if (!res.hasMore) break;
  }

  // site quality, only if the member asked for a distinction that needs it
  const needsScan = want.some(w => ['weak', 'solid', 'dead'].includes(w));
  let scanned = 0;
  for (const L of collected) {
    if (!L.website) { L.site_bucket = 'none'; L.site_score = null; L.findings = []; continue; }
    if (!needsScan)  { L.site_bucket = null;  L.site_score = null; L.findings = []; continue; }
    const r = await sitecheck.check(L.website).catch(() => null);
    L.site_bucket = r ? r.bucket : null;
    L.site_score  = r ? r.score : null;
    L.findings    = r ? r.findings : [];
    send('progress', { stage: 'sitecheck', done: ++scanned, total: collected.filter(x => x.website).length });
  }

  const kept = want.length
    ? collected.filter(L => want.includes(L.site_bucket || 'solid'))
    : collected;
  const filteredOut = collected.length - kept.length;

  const needsEnrichment = fields.includes('email') || fields.includes('contact');
  const { inserted, duplicates } = db.saveSearch({
    query: `${businessType} in ${zip}`, location: zip, provider: prov.id,
    leads: kept, needsEnrichment
  });

  db.logEvent('search', `Found <b>${inserted}</b> ${businessType} leads in ${zip}`);
  return { inserted, duplicates, filteredOut, apiCalls: calls };
});

/* ---------------- leads ---------------- */
handle('leads:all',            () => db.all());
handle('leads:counts',         () => db.counts());
handle('leads:organizer',      () => db.organizer());
handle('leads:addToOrganizer', ids => {
  const n = db.addToOrganizer(ids);
  if (n) db.logEvent('call', `Sent <b>${n}</b> leads to the Call Organizer`);
  return n;
});
handle('leads:logCall', ({ place_id, status, extra }) => { db.logCall(place_id, status, extra || {}); return true; });
handle('leads:update',  ({ place_id, fields }) => { db.updateLead(place_id, fields); return true; });

/* ---------------- enrichment ---------------- */
handle('enrich:run', async placeIds => {
  const leads = placeIds ? placeIds.map(db.byPlaceId).filter(Boolean)
                         : db.all().filter(l => l.website && !l.enriched_at);
  let found = 0;
  for (let i = 0; i < leads.length; i++) {
    const L = leads[i];
    const { email, contact_name } = await enrich(L.website).catch(() => ({}));
    db.updateLead(L.place_id, {
      email: email || null, contact_name: contact_name || null,
      enriched_at: new Date().toISOString()
    });
    if (email) found++;
    send('progress', { stage: 'enrich', done: i + 1, total: leads.length, found });
  }
  return { checked: leads.length, found };
});

/* ---------------- site check ---------------- */
handle('sitecheck:one', url => sitecheck.check(url));
handle('sitecheck:batch', async placeIds => {
  const leads = (placeIds ? placeIds.map(db.byPlaceId) : db.all()).filter(l => l && l.website);
  for (let i = 0; i < leads.length; i++) {
    const r = await sitecheck.check(leads[i].website).catch(() => null);
    db.updateLead(leads[i].place_id, {
      checked_at: new Date().toISOString(),
      site_bucket: r ? r.bucket : null,
      site_score: r ? r.score : null,
      findings: JSON.stringify(r ? r.findings : [])
    });
    send('progress', { stage: 'sitecheck', done: i + 1, total: leads.length });
  }
  db.logEvent('check', `Checked <b>${leads.length}</b> websites`);
  return { checked: leads.length };
});

/* ---------------- projects + activity ---------------- */
handle('projects:all',  () => db.projects());
handle('projects:add',  p => { const id = db.addProject(p); db.logEvent('proj', `Started a project for <b>${p.name}</b>`); return id; });
handle('projects:done', ({ id, done }) => { db.setProjectDone(id, done); return true; });
handle('activity:list', n => db.activity(n || 20));
handle('activity:log',  ({ icon, text }) => { db.logEvent(icon, text); return true; });
handle('shell:open',    url => { shell.openExternal(url); return true; });


/* =========================================================================
   Screenshot mode. CI runs the real app on a virtual display and captures
   every screen, so a broken stylesheet is caught before anyone downloads it.
   Triggered by ARTURA_SCREENSHOT=1; does nothing in normal use.
   ========================================================================= */
async function runScreenshots() {
  const fsp = require('fs').promises;
  const out = process.env.ARTURA_SCREENSHOT_DIR || require('path').join(process.cwd(), 'screenshots');
  await fsp.mkdir(out, { recursive: true });
  const wait = ms => new Promise(r => setTimeout(r, ms));

  await new Promise(r => win.webContents.once('did-finish-load', r));
  await wait(2500);   // fonts + first render

  const shot = async name => {
    const img = await win.webContents.capturePage();
    await fsp.writeFile(require('path').join(out, name + '.png'), img.toPNG());
    console.log('captured', name);
  };
  const click = async selector => {
    await win.webContents.executeJavaScript(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(el)el.click();return !!el;})()`);
    await wait(700);
  };

  try {
    await shot('01-first-run');
    // dismiss onboarding so the app itself can be seen
    await win.webContents.executeJavaScript(`(()=>{const o=document.getElementById('onb');if(o)o.hidden=true;})()`);
    await wait(400);

    const screens = [
      ['02-home',      '.item[data-go="home"]'],
      ['03-scraper',   '.item[data-go="scraper"]'],
      ['04-outreach',  '.item[data-go="outreach"]'],
      ['05-organizer', '.item[data-go="organizer"]'],
      ['06-meetings',  '.item[data-go="meetings"]'],
      ['07-projects',  '.item[data-go="projects"]'],
      ['08-sitecheck', '.item[data-go="sitecheck"]'],
      ['09-prompts',   '.item[data-go="prompts"]'],
      ['10-profile',   '.item[data-go="profile"]'],
      ['11-keys',      '.item[data-go="keys"]']
    ];
    for (const [name, sel] of screens) { await click(sel); await shot(name); }

    // fail loudly if the stylesheet did not load
    const styled = await win.webContents.executeJavaScript(
      `(()=>{const r=getComputedStyle(document.querySelector('.rail'));
             return { width:r.width, bg:r.backgroundColor,
                      font:getComputedStyle(document.body).fontFamily };})()`);
    console.log('style probe:', JSON.stringify(styled));
    if (parseInt(styled.width) < 200) {
      console.error('STYLESHEET DID NOT LOAD — sidebar width is ' + styled.width);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('screenshot run failed:', err);
    process.exitCode = 1;
  }
  app.quit();
}
