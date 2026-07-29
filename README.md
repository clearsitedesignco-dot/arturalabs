# ArturaLabs

Local-first client acquisition workspace. Find local businesses, read how their
sites are built, book meetings, and track jobs to handover. Everything stays on
the member's machine; the only outbound calls are to their own SerpApi account.

## For students

Download the installer from the Releases page, double-click, done. No Node,
no terminal, no setup beyond pasting one free API key when the app opens.

## For whoever maintains it

    npm install
    npm start

No native modules, so nothing compiles and nothing platform-specific can fail.
Storage is a single JSON file in the user data folder.

    npm run fonts        vendor Archivo / Inter / IBM Plex Mono locally
    npm run screenshots  run the app and photograph every screen
    npm run dist:win     build the Windows installer  -> dist/
    npm run dist:mac     build the macOS installer    -> dist/

### Shipping a release

Tag it and push. GitHub builds both installers and publishes a download page.

    git tag v0.1.0 && git push origin v0.1.0

The workflow screenshots the running app first and fails the build if the
stylesheet did not load, so a broken UI cannot reach a download link.

## Architecture

    src/main/main.js         window, IPC handlers, screenshot mode
    src/main/store.js        JSON storage, no native code
    src/main/keys.js         API keys encrypted via the OS keychain
    src/main/providers/      vendor-neutral search interface
      index.js               registry + shared error codes
      serpapi.js             google_maps engine, normalises to the app shape
      mock.js                sample data, no network, no API calls
    src/main/sitecheck.js    passive site analysis
    src/main/enrich.js       reads published contact details
    src/main/preload.js      the only bridge the renderer gets
    src/renderer/            index.html, styles.css, app.js, fonts/

Adding Google Places later is one new file in `providers/` implementing
`search({ businessType, zip, page, apiKey })`. Nothing else changes.

### Demo mode

`src/renderer/app.js` line 1: set `PROVIDER = "mock"` to run the whole app on
sample data. Mock leads use reserved 555 numbers and `.example` domains, so a
demo can never cause a real business to be contacted.

### Security posture

- `contextIsolation: true`, `nodeIntegration: false`, no node in the renderer
- CSP blocks remote scripts and all renderer network access; everything that
  touches the network runs in the main process
- API keys encrypted with `safeStorage` (Keychain / DPAPI / libsecret)
- Site checks are strictly passive: fetch the page, parse it, read DNS. No
  probing, no input testing, no unauthorised access of any kind
- External links open in the system browser

### Not done yet

- Code signing. Unsigned builds warn on Windows and are blocked on macOS until
  certificates are added to the workflow secrets.
- Auto-update. Add `electron-updater` pointed at GitHub Releases when needed.
