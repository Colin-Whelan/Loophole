// Bundles src/ into dist/chrome and dist/firefox (ARCHITECTURE §3).
//   node scripts/build.mjs           one build
//   node scripts/build.mjs --watch   rebuild on change
//   node scripts/build.mjs --check   full build into a temp dir (dist/ untouched); exit 1 on errors

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, mkdtemp, rm, cp, readdir, stat } from 'node:fs/promises';
import { existsSync, watch as fsWatch } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const require = createRequire(import.meta.url);
const WATCH = process.argv.includes('--watch');
const CHECK = process.argv.includes('--check');

const BROWSERS = ['chrome', 'firefox'];
const GECKO_ID = 'loophole@colin-whelan';
const CHROME_MIN = '111';
// 140: browser_specific_settings.gecko.data_collection_permissions (web-ext lint warns below it).
const FIREFOX_MIN = '140.0';
// Firefox for Android only supports data_collection_permissions from 142. Without a
// gecko_android minimum, lint assumes Android inherits FIREFOX_MIN and warns.
const FIREFOX_ANDROID_MIN = '142.0';

// entry source → output file (flat in the dist root; manifest.base.json refers to these names)
const ENTRIES = {
  'background/index.js': 'background.js',
  'content/app.js': 'content-app.js',
  'content/bee.js': 'content-bee.js',
  // Registered at runtime by the background (frame:'auth'), never listed in the static manifest.
  'content/auth.js': 'content-auth.js',
  'page/main-world.js': 'main-world.js',
  'popup/popup.js': 'popup.js',
  'options/options.js': 'options.js',
  // Extension page that shows a handed-over approval capture (never web-accessible).
  'capture/capture.js': 'capture.js',
};
// Built (and listed in the manifest) only when a feature running in bee frames ships a main.js.
const BEE_MAIN_ENTRY = ['page/main-world-bee.js', 'main-world-bee.js'];

// Copied as-is: source (relative to src) → destination (relative to the dist root)
const STATIC = {
  'popup/popup.html': 'popup.html',
  'popup/popup.css': 'popup.css',
  'options/options.html': 'options.html',
  'options/options.css': 'options.css',
  'capture/capture.html': 'capture.html',
  'capture/capture.css': 'capture.css',
  'ui/theme.css': 'theme.css',
  icons: 'icons',
};

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

// ── Virtual modules: optional per-feature files (import.js, settings-ui.js) ──

async function featureDirs() {
  const dir = path.join(SRC, 'features');
  const out = [];
  for (const name of await readdir(dir)) {
    if ((await stat(path.join(dir, name))).isDirectory()) out.push(name);
  }
  return out.sort();
}

function optionalFeaturesPlugin() {
  const files = { 'wb-virtual:importers': 'import.js', 'wb-virtual:settings-ui': 'settings-ui.js' };
  return {
    name: 'wb-features',
    setup(build) {
      build.onResolve({ filter: /^wb-virtual:(importers|settings-ui)$/ }, (args) => ({ path: args.path, namespace: 'wb-virtual' }));
      build.onLoad({ filter: /.*/, namespace: 'wb-virtual' }, async (args) => {
        const file = files[args.path];
        if (!file) return { errors: [{ text: `Unknown virtual module ${args.path}` }] };
        const lines = [];
        const entries = [];
        const watchDirs = [];
        for (const [i, id] of (await featureDirs()).entries()) {
          const dir = path.join(SRC, 'features', id);
          watchDirs.push(dir);
          const full = path.join(dir, file);
          if (!existsSync(full)) continue;
          lines.push(`import * as m${i} from ${JSON.stringify(full.replace(/\\/g, '/'))};`);
          entries.push(`${JSON.stringify(id)}: m${i}`);
        }
        lines.push(`export default Object.freeze({ ${entries.join(', ')} });`);
        return { contents: lines.join('\n'), resolveDir: SRC, loader: 'js', watchDirs };
      });
    },
  };
}

// ── Virtual modules: per-frame feature implementations ───────────────────
//
// `wb-virtual:impls/<frame>` → `{ [featureId]: index.js module }` for every feature in
// features/registry.js whose meta.frame is <frame> ('top' when unset). Each content entry imports
// only its own frame's map, so content-bee.js doesn't carry the top-frame features and vice versa.
// The registry is bundled and evaluated fresh on every (re)build, so watch mode sees meta edits.

async function loadRegistry() {
  const res = await esbuild.build({
    entryPoints: [path.join(SRC, 'features/registry.js')],
    bundle: true, format: 'esm', platform: 'neutral', write: false, metafile: true, logLevel: 'silent',
  });
  const code = res.outputFiles[0].text;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const inputs = Object.keys(res.metafile.inputs).map((f) => path.resolve(ROOT, f));
  return { features: mod.FEATURES, inputs };
}

// Pure helpers shared with the runtime (no chrome.*, no DOM), imported straight from src/.
const featureFrames = await import(pathToFileURL(path.join(SRC, 'core/feature-frames.js')).href);
const { FRAMES, homeFrame, runsIn, validateFrameMetas, featureOrigins, patternOrigin } = featureFrames;
const { compileFrameMessages } = await import(pathToFileURL(path.join(SRC, 'core/frames.js')).href);
const { AUTH_ORIGINS } = await import(pathToFileURL(path.join(SRC, 'core/api-validation.js')).href);

async function readBaseManifest() {
  return JSON.parse(await readFile(path.join(SRC, 'manifest.base.json'), 'utf8'));
}

async function filesOf(id) {
  try { return new Set(await readdir(path.join(SRC, 'features', id))); } catch { return new Set(); }
}

/**
 * Evaluate the registry and check every frame-related meta field (ARCHITECTURE §6.2, §8.1):
 * frames / companions and their files, optional-permission origins, frame message schemas.
 * → { features, inputs, errors, mainIds: { [frame]: [featureId] }, hasAuth }
 */
async function analyzeFeatures() {
  const registry = await loadRegistry();
  const base = await readBaseManifest();
  const files = new Map();
  for (const meta of registry.features) files.set(meta.id, await filesOf(meta.id));
  const errors = validateFrameMetas(registry.features, {
    files: (id) => files.get(id) || new Set(),
    optionalOrigins: base.optional_host_permissions || [],
    requiredOrigins: base.host_permissions || [],
  });
  for (const meta of registry.features) {
    try { compileFrameMessages(meta.frameMessages, meta.id); } catch (e) { errors.push(e.message); }
    if (homeFrame(meta) === 'auth') {
      for (const o of featureOrigins(meta)) {
        if (!AUTH_ORIGINS.includes(patternOrigin(o))) errors.push(`Feature "${meta.id}": ${o} is not in AUTH_ORIGINS (core/api-validation.js), so the background would refuse its messages`);
      }
    }
  }
  // An optional host must never appear in the static content scripts (it would become required).
  const optional = new Set(base.optional_host_permissions || []);
  for (const cs of base.content_scripts || []) {
    for (const m of cs.matches || []) if (optional.has(m)) errors.push(`manifest.base.json content_scripts match optional host ${m}`);
  }
  const mainIds = {};
  for (const frame of FRAMES) {
    mainIds[frame] = registry.features.filter((m) => runsIn(m, frame) && files.get(m.id)?.has('main.js')).map((m) => m.id);
  }
  const hasAuth = registry.features.some((m) => homeFrame(m) === 'auth');
  return { ...registry, errors, mainIds, hasAuth };
}

function implsPlugin() {
  return {
    name: 'wb-impls',
    setup(build) {
      build.onResolve({ filter: /^wb-virtual:impls\// }, (args) => ({ path: args.path, namespace: 'wb-impls' }));
      build.onLoad({ filter: /.*/, namespace: 'wb-impls' }, async (args) => {
        const frame = args.path.slice('wb-virtual:impls/'.length);
        if (!FRAMES.includes(frame)) return { errors: [{ text: `Unknown frame in ${args.path} (expected ${FRAMES.join(' | ')})` }] };
        let registry;
        try {
          registry = await analyzeFeatures();
        } catch (e) {
          return { errors: [{ text: `Could not evaluate features/registry.js: ${e.message}` }] };
        }
        const lines = [];
        const entries = [];
        const errors = registry.errors.map((text) => ({ text }));
        for (const [i, meta] of registry.features.entries()) {
          if (!runsIn(meta, frame)) continue;
          if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.id)) { errors.push({ text: `Feature id "${meta.id}" is not kebab-case` }); continue; }
          // Home frame → index.js; companion frame (meta.companionFrames) → <frame>.js.
          const file = homeFrame(meta) === frame ? 'index.js' : `${frame}.js`;
          const full = path.join(SRC, 'features', meta.id, file);
          if (!existsSync(full)) {
            errors.push({ text: `Feature "${meta.id}" has no src/features/${meta.id}/${file}` });
            continue;
          }
          lines.push(`import * as f${i} from ${JSON.stringify(full.replace(/\\/g, '/'))};`);
          entries.push(`${JSON.stringify(meta.id)}: f${i}`);
        }
        if (errors.length) return { errors };
        lines.push(`export default Object.freeze({ ${entries.join(', ')} });`);
        const watchDirs = registry.features.map((m) => path.join(SRC, 'features', m.id));
        return { contents: lines.join('\n'), resolveDir: SRC, loader: 'js', watchFiles: registry.inputs, watchDirs };
      });
    },
  };
}

// ── Virtual modules: page-world handlers (features/<id>/main.js) ────────
//
// `wb-virtual:main/<frame>` → `{ [featureId]: main.js module }` for the features that run in
// <frame> (home or companion) and ship a main.js; bundled into that frame's MAIN-world script
// (page/main-world.js for top, page/main-world-bee.js for bee). `wb-virtual:has-main/<frame>` →
// a boolean, so the isolated entry knows whether a MAIN-world script runs beside it.

function mainPlugin() {
  return {
    name: 'wb-main',
    setup(build) {
      build.onResolve({ filter: /^wb-virtual:(has-)?main\// }, (args) => ({ path: args.path, namespace: 'wb-main' }));
      build.onLoad({ filter: /.*/, namespace: 'wb-main' }, async (args) => {
        const m = /^wb-virtual:(has-)?main\/(.+)$/.exec(args.path);
        const frame = m && m[2];
        if (!FRAMES.includes(frame) || frame === 'auth') return { errors: [{ text: `Unknown MAIN-world frame in ${args.path}` }] };
        let registry;
        try { registry = await analyzeFeatures(); } catch (e) { return { errors: [{ text: `Could not evaluate features/registry.js: ${e.message}` }] }; }
        if (registry.errors.length) return { errors: registry.errors.map((text) => ({ text })) };
        const ids = registry.mainIds[frame];
        const watchDirs = registry.features.map((f) => path.join(SRC, 'features', f.id));
        if (m[1]) return { contents: `export default ${ids.length > 0};`, loader: 'js', watchFiles: registry.inputs, watchDirs };
        const lines = [];
        const entries = [];
        ids.forEach((id, i) => {
          const full = path.join(SRC, 'features', id, 'main.js');
          lines.push(`import * as p${i} from ${JSON.stringify(full.replace(/\\/g, '/'))};`);
          entries.push(`${JSON.stringify(id)}: p${i}`);
        });
        lines.push(`export default Object.freeze({ ${entries.join(', ')} });`);
        return { contents: lines.join('\n'), resolveDir: SRC, loader: 'js', watchFiles: registry.inputs, watchDirs };
      });
    },
  };
}

// ── Manifest ─────────────────────────────────────────────────────────────

async function manifestFor(browser, analysis) {
  const m = await readBaseManifest();
  m.version = pkg.version;
  // Runtime registration of frame:'auth' content scripts (background/index.js). Only when such a
  // feature exists: no feature, no permission.
  if (analysis.hasAuth && !m.permissions.includes('scripting')) m.permissions.push('scripting');
  if (analysis.mainIds.bee.length) {
    m.content_scripts.push({
      matches: ['https://app.getbee.io/*'], js: [BEE_MAIN_ENTRY[1]], all_frames: true, world: 'MAIN', run_at: 'document_start',
    });
  }
  if (browser === 'chrome') {
    m.background = { service_worker: 'background.js' };
    m.minimum_chrome_version = CHROME_MIN;
  } else {
    m.background = { scripts: ['background.js'] };
    // Loophole sends nothing anywhere except the user's own Iterable account.
    m.browser_specific_settings = {
      gecko: { id: GECKO_ID, strict_min_version: FIREFOX_MIN, data_collection_permissions: { required: ['none'] } },
      gecko_android: { strict_min_version: FIREFOX_ANDROID_MIN },
    };
  }
  return m;
}

// ── Static files + fonts ─────────────────────────────────────────────────

async function copyStatic(outdir) {
  for (const [from, to] of Object.entries(STATIC)) {
    const src = path.join(SRC, from);
    if (!existsSync(src)) continue;
    await cp(src, path.join(outdir, to), { recursive: true });
  }
  const { FONT_FILES, fontFaceCss } = await import(pathToFileURL(path.join(SRC, 'ui/fonts.js')).href);
  await mkdir(path.join(outdir, 'fonts'), { recursive: true });
  for (const f of FONT_FILES) {
    await cp(require.resolve(f.source), path.join(outdir, 'fonts', f.file));
  }
  // Extension pages load fonts.css with relative URLs; Iterable pages get the same rules from
  // ui/fonts.js injectPageFonts() with chrome.runtime.getURL.
  await writeFile(path.join(outdir, 'fonts.css'), fontFaceCss((file) => `fonts/${file}`) + '\n');
}

async function writeManifest(browser, outdir, analysis) {
  const a = analysis || await analyzeFeatures();
  if (a.errors.length) throw new Error(a.errors.join('\n'));
  await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(await manifestFor(browser, a), null, 2) + '\n');
}

// ── esbuild ──────────────────────────────────────────────────────────────

function entryPoints(analysis) {
  const out = [];
  const entries = { ...ENTRIES };
  if (analysis?.mainIds.bee.length) entries[BEE_MAIN_ENTRY[0]] = BEE_MAIN_ENTRY[1];
  for (const [src, dest] of Object.entries(entries)) {
    const full = path.join(SRC, src);
    if (!existsSync(full)) {
      console.warn(`[build] missing entry src/${src}; ${dest} will not be built`);
      continue;
    }
    out.push({ in: full, out: dest.replace(/\.js$/, '') });
  }
  return out;
}

function esbuildOptions(outdir, analysis) {
  return {
    entryPoints: entryPoints(analysis),
    outdir,
    bundle: true,
    format: 'iife',
    target: ['chrome' + CHROME_MIN, 'firefox' + parseInt(FIREFOX_MIN, 10)],
    loader: { '.css': 'text' },
    charset: 'utf8',
    legalComments: 'none',
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
    plugins: [optionalFeaturesPlugin(), implsPlugin(), mainPlugin()],
  };
}

async function buildOnce(root = DIST) {
  const analysis = await analyzeFeatures();
  if (analysis.errors.length) {
    for (const e of analysis.errors) console.error('[build] ' + e);
    throw new Error(`${analysis.errors.length} feature error(s)`);
  }
  for (const browser of BROWSERS) {
    const outdir = path.join(root, browser);
    await rm(outdir, { recursive: true, force: true });
    await mkdir(outdir, { recursive: true });
    await esbuild.build(esbuildOptions(outdir, analysis));
    await copyStatic(outdir);
    await writeManifest(browser, outdir, analysis);
  }
}

/** The same pipeline as a real build, into a throwaway directory. */
async function checkOnce() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-check-'));
  try {
    await buildOnce(tmp);
    const sizes = [];
    for (const dest of [...Object.values(ENTRIES), BEE_MAIN_ENTRY[1]]) {
      const f = path.join(tmp, 'chrome', dest);
      if (existsSync(f)) sizes.push(`${dest} ${((await stat(f)).size / 1024).toFixed(1)} KB`);
    }
    console.log(`[check] ok: every entry builds for ${BROWSERS.join(' + ')} (${sizes.join(', ')})`);
  } catch (e) {
    // esbuild has already printed the errors.
    console.error(`[check] failed${e?.errors ? '' : ': ' + (e?.message || e)}`);
    process.exitCode = 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function watchMode() {
  // Entry points are fixed for the session: adding the first bee main.js needs a restart.
  const analysis = await analyzeFeatures();
  for (const browser of BROWSERS) {
    const outdir = path.join(DIST, browser);
    await rm(outdir, { recursive: true, force: true });
    await mkdir(outdir, { recursive: true });
    await copyStatic(outdir);
    await writeManifest(browser, outdir, analysis).catch((e) => console.error('[watch] manifest: ' + e.message));
    const ctx = await esbuild.context({
      ...esbuildOptions(outdir, analysis),
      plugins: [...esbuildOptions(outdir, analysis).plugins, {
        name: 'wb-log',
        setup(b) { b.onEnd((r) => console.log(`[watch] ${browser}: ${r.errors.length ? r.errors.length + ' error(s)' : 'rebuilt'}`)); },
      }],
    });
    await ctx.watch();
  }
  // esbuild only watches what it bundles; html/css/manifest/icons are copied on change.
  let timer = null;
  fsWatch(SRC, { recursive: true }, (_event, file) => {
    if (!file || /\.js$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      for (const browser of BROWSERS) {
        const outdir = path.join(DIST, browser);
        await copyStatic(outdir);
        await writeManifest(browser, outdir).catch((e) => console.error('[watch] manifest: ' + e.message));
      }
      console.log(`[watch] static files copied (${file})`);
    }, 100);
  });
  console.log('[watch] watching src/ ...');
}

if (CHECK) await checkOnce();
else if (WATCH) await watchMode();
else {
  await buildOnce();
  console.log(`[build] dist/chrome and dist/firefox built (v${pkg.version})`);
}
