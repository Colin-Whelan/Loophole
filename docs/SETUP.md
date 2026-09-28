# Setup

Installing, updating and the first few things to do after installing Loophole for Iterable.

## Install

**Firefox (recommended: stays installed across restarts)**

1. Download `loophole-firefox-<version>.xpi` from the
   [releases page](https://github.com/Colin-Whelan/loophole/releases).
2. Drag the `.xpi` into a Firefox window, or open `about:addons` → the gear icon →
   **Install Add-on From File…** and pick it.
3. Click **Add** on the permission prompt.
4. Open the Loophole toolbar button on an Iterable tab. If the popup shows **Allow Loophole on
   Iterable**, click it — Firefox sometimes asks you to allow an extension on a site the first
   time, separately from installing it.

**Updating in Firefox:** download the newer `.xpi` and install it the same way (drag it in, or
**Install Add-on From File…**). Firefox replaces the old version in place; your settings, keys and
saved runs are kept, because Loophole ships with a fixed add-on id.

**Chrome, Edge, Brave**

1. Download `loophole-chrome-<version>.zip` and unzip it into a folder you'll keep (for example
   `Documents\Loophole`) — Chrome loads the extension from that folder, it doesn't copy it in.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**,
   and pick that folder.
3. Reload any Iterable tabs that were already open.

**Updating in Chrome:** unzip the newer version into the **same folder**, overwriting the old
files, then go to `chrome://extensions` and click the reload icon on the Loophole card. Loading it
from a *different* folder instead works too, but Chrome then treats it as a separate install with
empty settings — see "Moving your data" below if you do that.

## Migrating from the Tampermonkey userscripts

If you're coming from the separate "Iterable User Push", "Iterable Field Value Explorer" and
similar Tampermonkey scripts:

1. In Tampermonkey, open **Dashboard → Utilities → Zip → Export**, with **Include script
   storage** ticked.
2. In Loophole, open **Settings → Import & export → Import from Tampermonkey**, and drop the zip.
3. Your API keys, saved tags, the UTM link-parameter library and other per-tool settings are
   carried across automatically.
4. Turn the old userscripts off in Tampermonkey afterwards, so the two don't both add UI to the
   same page.

## Moving your data (backup / restore)

Settings → **Import & export** can save and load a full settings backup:

- **Back up:** tick **Include API keys** if you want the restore to bring your keys back too (a
  backup without it is safe to share for support, since it has no keys in it).
- **Restore:** pick a backup file and choose which keys, if any, to bring back.

Use this when moving to a new browser profile, reinstalling from a different folder in Chrome, or
recovering after clearing browser data.

## First steps

1. **Add an API key for each project** under **Settings → Projects & keys** — or paste one
   straight into the toolbar popup while you're viewing that project in Iterable. Loophole works
   per project: a key you add for one project is never sent for another. Keys stay in your
   browser's local storage; they are never synced and are left out of a backup unless you tick
   **Include API keys**.
2. **Pick your tools** under **Settings → Features** — switch off anything you don't need.
3. Open the toolbar popup on any Iterable page to see which tools apply there and whether the
   current project has a key saved yet.

Only tools that write to Iterable — bulk pushes, profile edits, deletes, list/catalog uploads —
need a key at all. Everything that reads or previews works without one.

## Troubleshooting

- **Popup shows "Allow Loophole on Iterable"** — click it. This is Firefox's per-site permission
  prompt, separate from installing the add-on; it can reappear after an update.
- **Popup or a panel says "No project detected yet"** — Loophole reads the project from the page
  itself. Reload the Iterable tab; if it still doesn't show up, make sure you're on
  `app.iterable.com` or `app.eu.iterable.com` and not a login or redirect page.
- **A keyboard shortcut doesn't fire, or does something else** — another extension or a browser
  shortcut may already use that combination. Check and reassign it in your browser's own extension
  shortcuts page (`chrome://extensions/shortcuts` in Chrome/Edge; `about:addons` → gear icon →
  **Manage Extension Shortcuts** in Firefox).
- **Something looks wrong or a run failed** — see "Reporting a problem" below.

## Reporting a problem

Open an issue at <https://github.com/Colin-Whelan/loophole/issues> (the popup's **Report a
problem** button and **Settings → About** link there too). Include:

- the feature (every Loophole panel shows its name in the header) and the page URL path,
- what you expected and what happened,
- any `[Loophole:…]` lines from the browser console (turn on **Settings → General → Debug
  logging** for more detail),
- the Loophole version, shown in the popup header.

**Never paste API keys or customer data** — Loophole never logs keys, and a backup exported
without **Include API keys** is safe to attach if a settings dump would help.
