'use strict';
/* Vendor-neutral provider interface.
   A provider exposes:
     id, label,
     async search({ businessType, zip, page, apiKey })
       -> { leads: [NormalisedLead], billableCalls: number, hasMore: boolean }
   It must return the app's own lead shape, never raw vendor JSON.
   Adding Google Places later means adding a file here and nothing else. */

const serpapi = require('./serpapi');
const mock    = require('./mock');

const PROVIDERS = { serpapi, mock };

function get(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

/* Error codes every provider must use, so the UI can stay vendor-agnostic. */
const ERR = {
  BAD_KEY: 'BAD_KEY',
  QUOTA:   'QUOTA',
  HOURLY:  'HOURLY',
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN'
};

module.exports = { get, list: () => Object.keys(PROVIDERS), ERR };
