// Email HTML check rules. Pure: every rule works on the HTML string with regular expressions (as
// the userscript's did), so they run unchanged in Node tests and in the content script.
//
// Rule: { id, category, label, description, severity, defaultOn, run(html) → issues }
//   id        stable forever: it is the settings key (and the userscript's emailScannerSettings key)
//   severity  the rule's usual severity (an issue may carry a different one)
// Issue: { severity: 'error' | 'warning' | 'info', message, snippet?, note? }
//
// Port of "Iterable Email HTML Scanner" v2.0.0. Logic is kept as it was except for the false
// positives and bugs marked FIX below (see the port notes in index.js).

export const CATEGORIES = Object.freeze(['Structure / HTML', 'Accessibility', 'Deliverability', 'Best Practices']);

const IMG_RE = /<img\b[^>]*>/gi;

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '...' : s);
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ');

/** Last path segment of an img src, URL-decoded when possible. */
function imageName(tag) {
  const m = tag.match(/src="([^"]+)"/);
  if (!m?.[1]) return 'Unknown';
  const last = m[1].split('/').pop();
  // FIX: decodeURIComponent throws on a stray "%" (the script's rule then failed silently).
  try { return decodeURIComponent(last); } catch { return last; }
}

/** Visible text: no <style>/<script>/comments/tags/named entities, whitespace collapsed. */
export function visibleText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** UTF-8 byte length (the script used new Blob([html]).size). */
export function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

/** Snippet around index `pos`: 20 characters before, 60 after, on one line. */
const around = (html, pos) => oneLine(html.substring(Math.max(0, pos - 20), Math.min(html.length, pos + 60)));

// One CSS length token: 10, 10px, 1.5em, 0, 5%.
const LEN = String.raw`-?\d+(?:\.\d+)?(?:px|em|rem|pt|%)?`;
const FOUR_VALUES = String.raw`\s*:\s*${LEN}\s+${LEN}\s+${LEN}\s+${LEN}`;

export const RULES = Object.freeze([
  // ── Structure / HTML ──────────────────────────────────────────────────────

  {
    id: 'checkAltTextQuotes',
    category: 'Structure / HTML',
    label: 'Alt text double quotes',
    description: 'Detects double-quote characters inside alt text that break HTML attribute parsing.',
    severity: 'error',
    defaultOn: true,
    run(html) {
      const issues = [];
      const tags = html.match(/<img[^>]*>/gi) || [];
      tags.forEach((tag, i) => {
        // A quote inside alt="…" closes the attribute; the parser turns the rest into empty
        // attributes, serialised as word="".
        if (!tag.includes('"=""')) return;
        const alt = tag.match(/alt="[^"]*"[^>]{0,100}/);
        issues.push({
          severity: 'error',
          message: `Image #${i + 1} (${imageName(tag)}) has double quotes in its alt text, which breaks the HTML`,
          snippet: alt ? alt[0] : tag.substring(0, 100),
          note: 'The quote character closes the alt attribute early. Fix this first: it may cause cascading HTML issues.',
        });
      });
      return issues;
    },
  },

  {
    id: 'checkMissingAltText',
    category: 'Structure / HTML',
    label: 'Missing alt attributes',
    description: 'Finds <img> tags with no alt attribute at all.',
    severity: 'warning',
    defaultOn: true,
    run(html) {
      const issues = [];
      const tags = html.match(IMG_RE) || [];
      tags.forEach((tag, i) => {
        if (/\balt\s*=/i.test(tag)) return;
        issues.push({
          severity: 'warning',
          message: `Image #${i + 1} (${imageName(tag)}) is missing an alt attribute`,
          snippet: clip(tag, 150),
          note: 'Every image should have alt text for accessibility and deliverability. Use alt="" for decorative images.',
        });
      });
      return issues;
    },
  },

  {
    id: 'checkEmptyLinks',
    category: 'Structure / HTML',
    label: 'Empty or missing link href',
    description: 'Detects <a> tags with a missing, empty or "#" href.',
    severity: 'warning',
    defaultOn: true,
    run(html) {
      const issues = [];
      const linkRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = linkRe.exec(html)) !== null) {
        const tag = m[0];
        // FIX: the script only read double-quoted hrefs, so href='…' was reported as missing.
        const href = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const value = href ? (href[1] ?? href[2]) : null;
        if (value === null) {
          issues.push({
            severity: 'warning',
            message: 'Link has no href attribute',
            snippet: clip(tag, 120),
            note: 'Links without an href are not clickable and may confuse screen readers.',
          });
        } else if (value.trim() === '' || value.trim() === '#') {
          issues.push({
            severity: 'warning',
            message: `Link has a placeholder href="${value}"`,
            snippet: clip(tag, 120),
            note: 'This looks like a placeholder: give it a real URL before sending.',
          });
        }
      }
      return issues;
    },
  },

  {
    id: 'checkDeprecatedTags',
    category: 'Structure / HTML',
    label: 'Deprecated HTML tags',
    description: 'Flags <marquee>, <blink>, <bgsound> and <applet>, which email clients do not support.',
    severity: 'info',
    defaultOn: false,
    run(html) {
      const issues = [];
      // <font>, <center> and tables are still common (and intentional) in email HTML.
      for (const tag of ['marquee', 'blink', 'bgsound', 'applet']) {
        const n = (html.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
        if (n) {
          issues.push({
            severity: 'info',
            message: `Found ${n} <${tag}> tag${n === 1 ? '' : 's'}: deprecated and may not render`,
            note: `<${tag}> is not supported in most email clients.`,
          });
        }
      }
      return issues;
    },
  },

  {
    id: 'checkOutlookCSSIssues',
    category: 'Structure / HTML',
    label: 'Outlook-problematic CSS',
    description: 'Detects CSS shorthands and properties known to break in Outlook (Word rendering engine).',
    severity: 'warning',
    defaultOn: true,
    run(html) {
      const patterns = [
        // FIX: the script's "4-value" test matched any four digits, so padding:10px 20px and
        // padding:1000px were reported too. Now it needs four space-separated values.
        { re: new RegExp(`style="[^"]*\\bpadding${FOUR_VALUES}`, 'gi'), name: 'padding shorthand (4-value)',
          fix: 'Use padding-top, padding-right, padding-bottom and padding-left separately.' },
        { re: new RegExp(`style="[^"]*\\bmargin${FOUR_VALUES}`, 'gi'), name: 'margin shorthand (4-value)',
          fix: 'Use margin-top, margin-right, margin-bottom and margin-left separately.' },
        { re: /style="[^"]*\bbackground\s*:[^;"]*url\(/gi, name: 'CSS background images',
          fix: 'Background images are not supported in Outlook. Use VML or an <img> fallback.' },
        { re: /style="[^"]*\bflex\b/gi, name: 'flexbox', fix: 'Flexbox is ignored in Outlook. Use tables for layout.' },
        { re: /style="[^"]*\bgrid\b/gi, name: 'CSS grid', fix: 'CSS grid is ignored in Outlook. Use tables for layout.' },
        { re: /style="[^"]*\bborder-radius\b/gi, name: 'border-radius',
          fix: 'border-radius is ignored in Outlook desktop. Consider VML for rounded corners.' },
        { re: /style="[^"]*\bmax-width\b/gi, name: 'max-width',
          fix: 'max-width is ignored in some Outlook versions. Also set a fixed width as a fallback.' },
      ];
      const issues = [];
      for (const { re, name, fix } of patterns) {
        const matches = html.match(re);
        if (matches) {
          issues.push({ severity: 'warning', message: `Found ${matches.length} instance(s) of ${name}`, note: fix });
        }
      }
      return issues;
    },
  },

  // ── Accessibility ─────────────────────────────────────────────────────────

  {
    id: 'checkMissingLangAttribute',
    category: 'Accessibility',
    label: 'Missing lang attribute',
    description: 'Checks that the <html> tag has a lang attribute for screen readers.',
    severity: 'warning',
    defaultOn: true,
    run(html) {
      const tag = html.match(/<html\b[^>]*>/i);
      if (!tag || /\blang\s*=/i.test(tag[0])) return [];
      return [{
        severity: 'warning',
        message: '<html> tag is missing a lang attribute',
        snippet: clip(tag[0], 150),
        note: 'Add lang="en" (or the right language) for screen reader support.',
      }];
    },
  },

  {
    id: 'checkLinkAccessibility',
    category: 'Accessibility',
    label: 'Generic link text',
    description: 'Flags links with vague text such as "click here" or "read more".',
    severity: 'info',
    defaultOn: false,
    run(html) {
      const issues = [];
      const linkRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
      const generic = /^(click here|here|read more|learn more|more|link|this link)$/i;
      let m;
      while ((m = linkRe.exec(html)) !== null) {
        const text = m[1].replace(/<[^>]+>/g, '').trim();
        if (text && generic.test(text)) {
          issues.push({
            severity: 'info',
            message: `Link with generic text: "${text}"`,
            snippet: clip(m[0], 120),
            note: 'Descriptive link text improves accessibility and click-through rates.',
          });
        }
      }
      return issues;
    },
  },

  {
    id: 'checkColorContrast',
    category: 'Accessibility',
    label: 'Potential contrast issues',
    description: 'Flags very light text colours (white or near-white), which may be invisible on a white background.',
    severity: 'info',
    defaultOn: false,
    run(html) {
      // FIX: the script's /color\s*:/ also matched background-color and border-color, so every
      // white background was reported as light text. Only the `color` property counts now.
      const matches = html.match(/(?<![\w-])color\s*:\s*#(f{3,6}|e{3,6})\b/gi);
      if (!matches) return [];
      return [{
        severity: 'info',
        message: `Found ${matches.length} instance(s) of very light text colour`,
        note: 'Very light text may be invisible on white backgrounds. Check the contrast is intentional.',
      }];
    },
  },

  // ── Deliverability ────────────────────────────────────────────────────────

  {
    id: 'checkImageToTextRatio',
    category: 'Deliverability',
    label: 'Image-to-text ratio',
    description: 'Warns when the email is image-heavy with little text (hurts deliverability).',
    severity: 'warning',
    defaultOn: true,
    run(html) {
      const images = (html.match(/<img\b/gi) || []).length;
      const words = visibleText(html).split(/\s+/).filter((w) => w.length > 1).length;
      if (images > 0 && words < 50) {
        return [{
          severity: 'warning',
          message: `${images} image(s) but only ~${words} words of text`,
          note: 'Spam filters penalise image-heavy emails. Aim for a healthy mix of text and images.',
        }];
      }
      if (images > 0 && words < 150) {
        return [{
          severity: 'info',
          message: `${images} image(s) with ~${words} words: text could be higher`,
          note: 'Consider adding more text content to improve deliverability.',
        }];
      }
      return [];
    },
  },

  {
    id: 'checkMissingUnsubscribe',
    category: 'Deliverability',
    label: 'Missing unsubscribe link',
    description: 'Checks for an unsubscribe or preference-centre link (required by CAN-SPAM / CASL).',
    severity: 'warning',
    defaultOn: true,
    run(html) {
      const hasText = /unsubscribe|opt[\s-]?out|manage\s+preferences|email\s+preferences/i.test(html);
      const hasTag = /\{\{\s*unsubscribeUrl\s*\}\}/i.test(html) || /\{%.*unsubscribe.*%\}/i.test(html);
      if (hasText || hasTag) return [];
      return [{
        severity: 'warning',
        message: 'No unsubscribe or preference-centre link found',
        note: 'CAN-SPAM and CASL require a visible unsubscribe mechanism. Check that {{unsubscribeUrl}} or an equivalent is present.',
      }];
    },
  },

  {
    id: 'checkExcessiveFormatting',
    category: 'Deliverability',
    label: 'Excessive caps or exclamation marks',
    description: 'Flags ALL CAPS words and runs of exclamation marks in the visible text.',
    severity: 'info',
    defaultOn: true,
    run(html) {
      const issues = [];
      const text = visibleText(html);
      const bangs = text.match(/!{2,}/g);
      if (bangs) {
        issues.push({
          severity: 'info',
          message: `Found ${bangs.length} instance(s) of multiple exclamation marks`,
          note: 'Excessive punctuation can trigger spam filters.',
        });
      }
      const acronyms = new Set(['HTML', 'CSS', 'URL', 'API', 'FAQ', 'USA', 'CEO', 'CTA', 'PDF', 'ROI', 'SEO',
        'SMS', 'ESP', 'CRM', 'RGB', 'USD', 'CAD', 'GBP']);
      const caps = (text.match(/\b[A-Z]{3,}\b/g) || []).filter((w) => !acronyms.has(w));
      if (caps.length > 3) {
        issues.push({
          severity: 'info',
          message: `Found ${caps.length} ALL CAPS words: ${caps.slice(0, 5).join(', ')}${caps.length > 5 ? '…' : ''}`,
          note: 'Excessive capitalisation can trigger spam filters and feels aggressive to readers.',
        });
      }
      return issues;
    },
  },

  {
    id: 'checkSpammyWords',
    category: 'Deliverability',
    label: 'Spam trigger words',
    description: 'Flags words and phrases commonly associated with spam filtering.',
    severity: 'info',
    defaultOn: false,
    run(html) {
      const text = visibleText(html).toLowerCase();
      const phrases = [
        'act now', 'limited time', 'buy now', 'free gift', 'no obligation',
        'risk free', 'winner', 'you have been selected', 'congratulations',
        'double your', 'earn extra cash', 'no catch', 'no cost',
        '100% free', 'best price', 'lowest price', 'order now',
        'what are you waiting for', "don't delete", 'urgent',
      ];
      const found = phrases.filter((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
      if (!found.length) return [];
      return [{
        severity: 'info',
        message: `Found ${found.length} potential spam trigger phrase(s): ${found.join(', ')}`,
        note: "These phrases alone won't get you flagged, but combined with other signals they add to spam scoring.",
      }];
    },
  },

  {
    // The userscript's results view mapped a 'missing-preheader' issue to this id, but the rule
    // itself had been dropped from its rule list. Re-added here; off by default because Iterable's
    // own "Preheader text" template setting may not appear in the preview HTML.
    id: 'checkMissingPreheader',
    category: 'Deliverability',
    label: 'Missing preheader',
    description: 'Checks for hidden preheader (preview) text near the top of the body. Iterable\'s Preheader text setting may not show in the preview, so this is off by default.',
    severity: 'info',
    defaultOn: false,
    run(html) {
      // A class/id naming it, or a hidden element with text among the first elements of <body>.
      if (/<[a-z][^>]*\b(?:class|id)\s*=\s*["'][^"']*\b(?:pre-?header|preview-?text)/i.test(html)) return [];
      const body = html.search(/<body\b[^>]*>/i);
      const start = body === -1 ? html.slice(0, 3000) : html.slice(body, body + 3000);
      const hiddenRe = /<(div|span|p|td)\b[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|mso-hide\s*:\s*all|max-height\s*:\s*0|opacity\s*:\s*0(?![.\d]))[^>]*>([\s\S]*?)<\/\1>/gi;
      let m;
      while ((m = hiddenRe.exec(start)) !== null) {
        if (visibleText(m[2]).length > 0) return [];
      }
      return [{
        severity: 'info',
        message: 'No preheader text found',
        note: 'Inbox previews show the first text of the email when there is no preheader. Set the template\'s Preheader text or add a hidden preheader element.',
      }];
    },
  },

  // ── Best Practices ────────────────────────────────────────────────────────

  {
    id: 'checkMissingImageDimensions',
    category: 'Best Practices',
    label: 'Images missing dimensions',
    description: 'Flags images without an explicit width and height (layout shifts in some clients).',
    severity: 'info',
    defaultOn: true,
    run(html) {
      const tags = html.match(IMG_RE) || [];
      const count = tags.filter((tag) => {
        const w = /\bwidth\s*=/i.test(tag) || /width\s*:\s*\d/i.test(tag);
        const h = /\bheight\s*=/i.test(tag) || /height\s*:\s*\d/i.test(tag);
        return !w || !h;
      }).length;
      if (!count) return [];
      return [{
        severity: 'info',
        message: `${count} image(s) missing an explicit width and/or height`,
        note: 'Width and height attributes prevent layout shifts while images load. Especially important for Outlook.',
      }];
    },
  },

  {
    id: 'checkMissingDoctype',
    category: 'Best Practices',
    label: 'Missing DOCTYPE',
    description: 'Checks for a DOCTYPE declaration at the start of the HTML.',
    severity: 'warning',
    defaultOn: true,
    run(html) {
      if (/^<!doctype\b/i.test(html.trimStart())) return [];
      return [{
        severity: 'warning',
        message: 'Missing <!DOCTYPE> declaration',
        note: 'Without a DOCTYPE, email clients may render in quirks mode, with inconsistent results.',
      }];
    },
  },

  {
    id: 'checkMissingViewportMeta',
    category: 'Best Practices',
    label: 'Missing viewport meta',
    description: 'Checks for a <meta name="viewport"> tag for mobile rendering.',
    severity: 'info',
    defaultOn: true,
    run(html) {
      if (/meta[^>]*name\s*=\s*["']viewport["']/i.test(html)) return [];
      return [{
        severity: 'info',
        message: 'Missing <meta name="viewport"> tag',
        snippet: '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        note: 'A viewport meta tag improves mobile rendering.',
      }];
    },
  },

  {
    id: 'checkBrokenHandlebars',
    category: 'Best Practices',
    label: 'Broken template tags',
    description: 'Detects unclosed Handlebars {{ }} and Jinja {% %} tags.',
    severity: 'error',
    defaultOn: true,
    run(html) {
      const issues = [];
      // Report the first unclosed opener of each kind (later ones are likely cascading).
      // FIX: the script's snippet pointed at the first or second opener, not the unclosed one.
      const firstUnclosed = (open, close) => {
        let pos = html.indexOf(open);
        while (pos !== -1) {
          const next = html.indexOf(open, pos + open.length);
          const closing = html.indexOf(close, pos + open.length);
          // Same as the script's split(open): the text up to the next opener must hold a closer.
          if (closing === -1 || (next !== -1 && closing > next)) return pos;
          pos = next;
        }
        return -1;
      };
      const hb = firstUnclosed('{{', '}}');
      if (hb !== -1) {
        issues.push({
          severity: 'error',
          message: 'Unclosed Handlebars {{ tag',
          snippet: around(html, hb),
          note: "This template tag is missing its closing }}. The merge field won't render correctly.",
        });
      }
      const jj = firstUnclosed('{%', '%}');
      if (jj !== -1) {
        issues.push({
          severity: 'error',
          message: 'Unclosed Jinja {% tag',
          snippet: around(html, jj),
          note: "This template tag is missing its closing %}. The logic block won't run correctly.",
        });
      }
      return issues;
    },
  },

  {
    id: 'checkMissingCharset',
    category: 'Best Practices',
    label: 'Missing charset declaration',
    description: 'Checks for a charset meta tag, which prevents encoding issues with special characters.',
    severity: 'info',
    defaultOn: true,
    run(html) {
      if (/meta[^>]*charset\s*=/i.test(html)) return [];
      return [{
        severity: 'info',
        message: 'No charset declaration found',
        snippet: '<meta charset="UTF-8">',
        note: 'Declare the charset to prevent special characters rendering incorrectly.',
      }];
    },
  },

  {
    id: 'checkLargeHtmlSize',
    category: 'Best Practices',
    label: 'Email size',
    description: "Warns when the HTML exceeds Gmail's ~102 KB clipping threshold.",
    severity: 'warning',
    defaultOn: true,
    run(html) {
      const kb = byteLength(html) / 1024;
      if (kb > 102) {
        return [{
          severity: 'warning',
          message: `HTML size is ~${Math.round(kb)} KB: over Gmail's 102 KB clipping limit`,
          note: 'Gmail clips larger emails behind a "View entire message" link. Recipients may miss content below it, including the unsubscribe link.',
        }];
      }
      if (kb > 80) {
        return [{
          severity: 'info',
          message: `HTML size is ~${Math.round(kb)} KB: approaching Gmail's 102 KB clipping limit`,
          note: 'Consider trimming whitespace, comments or redundant styles to stay safely under the limit.',
        }];
      }
      return [];
    },
  },

  {
    id: 'checkTrackingPixels',
    category: 'Best Practices',
    label: 'Multiple tracking pixels',
    description: 'Detects more than two 1×1 or hidden images, which can hurt deliverability.',
    severity: 'info',
    defaultOn: false,
    run(html) {
      const tags = html.match(IMG_RE) || [];
      const count = tags.filter((tag) => {
        const oneByOne = /width\s*=\s*["']?1["']?\b/i.test(tag) && /height\s*=\s*["']?1["']?\b/i.test(tag);
        const hidden = /display\s*:\s*none/i.test(tag) || /visibility\s*:\s*hidden/i.test(tag);
        return oneByOne || hidden;
      }).length;
      if (count <= 2) return [];
      return [{
        severity: 'info',
        message: `Found ${count} potential tracking pixels`,
        note: 'Multiple tracking pixels can slow loading and trigger spam filters. Consider consolidating.',
      }];
    },
  },
]);

export const RULE_IDS = Object.freeze(RULES.map((r) => r.id));
