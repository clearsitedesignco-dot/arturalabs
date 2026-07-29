'use strict';
const { ERR } = { ERR: { BAD_KEY:'BAD_KEY', QUOTA:'QUOTA', HOURLY:'HOURLY', NETWORK:'NETWORK', UNKNOWN:'UNKNOWN' } };

const ENDPOINT = 'https://serpapi.com/search.json';

/* SerpApi google_maps engine. NOT the google engine — Maps is what returns
   business listings with addresses and phone numbers. */
async function search({ businessType, zip, page = 1, apiKey }) {
  if (!apiKey) { const e = new Error('missing key'); e.code = ERR.BAD_KEY; throw e; }

  const params = new URLSearchParams({
    engine: 'google_maps',
    type: 'search',
    q: `${businessType} in ${zip}`,
    start: String((page - 1) * 20),
    api_key: apiKey
  });

  let res, body;
  try {
    res = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(25000) });
    body = await res.json();
  } catch (err) {
    const e = new Error('network'); e.code = ERR.NETWORK; e.cause = err; throw e;
  }

  if (body && body.error) {
    const m = String(body.error).toLowerCase();
    const e = new Error(body.error);
    if (m.includes('invalid api key') || m.includes('missing api key')) e.code = ERR.BAD_KEY;
    else if (m.includes('run out') || m.includes('exceeded your searches') || m.includes('plan')) e.code = ERR.QUOTA;
    else if (m.includes('hourly') || m.includes('throughput') || m.includes('too many')) e.code = ERR.HOURLY;
    else if (m.includes("hasn't returned any results") || m.includes('no results')) {
      return { leads: [], billableCalls: 1, hasMore: false };
    }
    else e.code = ERR.UNKNOWN;
    throw e;
  }
  if (res.status === 401) { const e = new Error('unauthorised'); e.code = ERR.BAD_KEY; throw e; }
  if (res.status === 429) { const e = new Error('rate limited'); e.code = ERR.HOURLY; throw e; }

  const raw = body.local_results || [];
  return {
    leads: raw.map(normalise).filter(Boolean),
    billableCalls: 1,
    hasMore: raw.length >= 20
  };
}

/* Vendor JSON -> the app's lead shape. The only place SerpApi's field
   names are allowed to appear. */
function normalise(r) {
  if (!r || !(r.place_id || r.data_id)) return null;
  const addr = r.address || '';
  const parts = addr.split(',').map(s => s.trim());
  const tail = parts[parts.length - 1] || '';
  const m = tail.match(/([A-Z]{2})\s+(\d{5})/);

  let website = r.website || null;
  if (website) website = website.replace(/^https?:\/\//, '').replace(/\/$/, '');

  return {
    place_id: String(r.place_id || r.data_id),
    name:     r.title || 'Unknown',
    category: r.type || (Array.isArray(r.types) ? r.types[0] : null),
    address:  parts[0] || addr || null,
    city:     parts.length > 1 ? parts[1] : null,
    state:    m ? m[1] : null,
    zip:      m ? m[2] : null,
    phone:    r.phone || null,
    website,
    rating:   typeof r.rating === 'number' ? r.rating : null,
    reviews:  typeof r.reviews === 'number' ? r.reviews : null
  };
}

/* Remaining-searches meter. SerpApi exposes an account endpoint. */
async function account(apiKey) {
  try {
    const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const a = await res.json();
    return {
      plan: a.plan_name || null,
      used: a.this_month_usage ?? null,
      left: a.total_searches_left ?? null
    };
  } catch { return null; }
}

module.exports = { id: 'serpapi', label: 'SerpApi', search, account, normalise };
