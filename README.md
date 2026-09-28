# Workbench for Iterable

A community browser extension that adds power tools to [Iterable](https://iterable.com): bulk CSV
uploads, a safer two-step user delete, one-click template searches, a UTM picker for the
drag-and-drop editor and more. It replaces a collection of separate Tampermonkey userscripts with
one install, one settings page and one place for your API keys.

Workbench is not made, endorsed or supported by Iterable.

- Works on `app.iterable.com` and `app.eu.iterable.com` (and the drag-and-drop editor frames).
- API keys stay in this browser (`chrome.storage.local`). They are never synced, and settings
  exports leave them out unless you tick "Include API keys".
- Everything Workbench adds to Iterable has a teal outline and a diamond mark, so it never looks
  like one of Iterable's own buttons.

## Install

Workbench isn't in the browser stores yet. Build it (see below) or download a release zip.

### Chrome (111 or later), Edge, Brave

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `dist/chrome` folder (or the folder you unzipped
   `workbench-chrome-<version>.zip` into).
3. Reload any Iterable tabs that were already open.

### Firefox (140 or later)

1. Open `about:debugging`, then **This Firefox**.
2. Click **Load Temporary Add-on…** and pick `dist/firefox/manifest.json` (or the `manifest.json`
   inside the unzipped `workbench-firefox-<version>.zip`).
3. Open the Workbench toolbar button. If the popup shows **Allow Workbench on Iterable**, click
   it (Firefox can ask you to allow extensions on each site), then reload your Iterable tabs.

Temporary add-ons are removed when Firefox restarts, so you'll need to load it again after a
restart. Your settings and keys are kept between loads (Workbench uses a fixed add-on id).

## First steps

1. **Add an API key** under Settings → Projects & keys, or paste one straight into the toolbar
   popup while you're in a project. Only tools marked "uses key" need one.
2. **Coming from the userscripts?** In Tampermonkey open the Dashboard → Utilities → Zip → Export
   with **Include script storage** ticked, then drop the zip on Settings → Import & export.
3. **Pick your tools** under Settings → Features.

## Reporting a problem

There's no issue tracker yet (the popup's **Report a problem** button points here). Send the
maintainer:

- the feature (every Workbench panel shows its name in the header) and the page URL path,
- what you expected and what happened,
- any `[WB:…]` lines from the browser console (turn on Settings → General → Debug logging for
  more detail),
- the Workbench version from the popup header.

Never paste API keys or customer data; Workbench never logs keys.

## Development

Requires Node 20 or later.

```sh
npm install
npm run build    # dist/chrome and dist/firefox
npm run watch    # rebuild both on change
npm run check    # compile every entry for both browsers into a temp dir (dist/ untouched)
npm test         # unit tests (node --test)
npm run zip      # build + release/workbench-<browser>-<version>.zip
npm run icons    # re-render src/icons/*.png from the diamond mark (already committed)
```

Lint the Firefox build with `npx web-ext lint --source-dir dist/firefox`.

Use `npm run check` rather than a bare `npx esbuild src/options/options.js --bundle`: entries
import build-generated `wb-virtual:` modules that only `scripts/build.mjs` can resolve.

The architecture, storage layout, message contract and the recipe for porting a userscript are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The approved visual design is
[design/workbench-mockup.html](design/workbench-mockup.html). `userscripts/` holds the original
scripts for reference only; they are never shipped.
