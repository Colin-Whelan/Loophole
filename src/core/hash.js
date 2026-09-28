// Stable, synchronous, non-cryptographic string hash for storage-key names (per-project state
// slots, dynamic-lists' per-user cache keys). Pure JS on purpose: crypto.subtle results can't be
// used from Firefox content scripts (the digest is a page-compartment ArrayBuffer behind an Xray;
// `new Uint8Array(digest).slice()` throws "Permission denied to access property 'constructor'").
// Not for anything security-relevant: it only keeps raw ids / names out of storage key names.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** 64-bit FNV-1a over the UTF-8 bytes of `str` → 16 lowercase hex digits. */
export function stableHash64(str) {
  const bytes = new TextEncoder().encode(String(str ?? ''));
  let h = FNV_OFFSET;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}
