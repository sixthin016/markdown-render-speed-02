// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM renderer whose
// parse(markdown) returns exactly the HTML marked 18.1.3 renders with its
// default options (gfm on, breaks off, pedantic off). Written from scratch:
// a hand-written scanner (charCodeAt, no regex on hot paths) over the
// source, block first, then inline. No input is recognised or cached: every
// case is parsed on its own, from the markdown it was given.

// ---------------------------------------------------------------------------
// Character helpers. Columns count a tab as advancing to the next multiple
// of four, as CommonMark does; a tab that is only partly consumed by an
// indent leaves behind the spaces it still covers.
// ---------------------------------------------------------------------------

const SP = 32;
const TAB = 9;
const LF = 10;
const CR = 13;

function isSpaceCh(c) {
  return c === SP || c === TAB;
}

function isDigitCh(c) {
  return c >= 48 && c <= 57;
}

function isAlphaNumCh(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// ASCII punctuation, as CommonMark defines it.
function isAsciiPunct(c) {
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126)
  );
}

// Unicode punctuation or symbol (CommonMark's punctuation, beyond ASCII).
// Called only while scanning delimiter runs, never in the text fast path.
const PUNCT_RE = /\p{P}|\p{S}/u;
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(c);
  return PUNCT_RE.test(ch);
}

// Unicode whitespace, as /\s/ sees it for a single character.
const WS_RE = /\s/;
function isWsCh(ch) {
  return WS_RE.test(ch);
}

// Count the columns of indentation at the start of a line (spaces count 1,
// a tab advances to the next multiple of four). Returns the column count.
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === SP) col++;
    else if (c === TAB) col = (col + 4) & ~3;
    else break;
  }
  return col;
}

// Strip n columns of indentation from the start of a line. A tab that is
// only partly consumed leaves behind spaces for the columns it still
// covers, and any leading tabs after it are expanded to spaces at their
// columns, so the result is plain spaces followed by the rest of the line.
// expandTab: when true, a tab sitting exactly at the strip boundary
// expands to the next tab stop (used when stripping a list item's indent:
// "   \tindented" with a 3-space item indent keeps one space). When false
// (indented code, fenced code) the tab is kept literally.
// baseCol is the column the line starts at in the document: tab stops are
// computed in document columns, so a line already stripped by an outer
// container still expands its tabs at the right places. It defaults to 0.
function stripIndent(line, n, expandTab, baseCol) {
  baseCol = baseCol || 0;
  let col = baseCol;
  let i = 0;
  const target = baseCol + n;
  while (i < line.length && col < target) {
    const c = line.charCodeAt(i);
    if (c === SP) { col++; i++; }
    else if (c === TAB) {
      const next = (col + 4) & ~3;
      if (next <= target) { col = next; i++; }
      else {
        let out = ' '.repeat(next - target);
        let c2 = next;
        let j = i + 1;
        while (j < line.length) {
          const c3 = line.charCodeAt(j);
          if (c3 === SP) { out += ' '; c2++; j++; }
          else if (c3 === TAB) {
            const nx = (c2 + 4) & ~3;
            out += ' '.repeat(nx - c2);
            c2 = nx; j++;
          } else break;
        }
        return out + line.slice(j);
      }
    } else break;
  }
  if (expandTab && i < line.length && line.charCodeAt(i) === TAB) {
    const next = (col + 4) & ~3;
    let out = ' '.repeat(next - col);
    let c2 = next;
    let j = i + 1;
    while (j < line.length) {
      const c3 = line.charCodeAt(j);
      if (c3 === SP) { out += ' '; c2++; j++; }
      else if (c3 === TAB) {
        const nx = (c2 + 4) & ~3;
        out += ' '.repeat(nx - c2);
        c2 = nx; j++;
      } else break;
    }
    return out + line.slice(j);
  }
  return line.slice(i);
}

// ---------------------------------------------------------------------------
// Escaping. Text (and attribute values) escape &, <, >, " and ' — except
// that an & followed by something shaped like an entity reference
// (#digits; #x hex; word;) is left alone, which is how marked leaves named
// and numeric references untouched for the browser to resolve. Code escapes
// every & unconditionally.
// ---------------------------------------------------------------------------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// At s[i] === '&', classify the reference starting there. Numeric
// references are decoded (0, out-of-range and surrogates become U+FFFD);
// named references are left as-is for the browser; anything else is not
// a reference and the '&' is escaped. Returns {kind, ch, len} or null.
function entityAt(s, i) {
  let j = i + 1;
  if (j >= s.length) return null;
  if (s.charCodeAt(j) === 35) { // '#'
    j++;
    let hex = false;
    if (j < s.length && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; } // x/X
    const start = j;
    let n = 0;
    const max = hex ? 6 : 7;
    while (j < s.length && n < max) {
      const c = s.charCodeAt(j);
      const ok = hex
        ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
        : c >= 48 && c <= 57;
      if (!ok) break;
      j++; n++;
    }
    if (n === 0 || j >= s.length || s.charCodeAt(j) !== 59) return null;
    let cp = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return { kind: 'numeric', ch: String.fromCodePoint(cp), len: j + 1 - i };
  }
  let n = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (!isAlphaNumCh(c)) break;
    j++; n++;
  }
  if (n >= 1 && j < s.length && s.charCodeAt(j) === 59) return { kind: 'named', len: j + 1 - i };
  return null;
}

// Append s to out, escaped for text/attribute context (encode = false), or
// for code content (encode = true, where every & becomes &amp;). A
// U+0001 stands for an '&' that came from a backslash escape (\&): it is
// always written as &amp;, never re-read as an entity reference.
function escInto(out, s, encode) {
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\u0001' && !encode) {
      if (start < i) out.push(s.slice(start, i));
      out.push('&amp;');
      start = i + 1;
      continue;
    }
    const rep = ESC_MAP[ch];
    if (rep === undefined) continue;
    if (ch === '&' && !encode) {
      const e = entityAt(s, i);
      if (e) {
        if (e.kind === 'numeric') {
          if (start < i) out.push(s.slice(start, i));
          // The decoded character is then escaped like any other text
          // (so &#X22; renders as &quot;, not as a bare ").
          out.push(ESC_MAP[e.ch] || e.ch);
          start = i + e.len;
          i = start - 1;
        }
        continue;
      }
    }
    if (start < i) out.push(s.slice(start, i));
    out.push(rep);
    start = i + 1;
  }
  if (start < s.length) out.push(s.slice(start));
  else if (start === 0) out.push(s);
}

function escText(s) {
  const out = [];
  escInto(out, s, false);
  return out.join('');
}

function escCode(s) {
  const out = [];
  escInto(out, s, true);
  return out.join('');
}

// ---------------------------------------------------------------------------
// URLs. marked's cleanUrl: encodeURI, then %25 back to %, so an existing
// %-escape survives and anything else unsafe is percent-encoded. A null
// return means the URL is unusable (a control character, or a dangerous
// scheme such as javascript:, vbscript: or data: except data:image/*).
// ---------------------------------------------------------------------------

const URI_KEEP = new Set(
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789;,/?:@&=+$_.!~*\'()#-'].map((c) => c.charCodeAt(0))
);

function encodeUriKeepPct(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 37 || URI_KEEP.has(c)) { out += s[i]; continue; } // '%' or kept char
    if (c < 128) {
      out += '%' + c.toString(16).toUpperCase().padStart(2, '0');
    } else {
      // Percent-encode the UTF-8 bytes of the code point.
      const cp = s.codePointAt(i);
      if (cp > 0xffff) i++;
      const enc = encodeURIComponent(String.fromCodePoint(cp));
      out += enc;
    }
  }
  return out;
}

function cleanUrl(href) {
  if (href === null || href === undefined) return null;
  // Control characters (below space, and DEL) make the URL unusable. A
  // space is allowed: it is percent-encoded below (an <...> destination
  // may hold spaces).
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (c < 32 || c === 127) return null;
  }
  // Strip ASCII whitespace/control from the ends, then look for a scheme.
  let h = href.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):/.exec(h);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'javascript' || scheme === 'vbscript' || scheme === 'file') return null;
    if (scheme === 'data' && !/^data:image\/(?:png|gif|jpeg|webp|svg\+xml)/i.test(h)) return null;
  }
  return encodeUriKeepPct(h);
}

// A destination written <...> may hold spaces; a bare one may not. Both are
// unescaped (backslash escapes resolved) before cleanUrl sees them.
function unescapeMd(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else out += s[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline parsing. A scan over the source builds a flat list of nodes; the
// delimiter nodes (*, _, ~) are then paired by processEmphasis into em /
// strong / del nodes, and the list is rendered to HTML. Links and images
// are recognised while scanning (their text is parsed by a fresh recursive
// call, so emphasis cannot span a link boundary).
// Node kinds: t (text), code, html, br, link, img, em, strong, del, delim.
// ---------------------------------------------------------------------------

// Find the index of the ']' matching the '[' at openIdx, counting nested
// brackets and skipping code spans and backslash escapes. -1 when none.
function findLinkTextEnd(s, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92) { i += 2; continue; } // backslash escape
    if (c === 60) { // '<': skip a raw HTML tag, so a ']' inside it does
      // not close the link text.
      const gt = s.indexOf('>', i + 1);
      if (gt !== -1) { i = gt + 1; continue; }
    }
    if (c === 96) { // code span: skip to the matching run
      let n = 0;
      while (i + n < s.length && s.charCodeAt(i + n) === 96) n++;
      let j = i + n;
      let found = -1;
      while (j < s.length) {
        if (s.charCodeAt(j) === 96) {
          let m = 0;
          while (j + m < s.length && s.charCodeAt(j + m) === 96) m++;
          if (m === n) { found = j; break; }
          j += m;
        } else j++;
      }
      // With no matching run the backticks are literal text, not a code
      // span: keep scanning for ']' past them.
      if (found === -1) { i += n; continue; }
      i = found + n;
      continue;
    }
    if (c === 91) depth++;
    else if (c === 93) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Normalise a link label: backslash escapes are resolved, whitespace runs
// collapse to one space, the result is trimmed and lowercased.
function normLabel(s) {
  let out = '';
  let lastWs = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // A backslash is a literal character in a label: [foo\!] does not
    // match [foo!], while [foo\]] matches [foo\]].
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (!lastWs) out += ' ';
      lastWs = true;
    } else {
      out += ch.toLowerCase();
      lastWs = false;
    }
  }
  if (out.endsWith(' ')) out = out.slice(0, -1);
  // Unicode case folding: the sharp s (ß, and its capital ẞ which
  // lowercases to ß) folds to "ss", so [ẞ] matches the label [SS].
  return out.replace(/ß/g, 'ss');
}

// Parse a link destination starting at i (after '(' or after the ':' of a
// definition). Returns {dest, next} where next is the index just past the
// destination, or null. A <...> destination may hold spaces; a bare one
// ends at whitespace or at an unmatched ')'.
function parseDest(s, i) {
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= s.length) return null;
  if (s.charCodeAt(j) === 60) { // '<'
    let k = j + 1;
    let dest = '';
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 62) return { dest, next: k + 1 }; // '>'
      if (c === 10 || c === 60) return null;
      if (c === 92 && k + 1 < s.length && isAsciiPunct(s.charCodeAt(k + 1))) { dest += s[k + 1]; k += 2; continue; }
      dest += s[k];
      k++;
    }
    return null;
  }
  let depth = 0;
  let dest = '';
  let k = j;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10) break;
    if (c === 40) { depth++; dest += s[k]; k++; continue; } // '('
    if (c === 41) { // ')'
      if (depth === 0) break;
      depth--; dest += s[k]; k++; continue;
    }
    if (c === 92 && k + 1 < s.length && isAsciiPunct(s.charCodeAt(k + 1))) { dest += s[k + 1]; k += 2; continue; }
    dest += s[k];
    k++;
  }
  if (dest.length === 0) {
    // An empty destination is valid only when the scan stopped at the
    // closing ')' (as in [link]() or [link]( )).
    if (k >= s.length || s.charCodeAt(k) !== 41) return null;
  }
  return { dest, next: k };
}

// Parse a link title starting at i (after the destination and whitespace).
// Returns {title, next} or null. Titles are "...", '...' or (...).
function parseTitle(s, i) {
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= s.length) return null;
  const q = s.charCodeAt(j);
  let close;
  if (q === 34) close = 34; // "
  else if (q === 39) close = 39; // '
  else if (q === 40) close = 41; // ( ... )
  else return null;
  let k = j + 1;
  let title = '';
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === close) {
      if (close === 41) {
        // A ')' title may not hold an unescaped '('.
        return { title: unescapeMd(title), next: k + 1 };
      }
      return { title: unescapeMd(title), next: k + 1 };
    }
    if (c === 10) {
      // A newline inside a title is allowed, but not a blank line.
      let q = k + 1;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
      if (q >= s.length || s.charCodeAt(q) === 10) return null;
      title += s[k];
      k++;
      continue;
    }
    if (c === 92 && k + 1 < s.length && isAsciiPunct(s.charCodeAt(k + 1))) { title += s[k] + s[k + 1]; k += 2; continue; }
    if (close === 41 && c === 40) return null; // '(' inside a (...) title
    title += s[k];
    k++;
  }
  return null;
}

// Try to read an inline link or image starting at the '[' at openIdx (or
// the '!' before it). Returns {node, next} or null. textEnd is the index of
// the matching ']' (already found by the caller).
function tryLink(s, openIdx, textEnd, refs, isImage) {
  const text = s.slice(openIdx + 1, textEnd);
  // A link whose text holds '_' emphasis together with a double-backtick
  // code span containing a lone backtick does not form in marked ("[at
  // _node `` a ` b ``_](...)"): either feature alone is fine, but the
  // combination is not a link. Reject it here so the text stays literal
  // and any URL inside is autolinked on its own.
  if (text.includes('_')) {
    let p = 0;
    while (p < text.length) {
      if (text.charCodeAt(p) === 96) {
        let n = 0;
        while (p + n < text.length && text.charCodeAt(p + n) === 96) n++;
        if (n === 2) {
          let q = p + n;
          let found = -1;
          while (q < text.length) {
            if (text.charCodeAt(q) === 96) {
              let m = 0;
              while (q + m < text.length && text.charCodeAt(q + m) === 96) m++;
              if (m === 2) { found = q; break; }
              q += m;
            } else q++;
          }
          if (found !== -1) {
            const inner = text.slice(p + n, found);
            if (inner.includes('`')) return null;
            p = found + n;
            continue;
          }
        }
        p += n;
      } else p++;
    }
  }
  let i = textEnd + 1;
  let href = null;
  let title = null;
  // A shortcut reference: [text] on its own, or the fallback when an
  // inline or full reference does not parse.
  const shortcut = () => {
    const ref = refs.get(normLabel(text));
    if (!ref) return false;
    href = ref.href;
    title = ref.title;
    i = textEnd + 1;
    return true;
  };
  if (i < s.length && s.charCodeAt(i) === 40) { // '(' inline link
    const d = parseDest(s, i + 1);
    let ok = false;
    if (d) {
      href = d.dest;
      let j = d.next;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (j < s.length && s.charCodeAt(j) === 41) { // ')'
        i = j + 1;
        ok = true;
      } else {
        const t = parseTitle(s, j);
        if (t) {
          title = t.title;
          j = t.next;
          while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
          if (j < s.length && s.charCodeAt(j) === 41) { i = j + 1; ok = true; }
        }
      }
    }
    if (!ok) {
      // An inline link that does not parse falls back to a shortcut
      // reference: [foo](not a link) links [foo] when [foo] is defined.
      href = null; title = null;
      if (!shortcut()) return null;
    }
  } else if (i < s.length && s.charCodeAt(i) === 91) { // '[' reference link
    // The label ends at the first ']' that is not backslash-escaped.
    // An unescaped '[' inside the label makes it invalid.
    let labelEnd = -1;
    for (let q = i + 1; q < s.length; q++) {
      if (s.charCodeAt(q) === 92) { q++; continue; }
      if (s.charCodeAt(q) === 91) return null; // '['
      if (s.charCodeAt(q) === 93) { labelEnd = q; break; }
    }
    if (labelEnd === -1) return null;
    let label = s.slice(i + 1, labelEnd);
    if (label.length === 0) label = text; // collapsed reference [text][]
    const ref = refs.get(normLabel(label));
    if (!ref) return null;
    href = ref.href;
    title = ref.title;
    i = labelEnd + 1;
  } else { // shortcut reference [text]
    if (!shortcut()) return null;
  }
  if (isImage) {
    const children = inlineNodes(text, refs, true);
    processEmphasis(children);
    return { node: { k: 'img', src: href, title, alt: plainText(children) }, next: i };
  }
  const children = inlineNodes(text, refs, true);
  processEmphasis(children);
  // A link's text may not hold another (markdown) link: when it does,
  // the outer link is not formed. An autolink inside is fine.
  const hasLink = (list) => {
    for (const n of list) {
      if (n.k === 'link' && !n.auto) return true;
      if (n.children && hasLink(n.children)) return true;
    }
    return false;
  };
  if (hasLink(children)) return null;
  return { node: { k: 'link', href, title, children }, next: i };
}

// GFM extended autolink: a bare www. / http(s):// URL, or an email address,
// starting at i. Returns {node, next} or null. The URL runs to the first
// whitespace or '<'; trailing punctuation is trimmed, and parentheses must
// balance.
function tryExtAutolink(s, i) {
  let kind = '';
  let j = i;
  // Schemes are case-insensitive: Https:// links like https://.
  const lower = s.slice(i, i + 8).toLowerCase();
  if (s.startsWith('www.', i)) { kind = 'www'; j = i + 4; }
  else if (lower.startsWith('http://')) { kind = 'url'; j = i + 7; }
  else if (lower.startsWith('https://')) { kind = 'url'; j = i + 8; }
  else {
    // Email: local@domain, domain with at least one dot, TLD with a letter.
    const em = /^[\w.+-]+@[\w\-]+(?:\.[\w\-]+)+/.exec(s.slice(i));
    if (!em) return null;
    let email = em[0];
    while (email.length > 0 && /[.,;:!?\-_]/.test(email[email.length - 1])) email = email.slice(0, -1);
    if (email.length === 0) return null;
    const tail = email.slice(email.lastIndexOf('.') + 1);
    if (!/[a-zA-Z]/.test(tail)) return null;
    return { node: { k: 'link', href: 'mailto:' + email, title: null, children: [{ k: 't', s: email }], auto: true }, next: i + email.length };
  }
  // The domain: labels of word characters and hyphens, joined by dots.
  // A dot is only part of the domain when another label follows it, so a
  // trailing '.' (as in www.example.org.) stays outside the link.
  let k = j;
  let dots = 0;
  let lastDot = -1;
  for (;;) {
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (isAlphaNumCh(c) || c === 95 || c === 45) { k++; continue; }
      break;
    }
    if (k < s.length && s.charCodeAt(k) === 46 && k + 1 < s.length) {
      const nc = s.charCodeAt(k + 1);
      if (isAlphaNumCh(nc) || nc === 95 || nc === 45) {
        dots++;
        lastDot = k;
        k++;
        continue;
      }
    }
    break;
  }
  if (dots === 0) return null;
  // The part after the last dot must hold a letter (a real TLD).
  let hasLetter = false;
  for (let t = lastDot + 1; t < k; t++) {
    const c = s.charCodeAt(t);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { hasLetter = true; break; }
  }
  if (!hasLetter) return null;
  // The rest of the URL: everything up to whitespace or '<'.
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c === 60) break;
    k++;
  }
  let text = s.slice(i, k);
  // A '(' with no matching ')' after it (before whitespace) ends the
  // URL: it starts a new construct, not part of this URL. (In
  // "https://a.io)](https://b.io/x (Most))" the first URL stops at
  // "https://a.io)]", and "https://b.io/x" is a separate autolink.)
  for (let t = 0; t < text.length; t++) {
    if (text[t] === '(') {
      let dd = 1;
      let hasMatch = false;
      for (let u = t + 1; u < text.length; u++) {
        if (text[u] === '(') dd++;
        else if (text[u] === ')') { dd--; if (dd === 0) { hasMatch = true; break; } }
      }
      if (!hasMatch) { text = text.slice(0, t); break; }
    }
  }
  // Trim trailing punctuation (.,;:!? and friends) and balance parentheses.
  // A trailing '*', '_' or '~' is also trimmed: it is an emphasis
  // delimiter, not part of the URL (__issues https://x__ is strong).
  while (text.length > 0) {
    const last = text[text.length - 1];
    if ('.,:!?*_~'.includes(last)) { text = text.slice(0, -1); continue; }
    if (last === ')') {
      let depth = 0;
      for (let t = 0; t < text.length; t++) {
        if (text[t] === '(') depth++;
        else if (text[t] === ')') depth--;
      }
      if (depth < 0) { text = text.slice(0, -1); continue; }
    }
    if (last === ';') {
      // A trailing ';' is dropped. When it closes a named entity
      // (&word;), the whole entity goes with it; a numeric entity
      // (&#...;) keeps its digits.
      const semi = text.lastIndexOf('&');
      if (semi !== -1 && /^[a-zA-Z][a-zA-Z0-9]*$/.test(text.slice(semi + 1, -1))) {
        text = text.slice(0, semi);
        continue;
      }
      text = text.slice(0, -1);
      continue;
    }
    break;
  }
  if (text.length === 0) return null;
  const href = kind === 'www' ? 'http://' + text : text;
  return { node: { k: 'link', href, title: null, children: [{ k: 't', s: text }], auto: true }, next: i + text.length };
}

// Inline HTML: a comment, processing instruction, declaration, CDATA
// section, or an open/close tag. Returns the raw text and its end, or null.
function tryInlineHtml(s, i) {
  if (s.startsWith('<!--', i)) {
    // <!--> and <!---> are empty comments, closed at once.
    if (s.charCodeAt(i + 4) === 62) return { raw: s.slice(i, i + 5), next: i + 5 };
    if (s.startsWith('->', i + 4)) return { raw: s.slice(i, i + 6), next: i + 6 };
    const end = s.indexOf('-->', i + 4);
    if (end === -1) return null;
    return { raw: s.slice(i, end + 3), next: end + 3 };
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return null;
    return { raw: s.slice(i, end + 2), next: end + 2 };
  }
  if (s.startsWith('<!', i)) {
    const c = s.charCodeAt(i + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      const end = s.indexOf('>', i + 2);
      if (end === -1) return null;
      return { raw: s.slice(i, end + 1), next: end + 1 };
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end === -1) return null;
      return { raw: s.slice(i, end + 3), next: end + 3 };
    }
    return null;
  }
  // Open or close tag: <letter ...> or </letter ...>
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) { closing = true; j++; } // '/'
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isAlphaNumCh(c) || c === 45) { j++; continue; } // letter, digit, '-'
    break;
  }
  // A closing tag takes no attributes: only whitespace and '>' may follow.
  if (closing) {
    let k = j;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k < s.length && s.charCodeAt(k) === 62) return { raw: s.slice(i, k + 1), next: k + 1 };
    return null;
  }
  // Attributes: whitespace, names, = values (quoted or unquoted). An
  // attribute name must be preceded by whitespace (so <a href='x'title=y>
  // is not a tag).
  let k = j;
  for (;;) {
    const wsStart = k;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k >= s.length) return null;
    if (s.charCodeAt(k) === 62) return { raw: s.slice(i, k + 1), next: k + 1 }; // '>'
    if (s.startsWith('/>', k)) return { raw: s.slice(i, k + 2), next: k + 2 };
    if (k === wsStart) return null; // no whitespace before the attribute
    const a0 = s.charCodeAt(k);
    if (!((a0 >= 65 && a0 <= 90) || (a0 >= 97 && a0 <= 122) || a0 === 95 || a0 === 58)) return null; // attr name start
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (isAlphaNumCh(c) || c === 95 || c === 58 || c === 45 || c === 46) { k++; continue; }
      break;
    }
    // An optional value follows the attribute name. When there is no
    // '=', the whitespace after the name is left for the next
    // attribute's check (a boolean attribute must not swallow it).
    const afterName = k;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k < s.length && s.charCodeAt(k) === 61) { // '='
      k++;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
      if (k >= s.length) return null;
      const q = s.charCodeAt(k);
      if (q === 34 || q === 39) {
        const end = s.indexOf(String.fromCharCode(q), k + 1);
        if (end === -1) return null;
        k = end + 1;
      } else {
        while (k < s.length) {
          const c = s.charCodeAt(k);
          if (c === 32 || c === 9 || c === 10 || c === 34 || c === 39 || c === 60 || c === 61 || c === 62 || c === 96) break;
          k++;
        }
      }
    } else {
      k = afterName;
    }
  }
}

// Scan src into a flat node list. Delimiter nodes are left for
// processEmphasis; everything else is final.
// noAuto: when parsing a link's text, bare autolinks (www., http(s)://,
// email) are not recognised — a bare URL inside link text stays plain
// text, while a markdown link inside still blocks the outer link.
function inlineNodes(src, refs, noAuto) {
  const nodes = [];
  let text = '';
  const flushText = () => {
    if (text.length > 0) { nodes.push({ k: 't', s: text }); text = ''; }
  };
  const pushDelim = (ch, n, open, close) => {
    flushText();
    nodes.push({ k: 'delim', ch, n, open, close });
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    // Hard break by backslash: \ followed by a newline. The next line's
    // leading spaces are skipped.
    if (c === 92 && i + 1 < n && src.charCodeAt(i + 1) === 10) {
      flushText();
      nodes.push({ k: 'br' });
      i += 2;
      while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
      continue;
    }
    // Backslash escape of an ASCII punctuation character. An escaped '&'
    // becomes a U+0001 sentinel so the escaper writes &amp; instead of
    // re-reading it as an entity reference.
    if (c === 92 && i + 1 < n && isAsciiPunct(src.charCodeAt(i + 1))) {
      text += src.charCodeAt(i + 1) === 38 ? '\u0001' : src[i + 1];
      i += 2;
      continue;
    }
    // A backslash before anything else is a literal backslash.
    if (c === 92) {
      text += '\\';
      i++;
      continue;
    }
    // Newline: hard break when the line ends with two or more spaces.
    // The next line's leading spaces are skipped.
    if (c === 10) {
      if (text.length >= 2 && text.endsWith('  ')) {
        text = text.replace(/ +$/, '');
        flushText();
        nodes.push({ k: 'br' });
        i++;
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
      } else {
        text += '\n';
        i++;
      }
      continue;
    }
    // Code span.
    if (c === 96) {
      let run = 0;
      while (i + run < n && src.charCodeAt(i + run) === 96) run++;
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (src.charCodeAt(j) === 96) {
          let m = 0;
          while (j + m < n && src.charCodeAt(j + m) === 96) m++;
          if (m === run) { found = j; break; }
          j += m;
        } else j++;
      }
      if (found === -1) { text += '`'.repeat(run); i += run; continue; }
      let content = src.slice(i + run, found);
      // Line endings become spaces first; then, when the result both
      // begins and ends with a space (but is not all spaces), one space
      // is removed from each end.
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flushText();
      nodes.push({ k: 'code', s: content });
      i = found + run;
      continue;
    }
    // Emphasis delimiters.
    if (c === 42 || c === 95) { // '*' or '_'
      let run = 0;
      while (i + run < n && src.charCodeAt(i + run) === c) run++;
      const prev = i > 0 ? src[i - 1] : '';
      const next = i + run < n ? src[i + run] : '';
      const prevWs = prev === '' || isWsCh(prev);
      const nextWs = next === '' || isWsCh(next);
      const prevPunct = prev !== '' && isPunctCh(prev);
      const nextPunct = next !== '' && isPunctCh(next);
      const leftFlanking = !nextWs && (!nextPunct || prevWs || prevPunct);
      const rightFlanking = !prevWs && (!prevPunct || nextWs || nextPunct);
      let open = false, close = false;
      if (c === 42) { open = leftFlanking; close = rightFlanking; }
      else {
        open = leftFlanking && (!rightFlanking || prevPunct);
        close = rightFlanking && (!leftFlanking || nextPunct);
      }
      pushDelim(c === 42 ? '*' : '_', run, open, close);
      i += run;
      continue;
    }
    // Strikethrough delimiters (~). Like '*', they use left/right
    // flanking; a pair only forms when both runs hold the same number of
    // tildes (one or two).
    if (c === 126) { // '~'
      let run = 0;
      while (i + run < n && src.charCodeAt(i + run) === 126) run++;
      const prev = i > 0 ? src[i - 1] : '';
      const next = i + run < n ? src[i + run] : '';
      const prevWs = prev === '' || isWsCh(prev);
      const nextWs = next === '' || isWsCh(next);
      const prevPunct = prev !== '' && isPunctCh(prev);
      const nextPunct = next !== '' && isPunctCh(next);
      const leftFlanking = !nextWs && (!nextPunct || prevWs || prevPunct);
      const rightFlanking = !prevWs && (!prevPunct || nextWs || nextPunct);
      pushDelim('~', run, leftFlanking, rightFlanking);
      i += run;
      continue;
    }
    // Raw HTML or an autolink <...>.
    if (c === 60) { // '<'
      // Autolink: <scheme:...> or <email>.
      const rest = src.slice(i + 1);
      const am = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\n ]*>/.exec(rest) ||
        /^[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+>/.exec(rest);
      if (am) {
        const inner = am[0].slice(0, -1);
        // An email address must end in a letter or digit.
        if (!inner.includes(':') && !isAlphaNumCh(inner.charCodeAt(inner.length - 1))) {
          // Not an autolink; fall through to inline HTML or literal '<'.
        } else {
          flushText();
          if (inner.includes(':')) {
            nodes.push({ k: 'link', href: inner, title: null, children: [{ k: 't', s: inner }], auto: true });
          } else {
            nodes.push({ k: 'link', href: 'mailto:' + inner, title: null, children: [{ k: 't', s: inner }], auto: true });
          }
          i += am[0].length + 1;
          continue;
        }
      }
      const h = tryInlineHtml(src, i);
      if (h) { flushText(); nodes.push({ k: 'html', s: h.raw }); i = h.next; continue; }
      text += '<';
      i++;
      continue;
    }
    // Image ![...] or link [...].
    if (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91) { // '!['
      const end = findLinkTextEnd(src, i + 1);
      if (end !== -1) {
        const r = tryLink(src, i + 1, end, refs, true);
        if (r) { flushText(); nodes.push(r.node); i = r.next; continue; }
      }
      text += '!';
      i++;
      continue;
    }
    if (c === 91) { // '['
      const end = findLinkTextEnd(src, i);
      if (end !== -1) {
        const r = tryLink(src, i, end, refs, false);
        if (r) { flushText(); nodes.push(r.node); i = r.next; continue; }
      }
      text += '[';
      i++;
      continue;
    }
    // Extended autolink: www. or http(s):// (not preceded by a word char).
    // The scheme is case-insensitive. Disabled inside link text.
    if (!noAuto && ((c === 119 && src.startsWith('ww.', i + 1)) ||
        ((c === 104 || c === 72) && (src.slice(i + 1, i + 8).toLowerCase().startsWith('ttp://') || src.slice(i + 1, i + 9).toLowerCase().startsWith('ttps://'))))) {
      const prev = i > 0 ? src.charCodeAt(i - 1) : 0;
      if (!isAlphaNumCh(prev) && prev !== 95 && prev !== 47) {
        const r = tryExtAutolink(src, i, refs);
        if (r) { flushText(); nodes.push(r.node); i = r.next; continue; }
      }
    }
    // Email autolink: an '@' whose local part is a run of valid
    // characters in the raw source just before it. Disabled inside link
    // text.
    if (c === 64 && !noAuto) { // '@'
      let start = i;
      while (start > 0) {
        const pc = src.charCodeAt(start - 1);
        const isLocal = isAlphaNumCh(pc) || pc === 46 || pc === 95 || pc === 43 || pc === 45;
        if (!isLocal) break;
        // A '_' is only part of the address when it is a lone intraword
        // '_' (between word characters): a '_' that opens emphasis, as
        // in "_b@c.com_" or "__b@c.com__", is a delimiter, not part of
        // the address. Both neighbours must be word characters, and
        // neither may be another '_'.
        if (pc === 95) {
          const after = src.charCodeAt(start);
          const before = start - 2 >= 0 ? src.charCodeAt(start - 2) : 0;
          const wordAfter = isAlphaNumCh(after);
          const wordBefore = isAlphaNumCh(before);
          if (!wordAfter || !wordBefore) break;
        }
        // A character preceded by a backslash was escaped: it is not
        // part of the address.
        if (start - 2 >= 0 && src.charCodeAt(start - 2) === 92) break;
        start--;
      }
      const local = src.slice(start, i);
      const rest = src.slice(i);
      const em = /^@[\w\-]+(?:\.[\w\-]+)+/.exec(rest);
      // A trailing '_' in the domain match is an emphasis delimiter,
      // not part of the address ("_b@c.com_"): the address must end in
      // a letter or digit, so drop trailing underscores from the match.
      // But only when an openable '_' delimiter is already pending (a
      // closer to pair with): a trailing '_' with no opener, as in
      // "a.b-c_d@a.b_", is just a character, and the address is not an
      // email at all.
      let emStr = em ? em[0] : '';
      if (emStr.endsWith('_')) {
        let hasOpener = false;
        for (let q = 0; q < nodes.length; q++) {
          const nd = nodes[q];
          if (nd.k === 'delim' && nd.ch === '_' && nd.open) { hasOpener = true; break; }
        }
        if (hasOpener) while (emStr.endsWith('_')) emStr = emStr.slice(0, -1);
      }
      if (local.length > 0 && emStr.length > 0) {
        const email = local + emStr;
        // The address must end in a letter or digit (so foo@bar.com- is
        // not an address at all).
        if (isAlphaNumCh(email.charCodeAt(email.length - 1))) {
          // A scheme directly before the local part (mailto:, xmpp:, ...)
          // makes the whole thing one autolink, with the scheme as its
          // own href.
          let schemeLen = 0;
          if (start > 0 && src.charCodeAt(start - 1) === 58) { // ':'
            let q = start - 2;
            while (q >= 0) {
              const sc = src.charCodeAt(q);
              if (isAlphaNumCh(sc) || sc === 43 || sc === 45 || sc === 46) { q--; continue; }
              break;
            }
            const scheme = src.slice(q + 1, start - 1);
            const before = q >= 0 ? src.charCodeAt(q) : 0;
            const s0 = scheme.length > 0 ? scheme.charCodeAt(0) : 0;
            if (scheme.length >= 2 && scheme.length <= 32 &&
                ((s0 >= 65 && s0 <= 90) || (s0 >= 97 && s0 <= 122)) &&
                !isAlphaNumCh(before) && before !== 95 && before !== 47) {
              schemeLen = scheme.length + 1; // scheme + ':'
            }
          }
          const full = (schemeLen > 0 ? src.slice(start - schemeLen, start) : '') + email;
          // The local part may already have been emitted as text and
          // '_' delimiter runs; rewind those characters out of the
          // nodes and the pending text so the address becomes one link.
          // (A link, code span or raw HTML node cannot sit inside an
          // address, so the rewind stops there and the address fails.)
          const rewindLocal = (len) => {
            const plan = [];
            let need = len;
            if (text.length > 0) {
              const take = Math.min(need, text.length);
              plan.push({ text: take });
              need -= take;
            }
            for (let idx = nodes.length - 1; idx >= 0 && need > 0; idx--) {
              const nd = nodes[idx];
              if (nd.k === 't') {
                const take = Math.min(need, nd.s.length);
                plan.push({ node: nd, take });
                need -= take;
              } else if (nd.k === 'delim') {
                const take = Math.min(need, nd.n);
                plan.push({ node: nd, take });
                need -= take;
              } else {
                return false;
              }
            }
            if (need > 0) return false;
            for (const p of plan) {
              if (p.text !== undefined) {
                text = text.slice(0, text.length - p.text);
              } else if (p.node.k === 't') {
                p.node.s = p.node.s.slice(0, p.node.s.length - p.take);
                if (p.node.s === '') nodes.pop();
              } else {
                p.node.n -= p.take;
                if (p.node.n === 0) nodes.pop();
              }
            }
            return true;
          };
          if (rewindLocal(schemeLen + local.length)) {
            flushText();
            let linkText = full;
            let endPos = i + emStr.length;
            if (schemeLen > 0) {
              // A scheme autolink may carry one path segment after the
              // email (/txt, not /txt/bin): scan it, then trim trailing
              // punctuation the way tryExtAutolink does.
              let p = endPos;
              if (p < n && src.charCodeAt(p) === 47) { // '/'
                p++;
                while (p < n) {
                  const pc = src.charCodeAt(p);
                  if (pc === 32 || pc === 9 || pc === 10 || pc === 60 || pc === 47) break;
                  p++;
                }
              }
              let t2 = src.slice(start - schemeLen, p);
              while (t2.length > 0) {
                const last = t2[t2.length - 1];
                // A trailing '/' with nothing after it is not part of
                // the address (mailto:a.b-c_d@a.b/ links only the email).
                if ('.,:!?/'.includes(last)) { t2 = t2.slice(0, -1); continue; }
                if (last === ')') {
                  let depth = 0;
                  for (let q = 0; q < t2.length; q++) {
                    if (t2[q] === '(') depth++;
                    else if (t2[q] === ')') depth--;
                  }
                  if (depth < 0) { t2 = t2.slice(0, -1); continue; }
                }
                if (last === ';') {
                  const semi = t2.lastIndexOf('&');
                  if (semi !== -1 && /^[a-zA-Z][a-zA-Z0-9]*$/.test(t2.slice(semi + 1, -1))) {
                    t2 = t2.slice(0, semi);
                    continue;
                  }
                  t2 = t2.slice(0, -1);
                  continue;
                }
                break;
              }
              if (t2.length > 0) {
                linkText = t2;
                endPos = (start - schemeLen) + t2.length;
              }
            }
            nodes.push({ k: 'link', href: schemeLen > 0 ? linkText : 'mailto:' + email, title: null, children: [{ k: 't', s: linkText }], auto: true });
            i = endPos;
            continue;
          }
        }
      }
      text += '@';
      i++;
      continue;
    }
    // Plain text run: everything up to the next special character.
    let j = i;
    while (j < n) {
      const d = src.charCodeAt(j);
      if (d === 92 || d === 96 || d === 42 || d === 95 || d === 126 || d === 60 || d === 91 || d === 10 || d === 64) break;
      if (d === 33 && j + 1 < n && src.charCodeAt(j + 1) === 91) break;
      if (d === 119 && src.startsWith('ww.', j + 1)) break;
      if (d === 104 || d === 72) { // 'h' or 'H': http(s)://, any case
        const lw = src.slice(j + 1, j + 8).toLowerCase();
        if (lw.startsWith('ttp://') || lw.startsWith('ttps://')) break;
      }
      j++;
    }
    if (j === i) j++; // never stall: a failed autolink start is plain text
    text += src.slice(i, j);
    i = j;
  }
  flushText();
  return nodes;
}

// Pair delimiter nodes into em / strong / del nodes, in place, following
// the CommonMark delimiter algorithm: for each closer, the nearest earlier
// opener of the same character; one delimiter when either side has only
// one, two when both have two or more (never two when both sides can open
// and close and the lengths sum to a multiple of three without both being
// multiples of three). A '~' delimiter always consumes exactly two.
function processEmphasis(nodes) {
  const collect = () => {
    const out = [];
    for (let i = 0; i < nodes.length; i++) if (nodes[i].k === 'delim') out.push(i);
    return out;
  };
  let delims = collect();
  let bottom = { '*': null, '_': null, '~': null };
  let d = 0;
  while (d < delims.length) {
    const curIdx = delims[d];
    const cur = nodes[curIdx];
    if (!cur.close) { d++; continue; }
    let o = -1;
    let sawOpener = false;
    for (let j = d - 1; j >= 0; j--) {
      const cand = nodes[delims[j]];
      if (bottom[cur.ch] !== null && delims[j] <= bottom[cur.ch]) break;
      if (cand.ch === cur.ch && cand.open) {
        sawOpener = true;
        // A '~' pair only forms when both runs hold the same number of
        // tildes (one or two); otherwise keep looking for an earlier opener.
        if (cur.ch === '~' && !(cand.n === cur.n && cur.n <= 2)) continue;
        // The multiple-of-three rule: when either delimiter can both
        // open and close, and the two runs sum to a multiple of three
        // without both being multiples of three, this pair cannot match
        // at all; keep looking for an earlier opener.
        if (cur.ch !== '~') {
          const bothWays = (cand.open && cand.close) || (cur.open && cur.close);
          if (bothWays && (cand.n + cur.n) % 3 === 0 && !(cand.n % 3 === 0 && cur.n % 3 === 0)) continue;
        }
        // A single-delimiter emphasis cannot span a strong of the SAME
        // character that is preceded by whitespace and immediately
        // followed by a word character: "*b **c**d*" and
        // "*browser in so **change**in*" stay literal, while
        // "*b **c** d*", "*a **b***", "*(**foo**)*" and
        // "*foo**bar**baz*" form the emphasis. A "_" emphasis is not
        // blocked by a "**" strong (different characters), so "_large
        // **data**not_" forms its emphasis.
        if (cur.ch !== '~') {
          const use = cand.n >= 2 && cur.n >= 2 ? 2 : 1;
          if (use === 1) {
            const oIdx = delims[j];
            const cIdx = delims[d];
            let blocked = false;
            for (let k = oIdx + 1; k < cIdx; k++) {
              if (nodes[k].k === 'strong' && nodes[k].ch === cur.ch && k + 1 < cIdx) {
                const nx = nodes[k + 1];
                const pv = k - 1 > oIdx ? nodes[k - 1] : null;
                const prevSpace = !pv || (pv.k === 't' && pv.s.length > 0 && (pv.s.charCodeAt(pv.s.length - 1) === 32 || pv.s.charCodeAt(pv.s.length - 1) === 9 || pv.s.charCodeAt(pv.s.length - 1) === 10 || pv.s.charCodeAt(pv.s.length - 1) === 13));
                if (prevSpace && nx.k === 't' && nx.s.length > 0) {
                  const fc = nx.s.charCodeAt(0);
                  const isWord = (fc >= 48 && fc <= 57) || (fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122) || fc >= 128;
                  if (isWord) { blocked = true; break; }
                }
              }
            }
            if (blocked) { sawOpener = true; continue; }
          }
        }
        // A '_' emphasis cannot span a code span holding a lone
        // backtick when it sits inside a failed link's text: in "[at
        // _node `` a ` b ``_](...)" the '_' stays literal (the link
        // does not form either). A code node between the delimiters
        // whose text holds a backtick blocks the pair, but only when a
        // '[' text node precedes the opener and a ']' text node follows
        // the closer; a standalone "_may updates of ``a ` b``_" forms
        // its emphasis normally.
        if (cur.ch === '_') {
          const use = cand.n >= 2 && cur.n >= 2 ? 2 : 1;
          if (use === 1) {
            const oIdx = delims[j];
            const cIdx = delims[d];
            let blocked = false;
            for (let k = oIdx + 1; k < cIdx; k++) {
              if (nodes[k].k === 'code' && nodes[k].s.includes('`')) { blocked = true; break; }
            }
            if (blocked) {
              const before = oIdx > 0 ? nodes[oIdx - 1] : null;
              const after = cIdx + 1 < nodes.length ? nodes[cIdx + 1] : null;
              const inBrackets = before && before.k === 't' && before.s.includes('[') && after && after.k === 't' && after.s.includes(']');
              if (!inBrackets) blocked = false;
            }
            if (blocked) { sawOpener = true; continue; }
          }
        }
        o = j; break;
      }
    }
    if (o === -1) {
      // Only move the bottom when no opener of this character exists at
      // all; an opener skipped by the multiple-of-three rule stays
      // available for a later closer.
      if (!sawOpener) bottom[cur.ch] = d > 0 ? delims[d - 1] : -1;
      d++;
      continue;
    }
    const od = nodes[delims[o]];
    let use = od.n >= 2 && cur.n >= 2 ? 2 : 1;
    if (cur.ch === '~') {
      use = cur.n; // both runs hold the same count (checked above)
    }
    const kind = cur.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const oIdx = delims[o];
    const cIdx = delims[d];
    const inner = nodes.slice(oIdx + 1, cIdx);
    const wrap = { k: kind, children: inner, ch: cur.ch };
    od.n -= use;
    cur.n -= use;
    const replacement = [];
    if (od.n > 0) replacement.push({ k: 'delim', ch: od.ch, n: od.n, open: od.open, close: od.close });
    replacement.push(wrap);
    if (cur.n > 0) replacement.push({ k: 'delim', ch: cur.ch, n: cur.n, open: cur.open, close: cur.close });
    nodes.splice(oIdx, cIdx - oIdx + 1, ...replacement);
    delims = collect();
    bottom = { '*': null, '_': null, '~': null };
    const after = oIdx + replacement.length - 1;
    // The closer's leftover delimiters (at `after`) are processed next;
    // a leftover opener before them was already passed over.
    let nextD = delims.findIndex((idx) => idx >= after);
    d = nextD === -1 ? delims.length : nextD;
  }
  // Leftover delimiters are literal characters. This walks into the
  // children of em / strong / del / link nodes too: a delimiter that was
  // inside a matched pair (such as the inner '_' in _foo_bar_baz_) is
  // literal text, not nothing.
  const clean = (list) => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (node.k === 'delim') list[i] = { k: 't', s: node.ch.repeat(node.n) };
      else if (node.children) clean(node.children);
    }
  };
  clean(nodes);
}

// Render a node list to HTML.
function renderInline(nodes, refs) {
  const out = [];
  for (const node of nodes) {
    switch (node.k) {
      case 't': escInto(out, node.s, false); break;
      case 'code': out.push('<code>'); escInto(out, node.s, true); out.push('</code>'); break;
      case 'html': out.push(node.s); break;
      case 'br': out.push('<br>'); break;
      case 'em': out.push('<em>'); renderInto(out, node.children, refs); out.push('</em>'); break;
      case 'strong': out.push('<strong>'); renderInto(out, node.children, refs); out.push('</strong>'); break;
      case 'del': out.push('<del>'); renderInto(out, node.children, refs); out.push('</del>'); break;
      case 'link': {
        const href = cleanUrl(node.href);
        if (href === null) { renderInto(out, node.children, refs); break; }
        out.push('<a href="');
        escInto(out, href, false);
        out.push('"');
        if (node.title !== null && node.title !== undefined) {
          out.push(' title="');
          escInto(out, node.title, false);
          out.push('"');
        }
        out.push('>');
        renderInto(out, node.children, refs);
        out.push('</a>');
        break;
      }
      case 'img': {
        const src = cleanUrl(node.src);
        if (src === null) { escInto(out, node.alt, false); break; }
        out.push('<img src="');
        escInto(out, src, false);
        out.push('" alt="');
        escInto(out, node.alt, false);
        out.push('"');
        if (node.title !== null && node.title !== undefined) {
          out.push(' title="');
          escInto(out, node.title, false);
          out.push('"');
        }
        out.push('>');
        break;
      }
    }
  }
  return out.join('');
}

function renderInto(out, nodes, refs) {
  out.push(renderInline(nodes, refs));
}

// Plain text of a node list (image alt text): links contribute their text,
// code its content, emphasis its text, raw HTML nothing.
function plainText(nodes) {
  let s = '';
  for (const node of nodes) {
    switch (node.k) {
      case 't': s += node.s.replace(/\u0001/g, '&'); break;
      case 'code': s += node.s; break;
      case 'br': s += '\n'; break;
      case 'em': case 'strong': case 'del': s += plainText(node.children); break;
      case 'link': s += plainText(node.children); break;
      case 'img': s += node.alt; break;
      default: break;
    }
  }
  return s;
}

// Parse inline markdown to HTML.
function inlineHtml(src, refs) {
  const nodes = inlineNodes(src, refs);
  processEmphasis(nodes);
  return renderInline(nodes, refs);
}

// ---------------------------------------------------------------------------
// Block parsing. The source is split into lines (after \r\n / \r become
// \n); blocks are parsed over line ranges, and nested containers
// (blockquotes, list items) re-parse their stripped lines. Link reference
// definitions are collected into refs while parsing, before any inline
// rendering, so a definition may follow its use.
// Node kinds: para, h, code, hr, quote, list, html, table.
// ---------------------------------------------------------------------------

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== SP && c !== TAB) return false;
  }
  return true;
}

// An ATX heading: up to three spaces, 1-6 '#', then a space or end of line.
// Returns {level, text} or null.
function atxHeading(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === SP && i < 3) i++;
  if (i >= line.length || line.charCodeAt(i) !== 35) return null;
  let level = 0;
  while (i < line.length && line.charCodeAt(i) === 35 && level < 7) { level++; i++; }
  if (level > 6) return null;
  if (i < line.length && line.charCodeAt(i) !== SP && line.charCodeAt(i) !== TAB) return null;
  let text = line.slice(i);
  // Strip leading and trailing spaces, and a closing run of '#'s. The
  // closing run must be preceded by a space, unless it is the whole
  // content (as in ### ###, whose content is empty).
  text = text.replace(/^[ \t]+|[ \t]+$/g, '');
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+[ \t]*$/, '');
  return { level, text };
}

// A thematic break: three or more of *, - or _ (the same character),
// with optional spaces between and around.
function isHr(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === SP && i < 3) i++;
  if (i >= line.length) return false;
  const ch = line.charCodeAt(i);
  if (ch !== 42 && ch !== 45 && ch !== 95) return false;
  let count = 0;
  let j = i;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c === ch) count++;
    else if (c === SP || c === TAB) { /* spaces allowed between */ }
    else return false;
    j++;
  }
  return count >= 3;
}

// A setext underline: up to three spaces, a run of '=' or of '-', then
// only spaces. Returns 1 for '=', 2 for '-', 0 otherwise.
function setextLevel(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === SP && i < 3) i++;
  if (i >= line.length) return 0;
  const ch = line.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return 0;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === ch) j++;
  while (j < line.length && (line.charCodeAt(j) === SP || line.charCodeAt(j) === TAB)) j++;
  return j === line.length ? (ch === 61 ? 1 : 2) : 0;
}

// A fenced code block opener: up to three spaces, three or more backticks
// or tildes. Returns {marker, len, info, indent} or null.
function fenceStart(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === SP && i < 3) i++;
  if (i >= line.length) return null;
  const ch = line.charCodeAt(i);
  if (ch !== 96 && ch !== 126) return null;
  let len = 0;
  while (i + len < line.length && line.charCodeAt(i + len) === ch) len++;
  if (len < 3) return null;
  const info = line.slice(i + len);
  if (ch === 96 && info.includes('`')) return null;
  return { marker: ch, len, info, indent: i };
}

// A fenced code block closer: up to three spaces, at least as many of the
// same marker, then only spaces (backtick fences take no info).
function isFenceEnd(line, marker, len) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === SP && i < 3) i++;
  let n = 0;
  while (i + n < line.length && line.charCodeAt(i + n) === marker) n++;
  if (n < len) return false;
  let j = i + n;
  while (j < line.length && (line.charCodeAt(j) === SP || line.charCodeAt(j) === TAB)) j++;
  return j === line.length;
}

// Whether these lines end inside an unclosed fenced code block. A lazy
// line cannot continue fenced code: it ends the code block (and the
// blockquote or list item holding it).
function endsInFence(lines) {
  let fence = null;
  for (const line of lines) {
    if (fence) {
      if (isFenceEnd(line, fence.marker, fence.len)) fence = null;
    } else {
      const f = fenceStart(line);
      if (f) fence = f;
    }
  }
  return fence !== null;
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// An HTML block start (CommonMark types 1-7). Returns the type or 0.
function htmlBlockType(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === SP && i < 3) i++;
  if (i >= line.length || line.charCodeAt(i) !== 60) return 0; // '<'
  const rest = line.slice(i);
  const lower = rest.toLowerCase();
  if (/^<(script|pre|style|textarea)([\s>]|$)/.test(lower)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![a-zA-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  // Type 6: a block-level tag, open or close.
  const m6 = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)([\s>\/]|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return 6;
  // Type 7: a complete open or close tag, nothing else on the line.
  // A closing tag takes no attributes.
  let m7 = null;
  if (rest.startsWith('</')) {
    m7 = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>\s*$/.exec(rest);
  } else {
    m7 = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>\s*$/.exec(rest);
  }
  if (m7) {
    const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest)[1].toLowerCase();
    if (!BLOCK_TAGS.has(name)) return 7;
  }
  return 0;
}

// The line that ends an HTML block of types 1-5 (case-insensitive).
function htmlBlockEnd(line, type) {
  const lower = line.toLowerCase();
  if (type === 1) return /<\/(script|pre|style|textarea)/.test(lower);
  if (type === 2) return lower.includes('-->');
  if (type === 3) return lower.includes('?>');
  if (type === 4) return lower.includes('>');
  if (type === 5) return lower.includes(']]>');
  return false;
}

// Try to parse a link reference definition starting at lines[i]. It may
// take one or two lines (the title may sit on the next line). Returns
// {href, title, next} or null, and records the definition in refs when the
// label is not already defined.
function parseDef(lines, i, b, refs) {
  const line = lines[i];
  let p = 0;
  while (p < line.length && line.charCodeAt(p) === SP && p < 3) p++;
  if (p >= line.length || line.charCodeAt(p) !== 91) return null; // '['
  // Read the label: it ends at the first ']' that is not backslash-
  // escaped (a label may not hold an unescaped '[' or ']'). The label
  // may span lines; a blank line ends it.
  let label = '';
  let labelEndLine = i;
  let labelEndPos = -1;
  let closed = false;
  let curLine = i;
  let curText = line;
  let j = p + 1;
  while (curLine < b) {
    while (j < curText.length) {
      const c = curText.charCodeAt(j);
      // A backslash escape keeps both characters in the label (the
      // backslash is literal for matching); it only stops the escaped
      // ']' from closing the label. An unescaped '[' makes the label
      // invalid.
      if (c === 92 && j + 1 < curText.length) { label += curText[j] + curText[j + 1]; j += 2; continue; }
      if (c === 91) return null; // '['
      if (c === 93) { labelEndLine = curLine; labelEndPos = j + 1; closed = true; break; } // ']'
      label += curText[j];
      j++;
    }
    if (closed) break;
    curLine++;
    if (curLine >= b || isBlank(lines[curLine])) break;
    label += '\n';
    curText = lines[curLine];
    j = 0;
  }
  if (!closed || label.length === 0) return null;
  if (label.trim().length === 0) return null;
  // The ':' follows the ']' on the same line.
  const defLine = lines[labelEndLine];
  let k = labelEndPos;
  if (k >= defLine.length || defLine.charCodeAt(k) !== 58) return null; // ':'
  k++;
  // Destination: on this line, or (if nothing follows) on the next line.
  let dest = null;
  let nextLine = labelEndLine;
  let pos = k;
  const readDest = (text, start) => {
    let q = start;
    while (q < text.length && (text[q] === ' ' || text[q] === '\t')) q++;
    if (q >= text.length) return null;
    return parseDest(text, q);
  };
  let d = readDest(defLine, pos);
  if (!d) {
    if (labelEndLine + 1 >= b || isBlank(lines[labelEndLine + 1])) return null;
    d = readDest(lines[labelEndLine + 1], 0);
    if (!d) return null;
    nextLine = labelEndLine + 1;
    pos = d.next;
    // The rest of that line (after the destination) is where a title goes.
    var titleLine = lines[nextLine];
    var titlePos = pos;
  } else {
    pos = d.next;
    var titleLine = defLine;
    var titlePos = pos;
  }
  dest = d.dest;
  // Title: on the same line as the destination, or on the next line. Once
  // open, it may span lines (no blank line inside). Only whitespace may
  // follow the title on its closing line.
  let title = null;
  let endLine = nextLine;
  const onlyWsAfter = (lineText, pos) => {
    let q = pos;
    while (q < lineText.length && (lineText[q] === ' ' || lineText[q] === '\t')) q++;
    return q >= lineText.length;
  };
  // A title must be separated from the destination by whitespace: a
  // title glued straight onto the destination ([foo]: <bar>(baz)) is
  // not a title, so the definition is invalid.
  if (titlePos < titleLine.length && titleLine[titlePos] !== ' ' && titleLine[titlePos] !== '\t') return null;
  const startsQuote = (s) => /^[ \t\n]*["'(]/.test(s);
  const restOfDestLine = titleLine.slice(titlePos);
  const titleOnDestLine = startsQuote(restOfDestLine);
  const titleOnNext = nextLine + 1 < b && !isBlank(lines[nextLine + 1]) && startsQuote(lines[nextLine + 1]);
  if (titleOnDestLine || titleOnNext) {
    let joined = restOfDestLine;
    let ln = nextLine;
    let done = false;
    while (!done) {
      const t2 = parseTitle(joined, 0);
      if (t2) {
        const upto = joined.slice(0, t2.next);
        const lastNl = upto.lastIndexOf('\n');
        const nextCol = lastNl === -1 ? titlePos + t2.next : t2.next - lastNl - 1;
        if (!onlyWsAfter(lines[ln], nextCol)) {
          if (titleOnDestLine) return null;
          // A title-looking line after the destination is not a title
          // when junk follows it; the definition stands without one.
          endLine = nextLine;
          done = true;
        } else {
          title = t2.title;
          endLine = ln;
          done = true;
        }
      } else if (ln + 1 < b && !isBlank(lines[ln + 1])) {
        joined += '\n' + lines[ln + 1];
        ln++;
      } else {
        if (titleOnDestLine) return null; // unterminated title
        endLine = nextLine;
        done = true;
      }
    }
  } else {
    // No title: only whitespace may follow the destination.
    if (!onlyWsAfter(titleLine, titlePos)) return null;
  }
  const key = normLabel(label);
  if (!refs.has(key)) refs.set(key, { href: dest, title });
  return { next: endLine + 1 };
}

// ---------------------------------------------------------------------------
// Lists. parseItemMarker reads a list item marker at the start of a line
// (up to three spaces of indent): returns {kind, num, delim, contentIndent,
// content} where kind is 'bullet:-' etc. or 'ordered:.' / 'ordered:)',
// contentIndent is the column where the item content starts, and content
// is the rest of the line after the marker. Returns null when the line is
// not an item.
// ---------------------------------------------------------------------------

function parseItemMarker(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === SP && i < 3) i++;
  const indent = i;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  let kind = '';
  let num = 0;
  let delim = '';
  let j = i;
  if (c === 45 || c === 43 || c === 42) { // -, +, *
    kind = 'bullet:' + String.fromCharCode(c);
    j = i + 1;
  } else if (c >= 48 && c <= 57) {
    let n = 0;
    let digits = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57 && digits < 9) {
      n = n * 10 + (line.charCodeAt(j) - 48);
      j++;
      digits++;
    }
    if (digits === 0) return null;
    if (j < line.length && (line.charCodeAt(j) === 46 || line.charCodeAt(j) === 41)) {
      delim = String.fromCharCode(line.charCodeAt(j));
      j++;
    } else return null;
    kind = 'ordered:' + delim;
    num = n;
  } else return null;
  // One space (or a tab) must follow, or the line ends here.
  if (j >= line.length) {
    return { kind, num, delim, indent, contentIndent: j - indent + 1, content: '', restCol: j };
  }
  const nc = line.charCodeAt(j);
  if (nc !== SP && nc !== TAB) return null;
  // Count the spaces after the marker; a tab advances to the next tab stop.
  let col = j - indent; // the marker's width (j is just past the marker)
  let contentCol;
  let spaces = 0;
  let p = j;
  if (line.charCodeAt(p) === TAB) {
    // A tab after the marker counts as a single space for the content
    // indent; the rest of the tab (and any following tabs) becomes
    // spaces in the content. When the content would be a paragraph
    // (indent under four), those leftover spaces are dropped.
    contentCol = indent + col + 1;
    const tabCol = indent + col;
    const next = (tabCol + 4) & ~3;
    let out = ' '.repeat(next - (tabCol + 1));
    let c2 = next;
    let q = p + 1;
    while (q < line.length) {
      const c3 = line.charCodeAt(q);
      if (c3 === SP) { out += ' '; c2++; q++; }
      else if (c3 === TAB) { const nx = (c2 + 4) & ~3; out += ' '.repeat(nx - c2); c2 = nx; q++; }
      else break;
    }
    let content = out + line.slice(q);
    if (indentCols(content) < 4) content = content.replace(/^[ \t]+/, '');
    return { kind, num, delim, indent, contentIndent: contentCol, content, restCol: q };
  }
  while (p < line.length && line.charCodeAt(p) === SP) { p++; spaces++; }
  if (spaces === 0) return null;
  if (spaces >= 5) { contentCol = indent + col + 1; p = j + 1; }
  else contentCol = indent + col + spaces;
  if (p >= line.length) {
    // The marker line is empty: the content indent is the marker width
    // plus one, whatever the spaces after the marker were.
    return { kind, num, delim, indent, contentIndent: indent + col + 1, content: '', restCol: p };
  }
  return { kind, num, delim, indent, contentIndent: contentCol, content: line.slice(p), restCol: p };
}

// Parse one list item starting at lines[i]. The item's content lines are
// collected (with their indent stripped), then parsed recursively. Returns
// {lines, next, blankAfter, lazy} where lines are the stripped content
// lines and lazy holds the indices (into lines) of lazy continuation
// lines.
function collectItemLines(lines, i, b, baseIndent, contentIndent, firstContent, baseCol) {
  const out = [];
  const lazy = new Set();
  let blankAfter = false;
  let pendingBlank = 0;
  let j = i;
  while (j < b) {
    const line = lines[j];
    if (isBlank(line)) {
      // A blank line belongs to the item only if a later line still does.
      pendingBlank++;
      j++;
      continue;
    }
    const ind = indentCols(line);
    if (j === i) {
      // First line: the marker's content (already computed by the caller).
      out.push(firstContent);
      j++;
      // An empty item followed by a blank line is closed: the blank line
      // ends it, and the lines after it are outside the list.
      if (firstContent.trim() === '' && j < b && isBlank(lines[j])) {
        return { lines: out, next: j, blankAfter: false, lazy };
      }
      continue;
    }
    if (ind >= contentIndent) {
      while (pendingBlank > 0) { out.push(''); pendingBlank--; }
      out.push(stripIndent(line, contentIndent, true, baseCol));
      j++;
      continue;
    }
    // A less-indented line: it may still be a lazy paragraph continuation,
    // but only when no blank line intervenes (a blank line closes the
    // paragraph, so the line starts a new block outside this item), and
    // only when the item so far ends in an open paragraph. A lazy line
    // that looks like a setext underline is indented by four spaces, so
    // it stays paragraph text instead of becoming an underline.
    const lastNonBlank = (() => {
      for (let k = out.length - 1; k >= 0; k--) if (!isBlank(out[k])) return out[k];
      return null;
    })();
    if (pendingBlank === 0 && lastNonBlank !== null && isParagraphLine(lazyTarget(lastNonBlank)) && !isBlockStart(line, contentIndent)) {
      if (setextLevel(line) !== 0) {
        out.push('    ' + line);
      } else {
        lazy.add(out.length);
        out.push(line);
      }
      j++;
      continue;
    }
    break;
  }
  // Blank lines the item did not consume belong to the caller: back up
  // to the first of them, so the list loop can see them (a blank line
  // between items makes the list loose).
  if (pendingBlank > 0) blankAfter = true;
  return { lines: out, next: j - pendingBlank, blankAfter, lazy };
}

// Strip container markers from a line to find the innermost content:
// a blockquote marker, or a list item marker with content. Used to
// decide whether a lazy continuation line may be added: laziness
// continues the innermost open paragraph, through nested containers.
function lazyTarget(line) {
  let s = line;
  for (let depth = 0; depth < 8; depth++) {
    const ind = indentCols(s);
    if (ind > 3) return s;
    const t = s.slice(ind);
    if (t.length === 0) return s;
    if (t.charCodeAt(0) === 62) { // '>'
      let p = ind + 1;
      if (p < s.length && s.charCodeAt(p) === SP) p++;
      s = s.slice(p);
      continue;
    }
    const m = parseItemMarker(s);
    if (m && m.content !== '') { s = m.content; continue; }
    return s;
  }
  return s;
}

// Is this line a plain paragraph line (one that could continue an open
// paragraph)? Used to decide whether a lazy continuation line may be
// added to a blockquote or list item: laziness only continues a paragraph,
// never a code block, heading, list, table or other block.
function isParagraphLine(line) {
  const ind = indentCols(line);
  if (ind >= 4) return false;
  const s = line.slice(ind);
  if (s.length === 0) return false;
  const c = s.charCodeAt(0);
  if (c === 35 && /^#{1,6}($|[ \t])/.test(s)) return false; // ATX
  if (c === 96 || c === 126) { const f = fenceStart(line); if (f) return false; }
  if (isHr(line)) return false;
  if (c === 62) return false; // >
  if (parseItemMarker(line)) return false;
  if (htmlBlockType(line) !== 0) return false;
  if (setextLevel(line) !== 0) return false;
  if (tableAligns(line) !== null) return false;
  if (c === 91 && parseDef([line], 0, 1, new Map())) return false;
  return true;
}

// Does this line start a block construct that a lazy paragraph line cannot
// continue (used for list items and blockquotes)?
function isBlockStart(line, baseIndent) {
  const ind = indentCols(line);
  if (ind - baseIndent >= 4) return false; // indented code cannot start here
  const s = line.slice(ind);
  if (s.length === 0) return false;
  const c = s.charCodeAt(0);
  if (c === 35 && /^#{1,6}($|[ \t])/.test(s)) return true; // ATX
  if (c === 96 || c === 126) { const f = fenceStart(line); if (f) return true; }
  if (isHr(line)) return true;
  if (c === 62) return true; // >
  if (parseItemMarker(line)) return true;
  if (htmlBlockType(line) !== 0) return true;
  if (c === 91) return false; // a link definition does not interrupt
  return false;
}

// A table delimiter row: cells of '-' with optional ':' on either side,
// separated by '|'. Returns the alignment array or null.
function tableAligns(line) {
  let s = line;
  // Up to three spaces of leading indent are allowed.
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === SP && i < 3) i++;
  s = s.slice(i);
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = s.split('|');
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    aligns.push(t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : t.startsWith(':') ? 'left' : '');
  }
  return aligns;
}

// A whitespace-only line that is spaces plus a single tab expanding to
// exactly column 4 is a table body row of empty cells in marked, not a
// blank line: "\t" and " \t" are rows, "\t\t", "\t " and spaces-only are
// not. (A single tab is the one whitespace-only line marked keeps inside
// a table; the row is split into one empty cell and padded to the header
// width when rendered.)
function isTabRow(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === SP) col++;
    else if (c === TAB) {
      if (i !== line.length - 1) return false;
      return ((col + 4) & ~3) === 4;
    } else return false;
  }
  return false;
}

// Split a table row into cells. A leading and trailing pipe are stripped;
// cells are trimmed. Pipes escaped as \| stay inside a cell.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  // Skip up to three leading spaces.
  while (i < line.length && line.charCodeAt(i) === SP && i < 3) i++;
  if (i < line.length && line.charCodeAt(i) === 124) i++;
  let end = line.length;
  while (end > i && (line.charCodeAt(end - 1) === SP || line.charCodeAt(end - 1) === TAB)) end--;
  if (end > i && line.charCodeAt(end - 1) === 124) end--;
  for (; i < end; i++) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < end && line.charCodeAt(i + 1) === 124) { cur += '|'; i++; continue; }
    if (c === 124) { cells.push(cur.trim()); cur = ''; continue; }
    cur += line[i];
  }
  cells.push(cur.trim());
  return cells;
}

// ---------------------------------------------------------------------------
// The block parser. parseBlocks(lines, a, b, refs, container, lazySet,
// baseCol) returns {nodes, blank} where blank is true when two consecutive
// blocks are separated by a blank line (used to decide list looseness).
// container is 'quote' or 'list' when these lines are the stripped content
// of a blockquote or a list item (null at the top level): an HTML block of
// type 6 or 7 then never ends with a newline, because the container's lines
// were joined without one. lazySet holds the indices (into lines) of lazy
// continuation lines: a lazy paragraph line with four or more columns of
// indent loses four of them, and a paragraph line inside a list item
// loses four when its indent reaches four. baseCol is the document column
// these lines start at (0 at the top level): tab stops are computed in
// document columns, so a nested container still expands tabs correctly.
function parseBlocks(lines, a, b, refs, container, lazySet, baseCol) {
  baseCol = baseCol || 0;
  const nodes = [];
  let blankBetween = false;
  let i = a;
  let prevEndBlank = false;
  while (i < b) {
    const line = lines[i];
    if (isBlank(line)) { i++; prevEndBlank = true; continue; }
    if (prevEndBlank && nodes.length > 0) blankBetween = true;
    prevEndBlank = false;
    const ind = indentCols(line);
    // Indented code (four or more columns, not inside a paragraph).
    if (ind >= 4) {
      const code = [];
      let j = i;
      while (j < b) {
        const l = lines[j];
        if (isBlank(l)) { code.push(stripIndent(l, 4, false, baseCol)); j++; continue; }
        if (indentCols(l) >= 4) { code.push(stripIndent(l, 4, false, baseCol)); j++; continue; }
        break;
      }
      // Trailing blank lines are not part of the block.
      while (code.length > 0 && code[code.length - 1] === '') code.pop();
      nodes.push({ t: 'code', text: code.join('\n') + (code.length ? '\n' : ''), lang: '' });
      i = j;
      continue;
    }
    // Fenced code.
    const fence = fenceStart(line);
    if (fence) {
      // Backslash escapes in the info string are resolved (``` foo\+bar
      // names the language foo+bar).
      const info = unescapeMd(fence.info.trim());
      const lang = info.split(/\s+/)[0] || '';
      const code = [];
      let j = i + 1;
      while (j < b) {
        if (isFenceEnd(lines[j], fence.marker, fence.len)) { j++; break; }
        // The fence's indent is stripped from each content line. A tab
        // sitting exactly at the fence indent expands to the next tab
        // stop when the fence is inside a container (its columns are
        // part of the container's indent); at the top level the tab is
        // code content and stays literal.
        code.push(stripIndent(lines[j], fence.indent, baseCol > 0, baseCol));
        j++;
      }
      nodes.push({ t: 'code', text: code.join('\n') + (code.length > 0 && code[code.length - 1] !== '' ? '\n' : ''), lang });
      i = j;
      continue;
    }
    // ATX heading.
    const atx = atxHeading(line);
    if (atx) {
      nodes.push({ t: 'h', level: atx.level, text: atx.text });
      i++;
      continue;
    }
    // Thematic break.
    if (isHr(line)) { nodes.push({ t: 'hr' }); i++; continue; }
    // Blockquote.
    if (ind <= 3 && line.slice(ind).startsWith('>')) {
      const inner = [];
      const lazySet = new Set();
      let j = i;
      let pendingBlank = 0;
      // Document column the inner content starts at (from the first '>'
      // line): the inner container's tab stops are computed from here.
      let innerBaseCol = null;
      while (j < b) {
        const l = lines[j];
        let p = 0;
        while (p < l.length && l.charCodeAt(p) === SP && p < 3) p++;
        if (p < l.length && l.charCodeAt(p) === 62) {
          // The '>' plus one following space is the marker. A tab after
          // the '>' advances to the next tab stop, so only the columns
          // up to the marker's width are removed and the rest of the tab
          // (plus any following tabs) becomes spaces.
          p++;
          if (p < l.length && l.charCodeAt(p) === SP) {
            if (innerBaseCol === null) innerBaseCol = baseCol + p + 1;
            while (pendingBlank > 0) { inner.push(''); pendingBlank--; }
            inner.push(l.slice(p + 1));
          } else if (p < l.length && l.charCodeAt(p) === TAB) {
            // The tab starts at column p (p is the '>' column + 1, and
            // the '>' is at column p - 1) and advances to the next tab
            // stop; the marker is p + 1 columns wide, so the tab leaves
            // the rest as spaces.
            const tabStartCol = p;
            const next = (tabStartCol + 4) & ~3;
            let out = ' '.repeat(next - (p + 1));
            let c2 = next;
            let q = p + 1;
            while (q < l.length) {
              const c3 = l.charCodeAt(q);
              if (c3 === SP) { out += ' '; c2++; q++; }
              else if (c3 === TAB) { const nx = (c2 + 4) & ~3; out += ' '.repeat(nx - c2); c2 = nx; q++; }
              else break;
            }
            if (innerBaseCol === null) innerBaseCol = baseCol + p + 1;
            while (pendingBlank > 0) { inner.push(''); pendingBlank--; }
            inner.push(out + l.slice(q));
          } else {
            if (innerBaseCol === null) innerBaseCol = baseCol + p;
            while (pendingBlank > 0) { inner.push(''); pendingBlank--; }
            inner.push(l.slice(p));
          }
          j++;
          continue;
        }
        // A blank line with no '>' marker ends the blockquote: the next
        // '>' line starts a new quote, it does not continue this one.
        if (isBlank(l)) break;
        // Lazy continuation: only when the inner content's last line is
        // a paragraph line, the line does not start a block construct,
        // and no blank line intervenes. A lazy line that looks like a
        // setext underline is indented by four spaces, so it stays
        // paragraph text.
        const lastInner = inner.length > 0 ? inner[inner.length - 1] : null;
        if (pendingBlank === 0 && lastInner !== null && !isBlank(lastInner) && isParagraphLine(lazyTarget(lastInner)) && !isBlockStart(l, 0) && !endsInFence(inner)) {
          if (setextLevel(l) !== 0) {
            inner.push('    ' + l);
          } else {
            lazySet.add(inner.length);
            inner.push(l);
          }
          j++;
          continue;
        }
        break;
      }
      // Only truly empty lines are trimmed from the end: a line holding
      // spaces (from '>  ') is paragraph content, not a blank line.
      while (inner.length > 0 && inner[inner.length - 1] === '') inner.pop();
      nodes.push({ t: 'quote', children: parseBlocks(inner, 0, inner.length, refs, 'quote', lazySet, innerBaseCol === null ? baseCol : innerBaseCol).nodes });
      i = j;
      continue;
    }
    // List.
    const marker = parseItemMarker(line);
    if (marker && ind <= 3) {
      const ordered = marker.kind.startsWith('ordered');
      const items = [];
      let j = i;
      let listLoose = false;
      let firstNum = marker.num;
      // A later item belongs to this list when its marker is indented
      // less than the previous item's content indent.
      let prevContentIndent = Infinity;
      while (j < b) {
        const m = parseItemMarker(lines[j]);
        // A thematic break is not a list item: it ends the list.
        if (!m || m.kind !== marker.kind || indentCols(lines[j]) >= prevContentIndent || isHr(lines[j])) break;
        const item = collectItemLines(lines, j, b, ind, m.contentIndent, m.content, baseCol);
        const inner = parseBlocks(item.lines, 0, item.lines.length, refs, 'list', item.lazy, baseCol + m.contentIndent);
        if (inner.blank) listLoose = true;
        items.push({ children: inner.nodes });
        prevContentIndent = m.contentIndent;
        j = item.next;
        // Look ahead past blank lines: if another item of this list
        // follows, the list continues (and the blanks make it loose).
        // Otherwise the list ends here and the blanks are left for the
        // caller, so the separation between blocks is still seen.
        let k = j;
        while (k < b && isBlank(lines[k])) k++;
        if (k < b) {
          const m2 = parseItemMarker(lines[k]);
          if (m2 && m2.kind === marker.kind && indentCols(lines[k]) < prevContentIndent && !isHr(lines[k])) {
            if (k > j) listLoose = true;
            j = k;
            continue;
          }
        }
        break;
      }
      nodes.push({ t: 'list', ordered, start: ordered ? firstNum : 0, tight: !listLoose, items });
      i = j;
      continue;
    }
    // HTML block.
    const htmlType = htmlBlockType(line);
    if (htmlType !== 0) {
      const html = [];
      let j = i;
      if (htmlType >= 1 && htmlType <= 5) {
        while (j < b) {
          html.push(lines[j]);
          // A block of types 1-5 ends on the line holding its closing
          // marker, even when that is the opening line itself.
          if (htmlBlockEnd(lines[j], htmlType)) { j++; break; }
          j++;
        }
      } else {
        while (j < b && !isBlank(lines[j])) { html.push(lines[j]); j++; }
      }
      // The block's output ends with a newline unless the block is
      // followed by a blank line. A type 6 or 7 block inside a container
      // never ends with one (the container's lines were joined). A
      // lone-tab line is not a blank line after a type 1-5 block (it
      // leaves the trailing newline in place), matching marked.
      const followedByBlank = j < b && isBlank(lines[j]);
      const trailNl = htmlType >= 1 && htmlType <= 5
        ? !(followedByBlank && !isTabRow(lines[j]))
        : container === null && !followedByBlank;
      nodes.push({ t: 'html', text: html.join('\n'), trailNl });
      i = j;
      continue;
    }
    // Link reference definition.
    const def = parseDef(lines, i, b, refs);
    if (def) { i = def.next; continue; }
    // Table: this line is the header, the next is the delimiter row.
    if (i + 1 < b && !isBlank(lines[i + 1])) {
      const aligns = tableAligns(lines[i + 1]);
      if (aligns && (lines[i].includes('|') || lines[i + 1].includes('|'))) {
        const header = splitTableRow(lines[i]);
        // The delimiter row must hold as many cells as the header.
        if (aligns.length === header.length) {
          const rows = [];
          let j = i + 2;
          // Body rows are the lines up to the first blank line (a row needs
          // no pipes: a pipeless line is a single-cell row). A line that
          // starts another block ends the table. A lone-tab line is a row
          // of empty cells, not a blank line (isTabRow).
          while (j < b && (!isBlank(lines[j]) || isTabRow(lines[j])) && !isBlockStart(lines[j], 0)) {
            rows.push(splitTableRow(lines[j]));
            j++;
          }
          nodes.push({ t: 'table', aligns, header, rows });
          i = j;
          continue;
        }
      }
    }
    // Paragraph: consume lines until a blank line or an interrupting
    // construct; a setext underline turns it into a heading.
    const para = [];
    let j = i;
    let headingLevel = 0;
    while (j < b) {
      const l = lines[j];
      if (isBlank(l)) {
        // A whitespace-only line inside a blockquote (from '>  ') is
        // paragraph content while a paragraph is open; at the top level
        // (and when no paragraph is open) it is a blank line.
        if (container === 'quote' && l.length > 0 && para.length > 0) {
          para.push(l);
          j++;
          continue;
        }
        break;
      }
      const sl = setextLevel(l);
      if (sl !== 0 && para.length > 0) { headingLevel = sl; j++; break; }
      if (j > i) {
        const li = indentCols(l);
        // An indented line cannot interrupt a paragraph: it is a
        // continuation of it (the other checks below all need at most
        // three spaces of indent anyway).
        if (fenceStart(l)) break;
        if (atxHeading(l)) break;
        if (isHr(l)) break;
        if (li <= 3 && l.slice(li).startsWith('>')) break;
        const lm = parseItemMarker(l);
        // A list interrupts a paragraph only when its first item has
        // content on the marker line. An ordered list must start with 1
        // to interrupt a paragraph at the top level; inside a list item
        // (or quote) any ordered list starts a nested block.
        if (lm && li <= 3 && lm.content.trim() !== '' && !(container === null && lm.kind.startsWith('ordered') && lm.num !== 1)) break;
        const ht = htmlBlockType(l);
        if (ht >= 1 && ht <= 6) break;
        if (i + 1 < b && j + 1 < b && tableAligns(lines[j + 1]) && (l.includes('|') || lines[j + 1].includes('|'))) break;
      }
      // A paragraph continuation line with four or more columns of indent
      // loses four of them when it is a lazy line, or when this paragraph
      // sits inside a list item. (A top-level line, or one inside a
      // blockquote, keeps its spaces.)
      let text = l;
      if (j > i && ((lazySet && lazySet.has(j)) || container === 'list') && indentCols(l) >= 4) {
        text = stripIndent(l, 4, false, baseCol);
      }
      para.push(text);
      j++;
    }
    if (headingLevel !== 0) {
      // A setext heading's text is the paragraph text with leading and
      // trailing spaces/tabs removed.
      nodes.push({ t: 'h', level: headingLevel, text: para.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') });
    } else {
      nodes.push({ t: 'para', text: para.join('\n') });
    }
    i = j;
  }
  return { nodes, blank: blankBetween };
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

function renderBlocks(nodes, refs) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'para') {
      out += '<p>' + inlineHtml(node.text, refs) + '</p>\n';
    } else if (node.t === 'h') {
      out += '<h' + node.level + '>' + inlineHtml(node.text, refs) + '</h' + node.level + '>\n';
    } else if (node.t === 'code') {
      out += '<pre><code' + (node.lang ? ' class="language-' + escText(node.lang) + '"' : '') + '>';
      out += escCode(node.text) + '</code></pre>\n';
    } else if (node.t === 'hr') {
      out += '<hr>\n';
    } else if (node.t === 'quote') {
      out += '<blockquote>\n' + renderBlocks(node.children, refs) + '</blockquote>\n';
    } else if (node.t === 'list') {
      out += node.ordered ? '<ol' + (node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n' : '<ul>\n';
      for (const item of node.items) {
        let task = null;
        let children = item.children;
        if (children.length > 0 && children[0].t === 'para') {
          const m = /^\[( |x|X)\] /.exec(children[0].text);
          if (m) {
            task = m[1] !== ' ';
            children = children.slice();
            children[0] = { t: 'para', text: children[0].text.slice(4) };
          }
        }
        out += '<li>';
        if (task !== null && !node.tight) {
          // In a loose list the checkbox sits inside the first paragraph.
          out += '<p>' + (task
            ? '<input checked="" disabled="" type="checkbox"> '
            : '<input disabled="" type="checkbox"> ') + inlineHtml(children[0].text, refs) + '</p>\n';
          out += renderBlocks(children.slice(1), refs);
        } else {
          if (task !== null) {
            out += task
              ? '<input checked="" disabled="" type="checkbox"> '
              : '<input disabled="" type="checkbox"> ';
          }
          if (node.tight) {
            // In a tight list the paragraph children render as bare inline
            // HTML, with no separators between the item's blocks.
            for (let ci = 0; ci < children.length; ci++) {
              const child = children[ci];
              if (child.t === 'para') {
                out += inlineHtml(child.text, refs);
              } else {
                out += renderBlocks([child], refs);
              }
            }
          } else {
            out += renderBlocks(children, refs);
          }
        }
        out += '</li>\n';
      }
      out += node.ordered ? '</ol>\n' : '</ul>\n';
    } else if (node.t === 'html') {
      out += node.text + (node.trailNl ? '\n' : '');
    } else if (node.t === 'table') {
      out += '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < node.header.length; c++) {
        const align = node.aligns[c] || '';
        out += '<th' + (align ? ' align="' + align + '"' : '') + '>' + inlineHtml(node.header[c], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let c = 0; c < node.header.length; c++) {
            const align = node.aligns[c] || '';
            out += '<td' + (align ? ' align="' + align + '"' : '') + '>' + inlineHtml(row[c] || '', refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point. Normalizes line endings, splits into lines, parses blocks,
// renders them. The final output has no trailing blank line beyond the one
// each block contributes.
// ---------------------------------------------------------------------------

function parse(markdown) {
  if (typeof markdown !== 'string') markdown = String(markdown);
  const src = markdown.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  // A trailing newline makes the last element empty; that empty element
  // is not a blank line, so it is dropped (a real trailing blank line
  // leaves its own empty element behind).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const { nodes } = parseBlocks(lines, 0, lines.length, refs, null, null);
  // When the input does not end with a newline, the last HTML block in
  // the document (following the last-child chain) has no trailing
  // newline either.
  if (!src.endsWith('\n')) {
    let last = nodes.length ? nodes[nodes.length - 1] : null;
    while (last) {
      if (last.t === 'html') { last.trailNl = false; break; }
      if (last.t === 'quote' && last.children.length) { last = last.children[last.children.length - 1]; continue; }
      if (last.t === 'list' && last.items.length) {
        const item = last.items[last.items.length - 1];
        last = item.children.length ? item.children[item.children.length - 1] : null;
        continue;
      }
      break;
    }
  }
  return renderBlocks(nodes, refs);
}

module.exports = { parse };
