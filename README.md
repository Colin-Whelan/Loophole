# Loophole for Iterable

Loophole for Iterable is a community browser extension that adds power tools to
[Iterable](https://iterable.com): bulk CSV uploads, a safer two-step user delete, one-click template
searches, a UTM picker for the drag-and-drop editor and more. It replaces a collection of separate
Tampermonkey userscripts with one install, one settings page and one place for your API keys.

Loophole is not made, endorsed or supported by Iterable.

- Works on `app.iterable.com` and `app.eu.iterable.com` (and the drag-and-drop editor frames).
- API keys stay in this browser (`chrome.storage.local`). They are never synced, and settings
  exports leave them out unless you tick "Include API keys".
- Everything Loophole adds to Iterable has a teal outline and a diamond mark, so it never looks
  like one of Iterable's own buttons.

## Install

Loophole isn't in the browser stores yet. Build it (see below) or download a zip from the
[releases page](https://github.com/Colin-Whelan/loophole/releases).

### Chrome (111 or later), Edge, Brave

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `dist/chrome` folder (or the folder you unzipped
   `loophole-chrome-<version>.zip` into).
3. Reload any Iterable tabs that were already open.

### Firefox (140 or later)

1. Open `about:debugging`, then **This Firefox**.
2. Click **Load Temporary Add-on…** and pick `dist/firefox/manifest.json` (or the `manifest.json`
   inside the unzipped `loophole-firefox-<version>.zip`).
3. Open the Loophole toolbar button. If the popup shows **Allow Loophole on Iterable**, click
   it (Firefox can ask you to allow extensions on each site), then reload your Iterable tabs.

Temporary add-ons are removed when Firefox restarts, so you'll need to load it again after a
restart. Your settings and keys are kept between loads (Loophole uses a fixed add-on id).

**Upgrading from a Workbench for Iterable build in Firefox:** Loophole has a new add-on id, so
Firefox gives it fresh, empty storage. Move your data over like this:

1. In the old build, open Settings → Import & export and download a backup with **Include API
   keys** ticked.
2. Remove the old add-on and load the new build.
3. In the new build, open Settings → Import & export → **Restore from a file**, pick that backup
   and tick the keys you want back.
4. Backups from Workbench builds don't carry the Tampermonkey settings kept for tools that
   weren't ported yet. If the settings for **Live preview editor**, **Delete confirm + undo**,
   **Campaign checks** or **Fill username on login** are missing afterwards, run Settings → Import &
   export → **Import from Tampermonkey** again with your Tampermonkey export. (Backups from
   Loophole 0.4.0 on include them.)

Chrome keeps your data when you load the new build from the same folder; if you load it from a
different folder, do the same export and restore.

## First steps

1. **Add an API key** under Settings → Projects & keys, or paste one straight into the toolbar
   popup while you're in a project. Only tools marked "uses key" need one.
2. **Coming from the userscripts?** In Tampermonkey open the Dashboard → Utilities → Zip → Export
   with **Include script storage** ticked, then drop the zip on Settings → Import & export.
3. **Pick your tools** under Settings → Features.

## Reporting a problem

Open an issue at <https://github.com/Colin-Whelan/loophole/issues> (the popup's **Report a problem**
button and Settings → About link there too). Include:

- the feature (every Loophole panel shows its name in the header) and the page URL path,
- what you expected and what happened,
- any `[Loophole:…]` lines from the browser console (turn on Settings → General → Debug logging for
  more detail),
- the Loophole version from the popup header.

Never paste API keys or customer data; Loophole never logs keys.

## Development

Requires Node 20 or later.

```sh
npm install
npm run build    # dist/chrome and dist/firefox
npm run watch    # rebuild both on change
npm run check    # compile every entry for both browsers into a temp dir (dist/ untouched)
npm test         # unit tests (node --test)
npm run zip      # build + release/loophole-<browser>-<version>.zip
npm run icons    # re-render src/icons/*.png from the diamond mark (already committed)
```

Lint the Firefox build with `npx web-ext lint --source-dir dist/firefox`.

Use `npm run check` rather than a bare `npx esbuild src/options/options.js --bundle`: entries
import build-generated `wb-virtual:` modules that only `scripts/build.mjs` can resolve.

The architecture, storage layout, message contract and the recipe for porting a userscript are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The approved visual design is
[design/workbench-mockup.html](design/workbench-mockup.html). `userscripts/` holds the original
scripts for reference only; they are never shipped.

## Releasing

1. Bump `version` in `package.json` (and `package-lock.json`, e.g. with
   `npm version 0.4.0 --no-git-tag-version`), commit and push.
2. On GitHub, publish a release tagged `vX.Y.Z` (e.g. `v0.4.0`).
3. The **Release builds** workflow (`.github/workflows/release.yml`) runs the tests, builds both
   browsers, lints the Firefox build and attaches `loophole-chrome-X.Y.Z.zip` and
   `loophole-firefox-X.Y.Z.zip` to the release. The tag's version wins: if `package.json` says
   something else, the zips are built as the tag's version and the run warns you.

To rebuild the zips for an existing release, run the workflow by hand (Actions → Release builds →
Run workflow) and give it the tag.
