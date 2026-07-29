'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/* The renderer gets this narrow, explicit surface and nothing else.
   No node, no fs, no direct IPC. Context isolation stays on. */
const call = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('artura', {
  keys: {
    has:    name => call('keys:has', name),
    set:    (name, value) => call('keys:set', { name, value }),
    remove: name => call('keys:remove', name),
    test:   (name, value) => call('keys:test', { name, value })
  },
  profile: {
    get: () => call('profile:get'),
    set: p => call('profile:set', p)
  },
  leads: {
    search:         opts => call('leads:search', opts),
    all:            () => call('leads:all'),
    counts:         () => call('leads:counts'),
    addToOrganizer: ids => call('leads:addToOrganizer', ids),
    organizer:      () => call('leads:organizer'),
    logCall:        (place_id, status, extra) => call('leads:logCall', { place_id, status, extra }),
    update:         (place_id, fields) => call('leads:update', { place_id, fields })
  },
  enrich:    { run: placeIds => call('enrich:run', placeIds) },
  sitecheck: {
    one:   url => call('sitecheck:one', url),
    batch: placeIds => call('sitecheck:batch', placeIds)
  },
  projects: {
    all:  () => call('projects:all'),
    add:  p => call('projects:add', p),
    done: (id, done) => call('projects:done', { id, done })
  },
  activity: {
    list: n => call('activity:list', n),
    log:  (icon, text) => call('activity:log', { icon, text })
  },
  meter:  () => call('meter:get'),
  openExternal: url => call('shell:open', url),
  onProgress: cb => ipcRenderer.on('progress', (_e, data) => cb(data))
});
