'use strict';
const cheerio = require('cheerio');

/* Reads publicly published contact details off a business's own website.
   Only what the site puts on the page for customers to find. */

/* Filters out tracking noise and the placeholder addresses sites put inside
   signup forms — emailing "you@domain.com" would look careless. */
const JUNK = /(example|sentry|wix|squarespace|godaddy|\.png$|\.jpg$|@2x|u003|sentry\.io|@sentry|wixpress)/i;
const PLACEHOLDER = /^(you|your|name|email|user|username|firstname|someone|test|admin@example|john\.?doe|jane\.?doe|yourname)@/i;
const GENERIC_DOMAIN = /@(domain|example|yourdomain|company|website|mysite|yoursite)\.(com|org|net)$/i;

async function enrich(website) {
  if (!website) return { email: null, contact_name: null };
  const base = /^https?:\/\//i.test(website) ? website : 'https://' + website;

  const pages = [base, base.replace(/\/$/, '') + '/contact', base.replace(/\/$/, '') + '/about'];
  let email = null, contact_name = null;

  for (const url of pages) {
    if (email && contact_name) break;
    let html;
    try {
      const r = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'ArturaLabs/1.0' }
      });
      if (!r.ok) continue;
      html = await r.text();
    } catch { continue; }

    const $ = cheerio.load(html);

    if (!email) {
      const mailto = $('a[href^="mailto:"]').first().attr('href');
      if (mailto) {
        const cand = mailto.replace(/^mailto:/i, '').split('?')[0].trim();
        if (cand && !PLACEHOLDER.test(cand) && !GENERIC_DOMAIN.test(cand)) email = cand;
      }
    }
    if (!email) {
      const m = html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
      email = m.find(e => !JUNK.test(e) && !PLACEHOLDER.test(e) && !GENERIC_DOMAIN.test(e)) || null;
    }
    if (!contact_name) {
      const text = $('body').text().replace(/\s+/g, ' ');
      const m = text.match(/(?:owner|founder|president|proprietor)[:,\s-]+([A-Z][a-z]+ [A-Z][a-z]+)/)
             || text.match(/([A-Z][a-z]+ [A-Z][a-z]+)\s*[,-]\s*(?:owner|founder|president)/i);
      if (m) contact_name = m[1];
    }
  }
  return { email: email ? email.toLowerCase() : null, contact_name };
}

module.exports = { enrich };
