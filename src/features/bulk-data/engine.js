// Bulk data: the run engine, shared by every tab that streams a CSV into batched API calls
// (Users, Lists, Catalogs). DOM-free: the tab supplies callbacks for building items,
// sending batches and saving checkpoints, and renders from onLog / onChange.
//
// Lifted from the "Iterable User Push" userscript's Run (the "Iterable Catalog Push" one is the
// same loop): stream rows, skip committed rows on resume, batch, send, record failures,
// checkpoint after every batch, pause between batches, stop on request or on a fatal status.

import { streamRows as coreStreamRows, countDataRows as coreCountDataRows, rowToObject } from '../../core/csv.js';
import { classifyFailure, FAILURE_CAP, RETRY_ROW_CAP, nf, fmtDuration } from './logic.js';

/**
 * new Run(cfg)
 *   file, header, batchSize
 *   buildItem(obj) → item | null | { skip: { reason, detail, ...identifier columns } }
 *                   null = no key (reason missing_key); { skip } = any other unusable row. A
 *                   skipped row is recorded in the failures, not sent, and still committed.
 *   skipRecord(obj, rowNum) → failure record for a null item (the columns other than
 *                           row_number/reason/detail), e.g. { userId: '', email: '' }
 *   weightOf(item), maxBatchWeight (optional): a batch is closed early, before the item that
 *                   would take its total weight past maxBatchWeight (request body size cap)
 *   idsOf(obj) → identifier columns for a failed-batch record, e.g. { userId, email }
 *   sendBatch(items, run) → Promise<sendWithRetry result> ({ ok, status, data, error, fatal })
 *   onBatchOk(result, items, run) → { success, fail }  (records partial failures itself)
 *   countCleared(item) → number (optional; feeds stats.cleared)
 *   checkpoints: { save(data) → Promise, clear() → Promise }
 *   checkpointMeta: object merged into every checkpoint (target, project, clear set…)
 *   onLog(msg, cls), onChange(run)
 *   signal: AbortSignal (unmount); aborting ends the run like Stop, keeping the checkpoint
 *   io: { streamRows, countDataRows } (tests)
 */
export class Run {
  constructor(cfg) {
    this.cfg = cfg;
    this.stats = emptyStats();
    this.failures = [];
    this.retryRows = [];
    this.committed = 0;
    this.totalRows = 0;
    this.batchNo = 0;
    this.paused = false;
    this.stopRequested = false;
    this.running = false;
    this.finished = false;   // ran to the end of the file
    this.fatal = null;       // classifyFailure() result of the status that ended the run
    this.aborted = false;    // unmounted mid-run
    this.startTime = 0;
    this.startOffset = 0;
    this.truncatedNotice = false;
    this._resumeWaiter = null;
  }

  log(msg, cls) { this.cfg.onLog?.(msg, cls || ''); }
  changed() { this.cfg.onChange?.(this); }

  addFailure(reason, count = 1) {
    this.stats.failed += count;
    this.stats.failReasons[reason] = (this.stats.failReasons[reason] || 0) + count;
  }

  /** record: { row_number, reason, detail, ...identifier columns } */
  addFailureRecord(record) {
    if (this.failures.length >= FAILURE_CAP) {
      if (!this.truncatedNotice) {
        this.truncatedNotice = true;
        this.log('The failure list reached ' + nf(FAILURE_CAP) + ' entries. Further failures are counted but not listed.', 'warn');
      }
      return;
    }
    this.failures.push({ ...record, detail: String(record.detail || '').slice(0, 500) });
  }

  noteRetry() { this.stats.retries++; this.changed(); }

  snapshot() {
    const pct = this.totalRows ? Math.min(100, (this.committed / this.totalRows) * 100) : 0;
    const elapsed = this.startTime ? (Date.now() - this.startTime) / 1000 : 0;
    const rate = elapsed > 0 ? (this.committed - this.startOffset) / elapsed : 0;
    const eta = rate > 0 ? (this.totalRows - this.committed) / rate : Infinity;
    return { pct, rate, eta };
  }

  pause() { if (this.running) { this.paused = true; this.changed(); } }
  resume() {
    this.paused = false;
    if (this._resumeWaiter) this._resumeWaiter();
    this.changed();
  }
  stop() {
    this.stopRequested = true;
    this.paused = false;
    if (this._resumeWaiter) this._resumeWaiter();
    this.changed();
  }

  async _awaitResume() {
    this.changed();
    await new Promise((resolve) => { this._resumeWaiter = resolve; });
    this._resumeWaiter = null;
    this.changed();
  }

  async _checkpoint() {
    try {
      await this.cfg.checkpoints?.save({
        ...(this.cfg.checkpointMeta || {}),
        committedRows: this.committed,
        totalRows: this.totalRows,
        stats: this.stats,
        savedAt: new Date().toISOString(),
      });
    } catch (e) {
      this.log('Could not save progress: ' + (e?.message || e), 'warn');
    }
  }

  /** Send one accumulated batch and record its outcome, then checkpoint. */
  async _flushBatch(batchFields, batchNums, batchItems) {
    this.batchNo++;
    const t0 = Date.now();
    if (batchItems.length) {
      const res = await this.cfg.sendBatch(batchItems, this);
      if (!res.ok) {
        const f = classifyFailure(res);
        this.addFailure(f.reason, batchItems.length);
        for (let i = 0; i < batchFields.length; i++) {
          if (this.retryRows.length < RETRY_ROW_CAP) this.retryRows.push(batchFields[i]);
          const obj = rowToObject(this.cfg.header, batchFields[i]);
          this.addFailureRecord({ row_number: batchNums[i], ...this.cfg.idsOf(obj), reason: f.reason, detail: f.detail });
        }
        this.log('Batch ' + this.batchNo + ' failed (' + nf(batchItems.length) + ' rows): ' + f.summary +
          '. Rows are in the failures file.', 'bad');
        if (res.fatal) this.fatal = { ...f, status: res.status };
      } else {
        const r = this.cfg.onBatchOk(res, batchItems, this);
        let success = r.success;
        if (!success && !r.fail) success = batchItems.length;
        this.stats.sentOk += success;
        this.log('Batch ' + this.batchNo + ': ' + nf(batchItems.length) + ' rows, ' + nf(success) + ' ok, ' +
          nf(r.fail) + ' failed, ' + ((Date.now() - t0) / 1000).toFixed(2) + 's', r.fail ? 'warn' : 'ok');
      }
    }
    // A fatal batch is not committed: after fixing the key, resuming re-sends it.
    if (!this.fatal) {
      this.committed += batchFields.length;
      await this._checkpoint();
    }
    this.changed();
  }

  /**
   * Run from `startOffset` committed rows (0 for a fresh run). priorStats come from a
   * checkpoint so the counters carry on. Resolves with this run; never rejects.
   */
  async start(startOffset = 0, priorStats = null) {
    const cfg = this.cfg;
    const io = cfg.io || {};
    const streamRows = io.streamRows || coreStreamRows;
    const countDataRows = io.countDataRows || coreCountDataRows;

    this.running = true;
    this.stopRequested = false;
    this.startOffset = startOffset || 0;
    this.committed = this.startOffset;
    if (priorStats) {
      this.stats = {
        ...emptyStats(),
        rowsRead: Math.min(priorStats.rowsRead || 0, this.startOffset),
        sentOk: priorStats.sentOk || 0,
        failed: priorStats.failed || 0,
        skipped: priorStats.skipped || 0,
        cleared: priorStats.cleared || 0,
        collisions: priorStats.collisions || 0,
        retries: priorStats.retries || 0,
        failReasons: { ...(priorStats.failReasons || {}) },
      };
    }
    this.batchNo = Math.floor(this.startOffset / cfg.batchSize);
    const onAbort = () => this.stop();
    cfg.signal?.addEventListener('abort', onAbort, { once: true });

    let batchFields = [], batchNums = [], batchItems = [];
    let endedEarly = false;   // the stream was cut short (stop, fatal, abort) or rows were left unsent
    try {
      this.log('Counting rows…');
      this.changed();
      this.totalRows = await countDataRows(cfg.file);
      this.log('The file has ' + nf(this.totalRows) + ' data rows.' +
        (this.startOffset ? ' Resuming after row ' + nf(this.startOffset) + '.' : ''));
      this.startTime = Date.now();
      this.changed();

      let batchWeight = 0;
      // Send the open batch; → 'stop' when the run must end there (fatal, stop requested).
      const flush = async () => {
        await this._flushBatch(batchFields, batchNums, batchItems);
        batchFields = []; batchNums = []; batchItems = []; batchWeight = 0;
        if (this.fatal) return 'stop';
        if (this.paused && !this.stopRequested) await this._awaitResume();
        if (this.stopRequested) return 'stop';
        return undefined;
      };

      await streamRows(cfg.file, async (fields, rowNum) => {
        if (this.stopRequested) { endedEarly = true; return 'stop'; }
        if (rowNum <= this.startOffset) return undefined;   // fast-skip committed rows
        const obj = rowToObject(cfg.header, fields);
        const item = cfg.buildItem(obj);
        const skip = item === null
          ? { ...(cfg.skipRecord ? cfg.skipRecord(obj) : {}), reason: 'missing_key', detail: 'row has neither userId nor email' }
          : (item && item.skip) || null;
        if (!skip && cfg.maxBatchWeight && cfg.weightOf) {
          const w = cfg.weightOf(item);
          if (batchItems.length && batchWeight + w > cfg.maxBatchWeight && (await flush()) === 'stop') {
            endedEarly = true;
            return 'stop';
          }
          batchWeight += w;
        }
        this.stats.rowsRead++;
        if (skip) {
          this.stats.skipped++;
          this.addFailureRecord({ row_number: rowNum, ...skip });
        } else {
          if (cfg.countCleared) this.stats.cleared += cfg.countCleared(item);
          batchItems.push(item);
        }
        batchFields.push(fields);
        batchNums.push(rowNum);

        if (batchFields.length >= cfg.batchSize && (await flush()) === 'stop') { endedEarly = true; return 'stop'; }
        return undefined;
      });

      if (batchFields.length) {
        if (!this.stopRequested && !this.fatal) await this._flushBatch(batchFields, batchNums, batchItems);
        else endedEarly = true;
      }
    } catch (err) {
      if (err?.name === 'AbortError' || cfg.signal?.aborted) {
        this.aborted = true;
      } else {
        this.running = false;
        this.log('Run ended with an error: ' + (err?.message || err) + '. Progress up to the last batch is saved.', 'bad');
        this.error = err;
        this.changed();
        cfg.signal?.removeEventListener('abort', onAbort);
        return this;
      }
    }
    cfg.signal?.removeEventListener('abort', onAbort);

    this.running = false;
    this.paused = false;
    const elapsed = this.startTime ? (Date.now() - this.startTime) / 1000 : 0;
    if (this.fatal) {
      this.log('Stopped at row ' + nf(this.committed) + ' of ' + nf(this.totalRows) + ': ' + this.fatal.summary +
        ' would fail every remaining batch. Progress is saved; fix the problem and select the file again to resume.', 'bad');
    } else if (endedEarly || this.aborted) {
      this.log('Stopped at row ' + nf(this.committed) + ' of ' + nf(this.totalRows) +
        '. Progress is saved; select the same file again to resume.', 'warn');
    } else {
      this.finished = true;
      try { await cfg.checkpoints?.clear(); } catch { /* a stale checkpoint only re-offers resume */ }
      const s = this.stats;
      this.log('Done. ' + nf(s.rowsRead) + ' rows read, ' + nf(s.sentOk) + ' ok, ' + nf(s.failed) + ' failed, ' +
        nf(s.skipped) + ' skipped' + (s.cleared ? ', ' + nf(s.cleared) + ' fields cleared' : '') +
        (s.collisions ? ', ' + nf(s.collisions) + ' duplicate IDs collapsed' : '') +
        ' in ' + fmtDuration(elapsed) + '.', 'ok');
      for (const reason of Object.keys(s.failReasons)) {
        this.log('  ' + reason + ': ' + nf(s.failReasons[reason]), 'warn');
      }
    }
    this.changed();
    return this;
  }
}

function emptyStats() {
  // collisions: duplicate item IDs collapsed inside one catalog batch (Catalogs tab only).
  return { rowsRead: 0, sentOk: 0, failed: 0, skipped: 0, cleared: 0, collisions: 0, retries: 0, failReasons: {} };
}
