'use strict';
/* Generates the application icons from the ArturaLabs mark, using the copy of
   Electron already in devDependencies to rasterise — no image libraries, no
   native code. Writes assets/icon.png, assets/icon.ico and assets/icon.icns.

   Run with:  npm run icons   (i.e. electron scripts/make-icons.js)

   The .ico and .icns are assembled here in pure JS: both formats are simple
   containers of PNG images, one per size. */

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const MARK = `
  <path d="M38 4 L74 96 L56 96 L38 48 L20 96 L2 96 Z"/>
  <path d="M52 96 L96 2 L118 2 L118 30 L104 20 L72 96 Z"/>
  <path d="M100 96 L100 46 L118 38 L118 96 Z"/>`;

// One master render at 1024, then clean downscales to every size we need.
const MASTER = 1024;
const svg = () => {
  const rx = Math.round(MASTER * 0.22);            // rounded-tile corner
  const mw = Math.round(MASTER * 0.56), mh = Math.round(mw * 100 / 120);
  const mx = Math.round((MASTER - mw) / 2), my = Math.round((MASTER - mh) / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${MASTER}" height="${MASTER}" viewBox="0 0 ${MASTER} ${MASTER}">
    <rect x="0" y="0" width="${MASTER}" height="${MASTER}" rx="${rx}" ry="${rx}" fill="#141416"/>
    <svg x="${mx}" y="${my}" width="${mw}" height="${mh}" viewBox="0 0 120 100"><g fill="#FFFFFF">${MARK}</g></svg>
  </svg>`;
};

// ---- ICO: 6-byte header + 16-byte dir entry per image + PNG payloads ----
function buildIco(images) {                        // images: [{size, png}]
  const n = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(n, 4);
  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  images.forEach((img, i) => {
    const b = dir.subarray(i * 16);
    b.writeUInt8(img.size >= 256 ? 0 : img.size, 0);  // 0 means 256
    b.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    b.writeUInt8(0, 2); b.writeUInt8(0, 3);
    b.writeUInt16LE(1, 4); b.writeUInt16LE(32, 6);
    b.writeUInt32LE(img.png.length, 8);
    b.writeUInt32LE(offset, 12);
    offset += img.png.length;
  });
  return Buffer.concat([header, dir, ...images.map(i => i.png)]);
}

// ---- ICNS: 'icns' magic + total length + (OSType + length + PNG) blocks ----
function buildIcns(bySize) {                       // bySize: Map<size, png>
  const TYPES = [
    ['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512],
    ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]
  ];
  const blocks = [];
  for (const [type, size] of TYPES) {
    const png = bySize.get(size);
    if (!png) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    blocks.push(head, png);
  }
  const body = Buffer.concat(blocks);
  const top = Buffer.alloc(8);
  top.write('icns', 0, 'ascii');
  top.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([top, body]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: MASTER, height: MASTER, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', webPreferences: { offscreen: false }
  });
  await win.loadURL('data:image/svg+xml;base64,' + Buffer.from(svg()).toString('base64'));
  await new Promise(r => setTimeout(r, 400));

  const cap = await win.webContents.capturePage();
  const master = cap.resize({ width: MASTER, height: MASTER, quality: 'best' });

  const png = size => master.resize({ width: size, height: size, quality: 'best' }).toPNG();
  const bySize = new Map([16, 24, 32, 48, 64, 128, 256, 512, 1024].map(s => [s, png(s)]));

  fs.writeFileSync(path.join(ASSETS, 'icon.png'), bySize.get(1024));
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'),
    buildIco([16, 24, 32, 48, 64, 128, 256].map(s => ({ size: s, png: bySize.get(s) }))));
  fs.writeFileSync(path.join(ASSETS, 'icon.icns'), buildIcns(bySize));

  console.log('icons written:',
    'icon.png', bySize.get(1024).length, 'bytes;',
    'icon.ico', fs.statSync(path.join(ASSETS, 'icon.ico')).size, 'bytes;',
    'icon.icns', fs.statSync(path.join(ASSETS, 'icon.icns')).size, 'bytes');
  app.quit();
});
