'use strict';
const { safeStorage, app } = require('electron');
const fs = require('fs');
const path = require('path');

/* API keys are encrypted with the OS keychain (Keychain on macOS, DPAPI on
   Windows, libsecret on Linux) and written as ciphertext. They never appear
   in plaintext on disk and are never sent anywhere except the vendor's API. */

const file = () => path.join(app.getPath('userData'), 'keys.dat');

function readAll() {
  try {
    const raw = fs.readFileSync(file());
    if (!safeStorage.isEncryptionAvailable()) return {};
    return JSON.parse(safeStorage.decryptString(raw));
  } catch { return {}; }
}
function writeAll(obj) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('This system has no secure storage available, so keys cannot be saved safely.');
  }
  fs.writeFileSync(file(), safeStorage.encryptString(JSON.stringify(obj)), { mode: 0o600 });
}

const get    = name => readAll()[name] || null;
const set    = (name, value) => { const a = readAll(); a[name] = value; writeAll(a); };
const remove = name => { const a = readAll(); delete a[name]; writeAll(a); };
const has    = name => !!get(name);

module.exports = { get, set, remove, has, available: () => safeStorage.isEncryptionAvailable() };
