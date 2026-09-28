// Node stand-in for the build's `wb-virtual:importers` module (scripts/build.mjs), so tests can
// import modules that use it (the background). Import this file before those modules.

import { register } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const FEATURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/features');

function importersModule() {
  const lines = [];
  const entries = [];
  readdirSync(FEATURES).sort().forEach((id, i) => {
    const file = path.join(FEATURES, id, 'import.js');
    if (!existsSync(file)) return;
    lines.push(`import * as m${i} from ${JSON.stringify(pathToFileURL(file).href)};`);
    entries.push(`${JSON.stringify(id)}: m${i}`);
  });
  lines.push(`export default Object.freeze({ ${entries.join(', ')} });`);
  return 'data:text/javascript,' + encodeURIComponent(lines.join('\n'));
}

const hooks = `
const MAP = ${JSON.stringify({ 'wb-virtual:importers': importersModule() })};
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(MAP, specifier)) return { url: MAP[specifier], shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));
