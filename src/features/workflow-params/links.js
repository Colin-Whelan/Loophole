// "Links" section discovery and filling, kept from the userscript (selectors, text-based header
// discovery, field-by-label walking, checkbox + React-safe input handling). Everything takes the
// document/root and its helpers as arguments so it can be tested against small DOM fixtures.

export const SELECTORS = Object.freeze({
  headerCandidates: 'div, span, h1, h2, h3, h4',
  checkbox: '[data-test="interactive-checkbox"]',
  gaInput: '#google-analytics-input',
  addLinkParamBtn: '[data-test="medium-ghost-success-button"]',
  linkParamKey: 'input[id^="link-parameter-key-"]',
  linkParamValue: 'input[id^="link-parameter-value-"]',
  fieldFallback: '[data-test="form-field"], [data-test="google-analytics-form-section"]',
});

export const LABELS = Object.freeze({
  section: 'Links',
  ga: 'Google analytics',
  linkParams: 'Link parameters',
  addButton: 'Add link parameter',
});

const WAIT_TIMEOUT = 4000;
const TOGGLE_TIMEOUT = 2000;
const STEP_DELAY = 120;

const text = (el) => (el?.textContent || '').trim();
const sameLabel = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * The "Links" header: an element with no element children whose text is exactly "Links" and whose
 * parent contains a <label>. Iterable rotates styled-component class hashes, so no class selectors.
 */
export function findLinksSection(doc) {
  for (const el of doc.querySelectorAll(SELECTORS.headerCandidates)) {
    if (el.children.length === 0 && text(el) === LABELS.section) {
      if (el.parentElement?.querySelector('label')) return el;
    }
  }
  return null;
}

/**
 * The form-field block whose <label> reads `labelText`: first the Links header's following
 * siblings, then (DOM nesting differs between the journey and template editors) any form field in
 * the document.
 */
export function findFieldByLabel(doc, header, labelText) {
  if (!header) return null;
  for (let node = header.nextElementSibling; node; node = node.nextElementSibling) {
    const label = node.querySelector?.('label');
    if (label && sameLabel(text(label), labelText)) return node;
  }
  for (const f of doc.querySelectorAll(SELECTORS.fieldFallback)) {
    const label = f.querySelector('label');
    if (label && sameLabel(text(label), labelText)) return f;
  }
  return null;
}

export const isChecked = (checkbox) => checkbox?.getAttribute('aria-checked') === 'true';

/**
 * Which existing row each wanted parameter goes into. Idempotent: a row whose key already matches
 * is reused (so running twice adds nothing), then rows with a blank key, then new rows.
 *   rowKeys  current key-input values, in row order
 *   params   [{ key, value }] wanted
 * → { assign: [rowIndex, …] parallel to params (indexes ≥ rowKeys.length are rows to add), add }
 */
export function planRows(rowKeys, params) {
  const used = new Set();
  const assign = new Array(params.length).fill(-1);
  params.forEach((p, i) => {
    const idx = rowKeys.findIndex((k, j) => !used.has(j) && String(k ?? '').trim() === p.key);
    if (idx >= 0) { used.add(idx); assign[i] = idx; }
  });
  let next = rowKeys.length;
  params.forEach((p, i) => {
    if (assign[i] >= 0) return;
    const idx = rowKeys.findIndex((k, j) => !used.has(j) && !String(k ?? '').trim());
    if (idx >= 0) { used.add(idx); assign[i] = idx; } else assign[i] = next++;
  });
  return { assign, add: next - rowKeys.length };
}

// ── Filling ─────────────────────────────────────────────────────────────────

function abortError() {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Poll `predicate` until truthy (resolves its value) or `timeout` ms pass (rejects). */
export async function waitFor(predicate, { timeout = WAIT_TIMEOUT, interval = 80, signal, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const res = predicate();
    if (res) return res;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(interval, signal);
  }
}

async function setCheckbox(checkbox, desired, opts) {
  if (!checkbox) throw new Error('checkbox not found');
  if (isChecked(checkbox) === desired) return false;
  checkbox.click();
  await waitFor(() => isChecked(checkbox) === desired, { ...opts, timeout: TOGGLE_TIMEOUT, what: 'the checkbox' });
  return true;
}

async function applyGa(field, cfg, report, opts) {
  const checkbox = field.querySelector(SELECTORS.checkbox);
  if (!cfg.enableGA) {
    if (await setCheckbox(checkbox, false, opts)) report.filled.push('Google Analytics turned off');
    return;
  }
  const toggled = await setCheckbox(checkbox, true, opts);
  const input = await waitFor(() => field.querySelector(SELECTORS.gaInput), { ...opts, what: 'the campaign field' });
  if (input.value !== cfg.gaCampaign) {
    opts.setValue(input, cfg.gaCampaign);
    report.filled.push('GA campaign');
  } else if (toggled) {
    report.filled.push('Google Analytics on');
  } else {
    report.unchanged.push('GA campaign');
  }
}

async function applyLinkParams(field, cfg, report, opts) {
  const checkbox = field.querySelector(SELECTORS.checkbox);
  if (!cfg.enableLinkParams) {
    if (await setCheckbox(checkbox, false, opts)) report.filled.push('link parameters turned off');
    return;
  }
  const params = cfg.linkParams;
  // None configured (the default): leave Iterable's box and rows as they are. Ticking it would
  // only add an empty parameter row.
  if (!params.length) {
    report.unchanged.push('link parameters (none configured)');
    return;
  }
  const toggled = await setCheckbox(checkbox, true, opts);
  // Rows can render a beat after the checkbox flips; give them a moment before planning.
  if (toggled) await sleep(STEP_DELAY, opts.signal);
  const keys = () => [...field.querySelectorAll(SELECTORS.linkParamKey)];
  const plan = planRows(keys().map((k) => k.value), params);

  for (let i = 0; i < plan.add; i++) {
    const before = keys().length;
    const addBtn = [...field.querySelectorAll(SELECTORS.addLinkParamBtn)]
      .find((b) => (b.textContent || '').includes(LABELS.addButton));
    if (!addBtn) throw new Error('"Add link parameter" button not found');
    addBtn.click();
    await waitFor(() => keys().length > before, { ...opts, timeout: TOGGLE_TIMEOUT, what: 'a new parameter row' });
  }

  const keyInputs = keys();
  const valueInputs = [...field.querySelectorAll(SELECTORS.linkParamValue)];
  let changed = 0;
  for (let i = 0; i < params.length; i++) {
    const { key, value } = params[i];
    const keyInput = keyInputs[plan.assign[i]];
    const valueInput = valueInputs[plan.assign[i]];
    if (!keyInput || !valueInput) throw new Error(`parameter row for "${key}" not found`);
    let rowChanged = false;
    if (keyInput.value !== key) { opts.setValue(keyInput, key); rowChanged = true; }
    if (valueInput.value !== value) { opts.setValue(valueInput, value); rowChanged = true; }
    if (rowChanged) {
      changed++;
      await sleep(STEP_DELAY, opts.signal);
    }
  }
  const n = params.length;
  const label = `${n} link parameter${n === 1 ? '' : 's'}`;
  if (changed) report.filled.push(plan.add ? `${label} (${plan.add} row${plan.add === 1 ? '' : 's'} added)` : label);
  else report.unchanged.push(label);
}

/**
 * Fill the Links section of the panel in `doc` from `cfg` ({ enableGA, gaCampaign,
 * enableLinkParams, linkParams }). Never rejects except on abort.
 *   setValue(input, value)  React-safe setter (dom.setNativeValue)
 * → { section: boolean, filled: [], unchanged: [], missing: [], errors: [] } (human-readable parts)
 */
export async function applyToLinks(doc, cfg, { setValue, signal } = {}) {
  const report = { section: false, filled: [], unchanged: [], missing: [], errors: [] };
  const header = findLinksSection(doc);
  if (!header) return report;
  report.section = true;
  const opts = { setValue, signal };
  const steps = [
    [LABELS.ga, 'Google analytics field', applyGa],
    [LABELS.linkParams, 'Link parameters field', applyLinkParams],
  ];
  for (const [label, name, fn] of steps) {
    const field = findFieldByLabel(doc, header, label);
    if (!field) { report.missing.push(name); continue; }
    try {
      await fn(field, cfg, report, opts);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      report.errors.push(`${name}: ${e?.message || e}`);
    }
    await sleep(STEP_DELAY, signal);
  }
  return report;
}

/** One-line summary + tone for a toast. */
export function summarize(report) {
  if (!report.section) {
    return { tone: 'warn', message: 'Links section not visible. Open the Details panel first.' };
  }
  const parts = [];
  if (report.filled.length) parts.push(`Filled ${report.filled.join(', ')}.`);
  if (report.unchanged.length) parts.push(`Already set: ${report.unchanged.join(', ')}.`);
  if (report.missing.length) parts.push(`Not found: ${report.missing.join(', ')}.`);
  if (report.errors.length) parts.push(`Problems: ${report.errors.join('; ')}.`);
  if (!parts.length) parts.push('Nothing to do: both options are off and already unticked.');
  const tone = report.errors.length ? 'bad' : report.missing.length ? 'warn' : 'ok';
  return { tone, message: parts.join(' ') };
}
