// Bundled IBM Plex fonts (latin subset), copied from @fontsource by scripts/build.mjs.
// Family names are prefixed "WB" so they never collide with anything on the host page.
// FONT_FILES is also read by the build to copy the files and write fonts.css for extension pages.

export const FONT_FILES = Object.freeze([
  { family: 'WB Plex Sans', weight: 400, file: 'plex-sans-400.woff2', source: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2' },
  { family: 'WB Plex Sans', weight: 500, file: 'plex-sans-500.woff2', source: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2' },
  { family: 'WB Plex Sans', weight: 600, file: 'plex-sans-600.woff2', source: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2' },
  { family: 'WB Plex Sans', weight: 700, file: 'plex-sans-700.woff2', source: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-700-normal.woff2' },
  { family: 'WB Plex Mono', weight: 400, file: 'plex-mono-400.woff2', source: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2' },
  { family: 'WB Plex Mono', weight: 500, file: 'plex-mono-500.woff2', source: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2' },
  { family: 'WB Plex Mono', weight: 600, file: 'plex-mono-600.woff2', source: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2' },
]);

/** @font-face CSS; `urlFor(file)` maps a font file name to its URL. */
export function fontFaceCss(urlFor) {
  return FONT_FILES.map((f) =>
    `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};font-display:swap;` +
    `src:url("${urlFor(f.file)}") format("woff2");}`).join('\n');
}

/**
 * Iterable pages: @font-face inside a shadow root is ignored by Chrome, so the rules go into the
 * page's <head> once, pointing at web-accessible extension URLs. If the page CSP blocks the
 * fonts, the fallback stack in theme.css applies.
 */
export function injectPageFonts() {
  if (document.getElementById('wb-fonts')) return;
  const style = document.createElement('style');
  style.id = 'wb-fonts';
  style.textContent = fontFaceCss((file) => chrome.runtime.getURL('fonts/' + file));
  (document.head || document.documentElement).append(style);
}
