'use strict';
/* Mock provider. Lets the whole UI be built and demoed without spending
   searches. Phone numbers use the reserved 555 range and domains end in
   .example, which can never resolve — so mock data can never be mistaken
   for real leads or cause a real business to be contacted. */

const NAMES = {
  Roofing:['Summit','Ridgeline','Ironclad','Apex','Cornerstone','Bluepeak'],
  HVAC:['Comfort','Airflow','Climate','Precision','Frontier','Evergreen'],
  Plumbing:['Rapid','Clearwater','Anchor','Copper','Reliant','Cascade'],
  default:['Anchor','Summit','Meridian','Heritage','Frontier','Trueline']
};
const SUFFIX  = ['& Sons','Co.','Group','Services','LLC','Contractors'];
const STREETS = ['Oak St','Main St','Broadway','Grand Blvd','Walnut St'];

const rng = seed => { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };
const seedOf = str => { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff; return h || 7; };

async function search({ businessType, zip, page = 1 }) {
  await new Promise(r => setTimeout(r, 300));
  const pool = NAMES[businessType] || NAMES.default;
  const r = rng(seedOf(businessType + zip) + page * 977);
  const n = page === 3 ? 8 + Math.floor(r() * 6) : 20;
  const leads = [];
  for (let i = 0; i < n; i++) {
    const idx = (page - 1) * 20 + i;
    const a = pool[Math.floor(r() * pool.length)];
    const b = SUFFIX[Math.floor(r() * SUFFIX.length)];
    const hasSite = r() > 0.28;
    const slug = (a + businessType).toLowerCase().replace(/[^a-z]/g, '');
    leads.push({
      place_id: `mock_${zip}_${businessType}_${idx}`.toLowerCase().replace(/\s+/g, ''),
      name: `${a} ${businessType} ${b}`,
      category: businessType,
      address: `${100 + Math.floor(r() * 8900)} ${STREETS[Math.floor(r() * STREETS.length)]}`,
      city: 'Kansas City', state: 'MO', zip,
      phone: `(555) ${200 + Math.floor(r() * 799)}-${1000 + Math.floor(r() * 8999)}`,
      website: hasSite ? `${slug}${idx}.example` : null,
      rating: +(3.4 + r() * 1.6).toFixed(1),
      reviews: Math.floor(4 + r() * 380)
    });
  }
  return { leads, billableCalls: 0, hasMore: page < 3 };
}

module.exports = { id: 'mock', label: 'Sample data (no API calls)', search, account: async () => null };
