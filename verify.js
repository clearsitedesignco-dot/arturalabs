#!/usr/bin/env node
'use strict';
/* Integrity self-check. Recomputes a SHA-256 of every shipped source file and
   compares it against the manifest below. Carriage returns are ignored, so a
   Windows/macOS/Linux checkout verifies identically regardless of git's
   line-ending settings. The manifest is generated, not hand-edited. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = __dirname;
const MANIFEST = {
  ".github/workflows/release.yml": "edabe25c2bd6abfa1584d08b39151a24498e9e33c4956368a343feb42dfef41b",
  ".gitignore": "fe046b71cdc2a03cf83301c7dbc908f5fa8de0fedd233098d60477623c026211",
  "README.md": "6462ac274bed23ec1d9678cbe4f794ba5ad8f317dbd2de60b83bcc335e59f245",
  "assets/entitlements.mac.plist": "a05afdf7fb33d3609dc9ab3b7d410195db08aa5a8117dc9d83ada5876f0d1074",
  "assets/icon.icns": "1d0ec0d7a13d4987222a9ed80703e77d3fdf0ecba1f985ae7d6c4a67e617537f",
  "assets/icon.ico": "99b9f4a25a11283ea8ae8658ab948b3d54d043eace24b3e4da8452ca43732935",
  "assets/icon.png": "72a6b5f07d4bbcc474f6dbb216973479e377efbf770b4a501fd2fa1e08fb98e5",
  "assets/mark-white.svg": "a20a6af9f7ea2c918157240d7a8f49b8d58a6263e879ab203758f5193179486c",
  "assets/mark.svg": "0e210c40bb74f79b257631449ee135bfd8f3f36d301057a23dd934906db85446",
  "package.json": "d46c979f5ebc6fb8ec20b3a77d5b3c2015a88acf35465653df774d293759627b",
  "scripts/fetch-fonts.js": "5e07778db9633ea00444cca6cb836ad153ad22868a5479b6d20c879b2e181537",
  "scripts/make-icons.js": "96a278e85fb8679e0d084689ba7e0ed2e67cd5ee8fb79d1304a74e442b230d1d",
  "src/main/enrich.js": "2e4e9a60f51147158a371dd18a001467a15713bef8a7c6fe7318962470bce92e",
  "src/main/keys.js": "8db4fb90938148acecf23701ac073add088554d81c73333cdbf20e13c000f76b",
  "src/main/main.js": "b1a3a8bc9d57d54e9a09433dcbd149385753e5ab1bfe3d177436e6f9771bc41f",
  "src/main/preload.js": "1d91898e5d15bbf9ae8df3d27e57aab19340bb6dd38f819acc13667a2b231635",
  "src/main/providers/index.js": "992c69d22cf6fbc28a713882036bf28cb76417df9f6b011f70bf18c0ebed1b04",
  "src/main/providers/mock.js": "21e0b2b34218a81a7a29e6b452125b13dd8b5d2c36ad9a5ae198d3ba8d6b5234",
  "src/main/providers/serpapi.js": "aaeeb50777fce77bfbd3f4cf3be0ca7f8c5dc3dbac22bcebd4b0c416cd984fbc",
  "src/main/sitecheck.js": "f5d0dcc20f03e241c8c15b58a028cc360cc9681883c0b5353f1490bafb6cd153",
  "src/main/store.js": "c6e7d60bd2aae5804d6aec7cdda3ba32690b017223f37e789c311cb40698fae1",
  "src/renderer/app.js": "111c9ef7a950c2e360d8a38446fec885096dcc0a2685e987514bd6d9afd17bb4",
  "src/renderer/fonts/archivo-500.woff2": "37104fa5c30e92a0dabb944452f63089007b44db26fdff6a255ca49b09c4e14e",
  "src/renderer/fonts/archivo-600.woff2": "37104fa5c30e92a0dabb944452f63089007b44db26fdff6a255ca49b09c4e14e",
  "src/renderer/fonts/archivo-700.woff2": "37104fa5c30e92a0dabb944452f63089007b44db26fdff6a255ca49b09c4e14e",
  "src/renderer/fonts/fonts.css": "0c359760db44e2fbd8cf75b937bc2dec45fac21a29c86f817435fb290f19eee5",
  "src/renderer/fonts/ibm-plex-mono-400.woff2": "0b4caf00135d3f5606f3859d125fde9ffd788051fad4cb7e99eab0af1d41c33a",
  "src/renderer/fonts/ibm-plex-mono-500.woff2": "b10923d0ad7acd0aa905ce28b1178f3398c50bd9f24dc192ba4300ffaa8d2c63",
  "src/renderer/fonts/inter-400.woff2": "009049fc92898a74f4d613ab5311d4819e0929af9ca24307ab1dda081016f6ab",
  "src/renderer/fonts/inter-500.woff2": "009049fc92898a74f4d613ab5311d4819e0929af9ca24307ab1dda081016f6ab",
  "src/renderer/fonts/inter-600.woff2": "009049fc92898a74f4d613ab5311d4819e0929af9ca24307ab1dda081016f6ab",
  "src/renderer/index.html": "1ba17997a2f7fe40e584b4d7c332fffc5d6a7a63c9eba98b2af8a1b6a0a9204a",
  "src/renderer/styles.css": "ed4a258789c205f710d9d20a6d7cdd0cfd6da029dc3bafa65addf481f8ce78b9"
};
const strip = buf => { const o = Buffer.alloc(buf.length); let j = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0x0d) o[j++] = buf[i];
  return o.subarray(0, j); };
const missing = [], wrong = [];
for (const [rel, want] of Object.entries(MANIFEST)) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { missing.push(rel); continue; }
  const got = crypto.createHash('sha256').update(strip(fs.readFileSync(p))).digest('hex');
  if (got !== want) wrong.push(rel);
}
if (missing.length || wrong.length) {
  if (missing.length) { console.error('MISSING FILES:'); missing.forEach(m => console.error('  ' + m)); }
  if (wrong.length) { console.error('CHANGED / CORRUPT FILES:'); wrong.forEach(m => console.error('  ' + m)); }
  console.error('The folder did not extract cleanly. Do not trust the rest until this is fixed.');
  process.exit(1);
}
console.log('Everything is here and intact. (' + Object.keys(MANIFEST).length + ' files verified)');
