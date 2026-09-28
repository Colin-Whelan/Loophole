// Userscript name handling (ARCHITECTURE §8.4). Pure.

/**
 * Normalise a userscript name for matching: case-folded, accents and punctuation dropped, and a
 * leading "Iterable" / "Iterable -" prefix ignored, so renamed copies still match.
 *   "Iterable - Link Param Helper" → "linkparamhelper"
 *   "iterable delete-user (copy)"  → "deleteusercopy"
 */
export function normalizeScriptName(name) {
  const s = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  const withoutPrefix = s.replace(/^iterable(?![a-z0-9])[\s\p{P}\p{S}]*/u, '');
  const out = withoutPrefix.replace(/[^a-z0-9]+/g, '');
  // A script literally named "Iterable" keeps its name rather than normalising to nothing.
  return out || s.replace(/[^a-z0-9]+/g, '');
}

export function sameScript(a, b) {
  const na = normalizeScriptName(a);
  return !!na && na === normalizeScriptName(b);
}

/** The `// @name` from a userscript header, or null. */
export function userScriptName(source) {
  const header = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(String(source || ''));
  if (!header) return null;
  const m = /^\s*\/\/\s*@name\s+(.+?)\s*$/m.exec(header[1]);
  return m ? m[1] : null;
}

/** File name without directories and without the Tampermonkey suffixes. */
export function fileStem(path) {
  const file = String(path).split(/[\\/]/).pop();
  return file
    .replace(/\.(storage|options)\.json$/i, '')
    .replace(/\.user\.js$/i, '')
    .replace(/\.json$/i, '');
}
