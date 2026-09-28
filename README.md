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

## Features

**Campaigns**
- **Campaign checks:** seed list, suppression list and subject checks on the campaign page, with an
  **Approval view** that puts the details next to the actual email for one-screenshot sign-off.
- **Email HTML check:** 20 rules for accessibility, deliverability and rendering.
- **Workflow link parameters:** fills Google Analytics and link parameters in journey and template
  Details panels.

**Templates**
- **Live preview editor:** live preview beside the code editor, test data per template, load a
  user's profile as test data, editor shortcuts and snippets.
- **Link parameters:** pick UTM values from your own library in the drag-and-drop editor.
- **Delete confirm + undo:** optional auto-confirm on delete, plus Undo and Redo.
- **Image library:** browse, upload and copy image paths from the template editor.
- **Snippet viewer:** search, preview and copy snippets from anywhere.
- **Quick search tags:** one-click saved searches above the template list.
- **Locale banner** and **creative library previews** (bigger thumbnails, click-to-copy URLs).

**Users**
- **User lookup:** find a user by email or userId from the top bar.
- **Profile editor:** edit profile fields in place, with type checks.
- **Delete user:** two-step delete that shows the exact API call first.
- **Dynamic list membership** and **copy event data** (a custom event's dataFields as JSON).

**Data**
- **Bulk data:** push users, list subscriptions and catalog items from CSV, and export catalogs —
  rate-limited, retried and resumable.
- **Field value explorer:** every value of a user field, past the 1,200-value limit.
- **Export field picker:** select all, filtered or inverted fields in Export to CSV.

**Navigation and sign-in**
- **Quicklinks:** your own shortcuts in the top bar.
- **Fill username on login:** off by default; never touches passwords.

## Install and first steps

Download a build from the [releases page](https://github.com/Colin-Whelan/loophole/releases) and
follow **[docs/SETUP.md](docs/SETUP.md)** for install steps (Firefox `.xpi` / Chrome unpacked),
updating, migrating from the Tampermonkey userscripts, backups, first steps and troubleshooting.

## Reporting a problem

Open an issue at <https://github.com/Colin-Whelan/loophole/issues> (the popup's **Report a problem**
button and Settings → About link there too). See [docs/SETUP.md](docs/SETUP.md#reporting-a-problem)
for what to include. Never paste API keys or customer data; Loophole never logs keys.

## Support

Loophole is free and maintained on the side. If it saves you time, you can
[support it on Ko-fi](https://ko-fi.com/cocodev). Project site: <https://colin-whelan.github.io/loophole/>.

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
