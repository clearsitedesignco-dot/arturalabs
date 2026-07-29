'use strict';
const fs = require('fs');
const path = require('path');

/* Storage with no native code, so nothing ever has to compile on a member's
   machine. One JSON file, held in memory, written back on a short debounce.
   A lead list is a few thousand rows at most — this is comfortably fast, and
   it removes the single most common install failure.

   The exported surface is identical to the old SQLite module, so the main
   process does not care which is underneath. */

let file, data, timer = null, app = null;

const EMPTY = () => ({
  version: 1, nextId: 1,
  searches: [], leads: [], calls: [], projects: [], activity: [], settings: {}
});

function init(electronApp) {
  app = electronApp;
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'artura.json');
  data = load();
  return data;
}

function load() {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...EMPTY(), ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return EMPTY();
    // Corrupt file: keep it aside rather than destroying a member's work.
    try { fs.renameSync(file, file + '.broken-' + Date.now()); } catch {}
    return EMPTY();
  }
}

function flush() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);           // atomic: never a half-written file
}
function save() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; try { flush(); } catch (e) { console.error('save failed', e); } }, 250);
}
function saveNow() { if (timer) { clearTimeout(timer); timer = null; } try { flush(); } catch {} }

const id = () => data.nextId++;
const now = () => new Date().toISOString();

/* ---------------- searches + leads ---------------- */

const LEAD_DEFAULTS = {
  category: null, address: null, city: null, state: null, zip: null,
  phone: null, website: null, rating: null, reviews: null,
  needs_enrichment: 0, enriched_at: null, email: null, contact_name: null,
  checked_at: null, site_bucket: null, site_score: null, findings: [],
  in_organizer: 0, call_status: 'new', attempts: 0, last_called: null,
  callback_on: null, notes: '', meeting_at: null, meet_link: '', confirmed: 0,
  meeting_outcome: null, deal_value: 0, emailed_at: null
};

function saveSearch({ query, location, provider, leads, needsEnrichment }) {
  const searchId = id();
  const seen = new Set(data.leads.map(l => l.place_id));
  let inserted = 0, duplicates = 0;

  for (const L of leads) {
    if (!L || !L.place_id) continue;
    if (seen.has(L.place_id)) { duplicates++; continue; }   // never insert twice
    seen.add(L.place_id);
    data.leads.push({
      ...LEAD_DEFAULTS,
      id: id(), search_id: searchId, created_at: now(),
      place_id: L.place_id, name: L.name || 'Unknown',
      category: L.category ?? null, address: L.address ?? null,
      city: L.city ?? null, state: L.state ?? null, zip: L.zip ?? null,
      phone: L.phone ?? null, website: L.website ?? null,
      rating: L.rating ?? null, reviews: L.reviews ?? null,
      needs_enrichment: needsEnrichment ? 1 : 0,
      site_bucket: L.site_bucket ?? null, site_score: L.site_score ?? null,
      findings: L.findings || []
    });
    inserted++;
  }
  data.searches.push({ id: searchId, query, location, provider, result_count: inserted, created_at: now() });
  save();
  return { searchId, inserted, duplicates };
}

const all        = () => data.leads.slice().reverse();
const byPlaceId  = pid => data.leads.find(l => l.place_id === pid) || null;
const countLeads = () => data.leads.length;

function updateLead(place_id, fields) {
  const L = byPlaceId(place_id);
  if (!L) return false;
  Object.assign(L, fields);
  save();
  return true;
}

/* ---------------- organizer ---------------- */

function addToOrganizer(placeIds) {
  let n = 0;
  for (const pid of placeIds || []) {
    const L = byPlaceId(pid);
    if (L && !L.in_organizer) { L.in_organizer = 1; n++; }
  }
  if (n) save();
  return n;
}
const organizer = () =>
  data.leads.filter(l => l.in_organizer).sort((a, b) => a.name.localeCompare(b.name));

function logCall(place_id, status, { notes, callback_on, meeting_at } = {}) {
  const L = byPlaceId(place_id);
  if (!L) return;
  L.call_status = status;
  L.attempts += 1;
  if (notes !== undefined && notes !== null) L.notes = notes;
  L.callback_on = callback_on || null;
  if (meeting_at) L.meeting_at = meeting_at;
  L.last_called = now().slice(0, 10);
  data.calls.push({ id: id(), lead_id: L.id, status, notes: notes || '', created_at: now() });
  save();
}

/* ---------------- projects ---------------- */

const projects = () => data.projects.slice();

function addProject({ name, value, place_id }) {
  const L = place_id ? byPlaceId(place_id) : null;
  const p = { id: id(), lead_id: L ? L.id : null, place_id: place_id || null,
              name, value: value || 0, done: {}, created_at: now() };
  data.projects.push(p);
  save();
  return p.id;
}
function setProjectDone(pid, done) {
  const p = data.projects.find(x => x.id === pid);
  if (!p) return false;
  p.done = done || {};
  save();
  return true;
}

/* ---------------- activity + settings ---------------- */

function logEvent(icon, text) {
  data.activity.unshift({ id: id(), icon, text, created_at: now() });
  if (data.activity.length > 200) data.activity.length = 200;
  save();
}
const activity = (n = 20) => data.activity.slice(0, n);

const getSetting = k => (k in data.settings ? data.settings[k] : null);
const setSetting = (k, v) => { data.settings[k] = v; save(); };

/* ---------------- counts ---------------- */

function counts() {
  const L = data.leads;
  return {
    scraped:   L.length,
    enriched:  L.filter(x => x.email).length,
    contacted: L.filter(x => x.attempts > 0 || x.emailed_at).length,
    booked:    L.filter(x => x.call_status === 'booked').length,
    won:       L.filter(x => x.meeting_outcome === 'won').length,
    value:     L.reduce((n, x) => n + (x.meeting_outcome === 'won' ? Number(x.deal_value) || 0 : 0), 0)
  };
}

/* Export everything a member has, so their data is never trapped in here. */
function exportAll() { return JSON.parse(JSON.stringify(data)); }

module.exports = {
  init, saveSearch, all, byPlaceId, countLeads, updateLead,
  addToOrganizer, organizer, logCall,
  projects, addProject, setProjectDone,
  logEvent, activity, getSetting, setSetting, counts,
  exportAll, saveNow, _file: () => file
};
