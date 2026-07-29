'use strict';
const cheerio = require('cheerio');
const dns = require('dns').promises;

/* Passive checks only. Everything here is information a normal browser
   receives when it loads the page. No probing for hidden files, no testing
   inputs, no unauthorised access of any kind — that would be a different
   thing legally, regardless of intent. */

const KEY_PATTERNS = [
  { re: /sk-[A-Za-z0-9_-]{20,}/,                    what: 'OpenAI secret key' },
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/,                what: 'Anthropic key' },
  { re: /AIza[0-9A-Za-z_-]{35}/,                    what: 'Google API key' },
  { re: /sk_live_[0-9a-zA-Z]{20,}/,                 what: 'Stripe live secret key' },
  { re: /(?:AKIA|ASIA)[0-9A-Z]{16}/,                what: 'AWS access key' },
  { re: /xox[baprs]-[0-9A-Za-z-]{10,}/,             what: 'Slack token' },
  { re: /ghp_[A-Za-z0-9]{36}/,                      what: 'GitHub token' },
  { re: /dangerouslyAllowBrowser\s*:\s*true/,       what: 'AI client running in the browser' }
];

const BUILDER_HOSTS = ['wixsite.com','weebly.com','squarespace.com','godaddysites.com',
  'business.site','netlify.app','vercel.app','github.io','webflow.io','wordpress.com'];

async function get(url, opts = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeout || 15000),
    headers: { 'User-Agent': 'ArturaLabs-SiteCheck/1.0 (+site audit)' }
  });
  return res;
}

function normaliseUrl(input) {
  let u = String(input || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return new URL(u);
}

async function check(input) {
  const url = normaliseUrl(input);
  const findings = [];
  const t0 = Date.now();

  let res, html;
  try {
    res = await get(url.href);
    html = await res.text();
  } catch {
    // try http before declaring it dead
    try {
      const alt = new URL(url.href); alt.protocol = 'http:';
      res = await get(alt.href); html = await res.text();
      findings.push('nohttps');
    } catch {
      return { ok: true, reachable: false, bucket: 'dead', score: 0, findings: ['dead'], ms: Date.now() - t0 };
    }
  }
  const ms = Date.now() - t0;
  if (!res.ok && res.status >= 400) {
    return { ok: true, reachable: false, bucket: 'dead', score: 0, findings: ['dead'], ms };
  }

  const $ = cheerio.load(html);
  const finalUrl = new URL(res.url || url.href);

  if (finalUrl.protocol !== 'https:' && !findings.includes('nohttps')) findings.push('nohttps');

  // mixed content: http:// asset references on an https page
  if (finalUrl.protocol === 'https:') {
    const mixed = $('script[src^="http://"], img[src^="http://"], link[href^="http://"]').length;
    if (mixed > 0 && !findings.includes('nohttps')) findings.push('nohttps');
  }

  if (!$('meta[name="viewport"]').attr('content')) findings.push('nomobile');
  if (BUILDER_HOSTS.some(h => finalUrl.hostname.endsWith(h))) findings.push('builder');

  const hasForm = $('form').length > 0;
  const hasMailto = $('a[href^="mailto:"]').length > 0;
  const hasTel = $('a[href^="tel:"]').length > 0;
  if (!hasForm && !hasMailto && !hasTel) findings.push('nocontact');

  // a form with no action and no submit handler goes nowhere
  if (hasForm) {
    const dead = $('form').toArray().every(f => {
      const action = ($(f).attr('action') || '').trim();
      return !action || action === '#' || action === 'javascript:void(0)';
    });
    const hasHandler = /addEventListener\(\s*['"]submit/.test(html) || /onsubmit/i.test(html);
    if (dead && !hasHandler) findings.push('deadform');
  }

  if (ms > 3000 || html.length > 3_000_000) findings.push('slow');
  if (!$('title').text().trim() || !$('meta[name="description"]').attr('content')) findings.push('noseo');

  const yearMatch = html.match(/(?:©|&copy;|copyright)\s*(20\d{2})/i);
  if (yearMatch && new Date().getFullYear() - Number(yearMatch[1]) >= 2) findings.push('stale');

  const hasAnalytics = /googletagmanager|google-analytics|plausible|umami|fathom|posthog/i.test(html);
  if (!hasAnalytics) findings.push('noanalytics');

  // published source maps
  if (/sourceMappingURL=.+\.map/.test(html)) findings.push('sourcemaps');

  // exposed keys — page HTML plus same-origin scripts
  const scripts = $('script[src]').toArray()
    .map(el => $(el).attr('src'))
    .filter(Boolean)
    .map(src => { try { return new URL(src, finalUrl).href; } catch { return null; } })
    .filter(u => u && new URL(u).origin === finalUrl.origin)
    .slice(0, 8);

  let blob = html;
  for (const src of scripts) {
    try { const r = await get(src, { timeout: 8000 }); blob += '\n' + (await r.text()); } catch {}
  }
  const exposed = KEY_PATTERNS.filter(k => k.re.test(blob)).map(k => k.what);
  if (exposed.length) findings.push('apikey');

  // firestore/realtime db left open
  if (/firebaseio\.com|firestore\.googleapis/.test(blob) &&
      /allow\s+read,\s*write:\s*if\s+true/.test(blob)) findings.push('opendb');

  // visitor input written straight into the page
  const sinkRe = /\.innerHTML\s*=\s*(?!['"`]\s*['"`])[A-Za-z_$][\w$.]*(user|comment|review|input|msg|message|name|search|query)[\w$.]*\s*[;,)]/i;
  const formSink = /\.innerHTML\s*=\s*[^;]{0,80}\.value\b/.test(blob);
  if (sinkRe.test(blob) || formSink) findings.push('nosanitize');

  // email spoofing protection
  // Only report a missing record when the lookup actually succeeded. A DNS
  // failure means we do not know, and "we do not know" must never be
  // reported to a member as "they are unprotected".
  let dnsChecked = false, spf = false, dmarc = false;
  try {
    const txt = await dns.resolveTxt(finalUrl.hostname);
    spf = /v=spf1/i.test(txt.flat().join(' '));
    dnsChecked = true;
  } catch (e) { if (e && e.code === 'ENODATA') { dnsChecked = true; spf = false; } }
  if (dnsChecked) {
    try {
      const d = await dns.resolveTxt('_dmarc.' + finalUrl.hostname);
      dmarc = d.flat().join(' ').toLowerCase().includes('v=dmarc1');
    } catch (e) { if (!e || e.code !== 'ENODATA') dnsChecked = false; }
  }
  if (dnsChecked && (!spf || !dmarc)) findings.push('nodmarc');

  const WEIGHTS = { apikey:34, opendb:30, deadform:26, nosanitize:20, nohttps:16,
                    nomobile:18, nocontact:16, nodmarc:14, sourcemaps:14, norate:12,
                    builder:12, oldlibs:11, slow:10, noseo:8, nobuild:8, stale:6, noanalytics:5 };
  const lost = findings.reduce((n, f) => n + (WEIGHTS[f] || 5), 0);
  const score = Math.max(5, 100 - lost);

  return {
    ok: true, reachable: true, url: finalUrl.href, ms, score,
    bucket: score <= 55 ? 'weak' : 'solid',
    findings, exposed
  };
}

module.exports = { check, normaliseUrl, KEY_PATTERNS };
