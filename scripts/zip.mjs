// dist/<browser> → release/workbench-<browser>-<version>.zip (manifest.json at the zip root).
// Run after a build (`npm run zip` does both).

import { zipSync } from 'fflate';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

async function collect(dir, base = dir, out = {}) {
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) await collect(full, base, out);
    else out[path.relative(base, full).split(path.sep).join('/')] = new Uint8Array(await readFile(full));
  }
  return out;
}

await mkdir(path.join(ROOT, 'release'), { recursive: true });
for (const browser of ['chrome', 'firefox']) {
  const dir = path.join(ROOT, 'dist', browser);
  if (!existsSync(path.join(dir, 'manifest.json'))) {
    console.error(`[zip] dist/${browser} is not built; run npm run build first`);
    process.exitCode = 1;
    continue;
  }
  const files = await collect(dir);
  // Fixed mtime keeps zips reproducible for the same content.
  const zipped = zipSync(files, { level: 9, mtime: new Date('2020-01-01T00:00:00Z') });
  const out = path.join(ROOT, 'release', `workbench-${browser}-${pkg.version}.zip`);
  await writeFile(out, zipped);
  console.log(`[zip] ${path.relative(ROOT, out)} (${Object.keys(files).length} files, ${(zipped.length / 1024).toFixed(0)} KB)`);
}
