/**
 * Finds the redaction boxes printed on each page of the report and says, line by line, what the
 * PDF's text layer holds where each box is. Writes reference/redactions.json.gz, which
 * `redactionBoxes()` in redactions.ts applies to the text layer during ingest.
 *
 * Usage (from the report repo): node scripts/redaction-boxes.ts [--pages 51,52] [--dpi 100] [--out path]
 *
 * Why: the declassified report prints each redaction as a solid black box. The scan's OCR reads a
 * box as garble ("H ^ H", "B I H I H", "|") or as nothing at all ("November         2002"), so the
 * text layer alone cannot say where a redaction is. The page image can: a box is a solid dark
 * rectangle, thicker than any stroke of type. This script
 *
 *   1. renders each page in grey (`pdftoppm -gray`, PGM), opens it with a 5x5 square (so type,
 *      rules and strikethroughs, all thinner than 5 px at 100 dpi, vanish), and takes each remaining
 *      dark component whose bounding box is at least 85% filled and at least 9 px tall as a box;
 *   2. reads each word's position from `pdftotext -bbox-layout`, and pairs those words with the
 *      tokens of `pdftotext -layout` (what the pipeline reads), in order;
 *   3. for each line of the -layout text, replaces the characters that sit inside a box with one
 *      redaction mark per box, and puts a mark where a box sits on the line with no characters;
 *      a box on a row with no text at all becomes a line of its own.
 *
 * The output is deterministic for a given PDF, poppler version and dpi, and records all three. Each
 * edit holds the line as the text layer reads it (`from`), so a poppler that reads a line
 * differently makes the edit miss (counted by the pass), never land on the wrong text.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

export const MARK = "█"; // █ FULL BLOCK

const repo = join(import.meta.dirname, "..");
const pdf = join(repo, "archive/CRPT-113srpt288.pdf");

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DPI = Number(opt("--dpi") ?? 100);
const OUT = opt("--out") ?? join(repo, "reference/redactions.json.gz");
const ONLY = opt("--pages")?.split(",").map(Number);

const OPEN = 5; // the opening's square, px
const MIN_H = 9; // px at 100 dpi: about 6.5 pt, taller than any stroke of type
const MIN_W = 6;
const MIN_FILL = 0.85;
const DARK = 96; // grey level below which a pixel is ink

type Box = { x0: number; y0: number; x1: number; y1: number }; // px, inclusive-exclusive
type Word = { x0: number; y0: number; x1: number; y1: number; text: string };

function render(page: number): { w: number; h: number; px: Uint8Array } {
  const buf = execFileSync("pdftoppm", ["-f", String(page), "-l", String(page), "-r", String(DPI), "-gray", pdf], {
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  // P5\n<w> <h>\n<max>\n<bytes>; tolerate comments
  let pos = 0;
  const fields: string[] = [];
  while (fields.length < 4) {
    while (buf[pos] === 0x20 || buf[pos] === 0x0a || buf[pos] === 0x0d || buf[pos] === 0x09) pos++;
    if (buf[pos] === 0x23) {
      while (buf[pos] !== 0x0a) pos++;
      continue;
    }
    let s = "";
    while (buf[pos] !== 0x20 && buf[pos] !== 0x0a && buf[pos] !== 0x0d && buf[pos] !== 0x09) s += String.fromCharCode(buf[pos++]);
    fields.push(s);
  }
  pos++; // the single whitespace after maxval
  if (fields[0] !== "P5") throw new Error(`page ${page}: not a PGM (${fields[0]})`);
  const w = Number(fields[1]);
  const h = Number(fields[2]);
  return { w, h, px: new Uint8Array(buf.buffer, buf.byteOffset + pos, w * h) };
}

/** Sum over every k x k window, by an integral image. */
function windowCount(mask: Uint8Array, w: number, h: number, k: number): Int32Array {
  const I = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x];
      I[(y + 1) * (w + 1) + (x + 1)] = I[y * (w + 1) + (x + 1)] + row;
    }
  }
  // out[y*w+x] = count in the window whose top-left is (x, y)
  const out = new Int32Array(w * h);
  for (let y = 0; y + k <= h; y++)
    for (let x = 0; x + k <= w; x++)
      out[y * w + x] = I[(y + k) * (w + 1) + (x + k)] - I[y * (w + 1) + (x + k)] - I[(y + k) * (w + 1) + x] + I[y * (w + 1) + x];
  return out;
}

function boxesOn(page: number): Box[] {
  const { w, h, px } = render(page);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = px[i] < DARK ? 1 : 0;
  const k = OPEN;
  // erosion: a window entirely dark marks its top-left
  const full = windowCount(dark, w, h, k);
  const eroded = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) eroded[i] = full[i] === k * k ? 1 : 0;
  // dilation: a pixel is kept if any window covering it was entirely dark
  const any = windowCount(eroded, w, h, k);
  const opened = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const y0 = Math.max(0, y - k + 1);
      const x0 = Math.max(0, x - k + 1);
      // kept if any eroded top-left lies in [x-k+1..x] x [y-k+1..y]: exactly the window at (x0, y0)
      opened[y * w + x] = dark[y * w + x] && any[y0 * w + x0] > 0 ? 1 : 0;
    }
  // Rectangles: each row's dark runs, stacked onto the run above when both ends agree within 2 px.
  // (Not connected components: two boxes on consecutive lines often touch, and their union is no
  // rectangle.)
  type Open = { x0: number; x1: number; y0: number; y1: number };
  let open: Open[] = [];
  const boxes: Box[] = [];
  const close = (r: Open) => {
    if (r.y1 - r.y0 >= MIN_H * (DPI / 100) && r.x1 - r.x0 >= MIN_W * (DPI / 100)) boxes.push({ ...r });
  };
  for (let y = 0; y <= h; y++) {
    const runs: Array<[number, number]> = [];
    if (y < h) {
      let x = 0;
      while (x < w) {
        if (!opened[y * w + x]) {
          x++;
          continue;
        }
        const x0 = x;
        while (x < w && opened[y * w + x]) x++;
        if (x - x0 >= MIN_W * (DPI / 100)) runs.push([x0, x]);
      }
    }
    const next: Open[] = [];
    for (const [x0, x1] of runs) {
      const i = open.findIndex((r) => Math.abs(r.x0 - x0) <= 2 && Math.abs(r.x1 - x1) <= 2);
      if (i >= 0) {
        const r = open.splice(i, 1)[0];
        next.push({ x0: Math.min(r.x0, x0), x1: Math.max(r.x1, x1), y0: r.y0, y1: y + 1 });
      } else next.push({ x0, x1, y0: y, y1: y + 1 });
    }
    open.forEach(close);
    open = next;
  }
  void MIN_FILL;
  return boxes;
}

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function wordsOn(page: number): Word[] {
  const html = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", "-f", String(page), "-l", String(page), pdf, "-"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const s = DPI / 72;
  const out: Word[] = [];
  for (const m of html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g))
    out.push({ x0: Number(m[1]) * s, y0: Number(m[2]) * s, x1: Number(m[3]) * s, y1: Number(m[4]) * s, text: decode(m[5]) });
  return out;
}

type Token = { line: number; start: number; end: number; text: string; word?: Word };

/** Pairs the -layout tokens with the -bbox words: longest common subsequence on their text. */
function pair(tokens: Token[], words: Word[]) {
  const n = tokens.length;
  const m = words.length;
  // Most pages pair one to one in order; check that first.
  if (n === m && tokens.every((t, i) => t.text === words[i].text)) {
    tokens.forEach((t, i) => (t.word = words[i]));
    return;
  }
  const L = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i * (m + 1) + j] = tokens[i].text === words[j].text ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (tokens[i].text === words[j].text) {
      tokens[i].word = words[j];
      i++;
      j++;
    } else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) i++;
    else j++;
  }
}

/**
 * A token paired with a word on another row was paired with the wrong copy of the same text (a page
 * has many "|" and "^"): unpair it, then pair each unpaired token with an unused word of the same
 * text on its own line's row, nearest to where its neighbours put it.
 */
function repairPairs(tokens: Token[], words: Word[]) {
  const mid = (w: Word) => (w.y0 + w.y1) / 2;
  const rows = new Map<number, number>();
  for (const line of new Set(tokens.map((t) => t.line))) {
    const ys = tokens.filter((t) => t.line === line && t.word).map((t) => mid(t.word!));
    if (ys.length) rows.set(line, median(ys));
  }
  for (const t of tokens) if (t.word && rows.has(t.line) && Math.abs(mid(t.word) - rows.get(t.line)!) > 4) t.word = undefined;
  const used = new Set(tokens.filter((t) => t.word).map((t) => t.word!));
  // A line none of whose tokens paired (its words come elsewhere in the bbox reading order): pair it
  // whole where exactly one row of unused words holds all its tokens.
  for (const line of new Set(tokens.map((t) => t.line))) {
    if (rows.has(line)) continue;
    const own = tokens.filter((t) => t.line === line);
    const fits = words
      .filter((w) => !used.has(w) && w.text === own[0].text)
      .map((first) => {
        const taken = new Set<Word>();
        const got = own.map((t) => {
          const w = words.find((w) => !used.has(w) && !taken.has(w) && w.text === t.text && Math.abs(mid(w) - mid(first)) <= 4);
          if (w) taken.add(w);
          return w;
        });
        return got.every(Boolean) ? got : undefined;
      })
      .filter(Boolean) as Word[][];
    if (fits.length !== 1) continue;
    own.forEach((t, i) => {
      t.word = fits[0][i];
      used.add(fits[0][i]);
    });
    rows.set(line, mid(fits[0][0]));
  }
  tokens.forEach((t, i) => {
    if (t.word || !rows.has(t.line)) return;
    const y = rows.get(t.line)!;
    const left = tokens.slice(0, i).reverse().find((u) => u.line === t.line && u.word)?.word;
    const right = tokens.slice(i + 1).find((u) => u.line === t.line && u.word)?.word;
    const lo = left ? left.x1 - 1 : -Infinity;
    const hi = right ? right.x0 + 1 : Infinity;
    const cand = words.filter((w) => !used.has(w) && w.text === t.text && Math.abs(mid(w) - y) <= 4 && w.x0 >= lo && w.x1 <= hi);
    if (cand.length === 1) {
      t.word = cand[0];
      used.add(cand[0]);
    }
  });
}

const overlapsY = (a: { y0: number; y1: number }, b: { y0: number; y1: number }) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);

/** `to: null` drops the line. `kinds` says why it changed: redaction, portion, banner, counter, slug. */
type Edit = { line: number; from: string; to: string | null; kinds: string[] };
type Insert = { after: number; text: string };
type PageRecord = { page: number; boxes: number[][]; edits: Edit[]; inserts: Insert[]; unpaired: number };

function processPage(page: number, lines: string[]): PageRecord {
  const boxes = boxesOn(page);
  const rec: PageRecord = { page, boxes: boxes.map((b) => [b.x0, b.y0, b.x1, b.y1].map((v) => Math.round((v * 72 * 10) / DPI) / 10)), edits: [], inserts: [], unpaired: 0 };
  const tokens: Token[] = [];
  lines.forEach((text, line) => {
    for (const m of text.matchAll(/\S+/g)) tokens.push({ line, start: m.index!, end: m.index! + m[0].length, text: m[0] });
  });
  const words = wordsOn(page);
  pair(tokens, words);
  repairPairs(tokens, words);
  rec.unpaired = tokens.filter((t) => !t.word).length;
  // The vertical extent of each -layout line, from its paired words.
  const lineY = new Map<number, { y0: number; y1: number }>();
  for (const t of tokens) {
    if (!t.word) continue;
    const r = lineY.get(t.line);
    lineY.set(t.line, r ? { y0: Math.min(r.y0, t.word.y0), y1: Math.max(r.y1, t.word.y1) } : { y0: t.word.y0, y1: t.word.y1 });
  }
  const marginPt = (leftMargin(tokens) * 72) / DPI;
  const portionGaps = new Set<number>();
  // Each character of each line: which box covers it, if any.
  const covered = new Map<number, (number | undefined)[]>();
  const placed = new Set<number>();
  for (const t of tokens) {
    const wd = t.word;
    if (!wd) continue;
    const len = t.end - t.start;
    const cw = (wd.x1 - wd.x0) / len;
    boxes.forEach((b, bi) => {
      const oy = overlapsY(wd, b);
      if (oy < 0.5 * Math.min(wd.y1 - wd.y0, b.y1 - b.y0)) return;
      for (let c = 0; c < len; c++) {
        const cx = wd.x0 + (c + 0.5) * cw;
        if (cx >= b.x0 && cx <= b.x1) {
          const row = covered.get(t.line) ?? new Array(lines[t.line].length).fill(undefined);
          row[t.start + c] = bi;
          covered.set(t.line, row);
          placed.add(bi);
        }
      }
    });
  }
  // Boxes no character sits in: on a line (between two words), or on a row of their own.
  const rows: Array<{ after: number; y: number; indent: number }> = [];
  const gaps = new Map<number, Array<{ at: number; box: number }>>();
  boxes.forEach((b, bi) => {
    if (placed.has(bi)) return;
    const cy = (b.y0 + b.y1) / 2;
    let best: number | undefined;
    for (const [line, r] of lineY) if (cy >= r.y0 - 1 && cy <= r.y1 + 1 && (best === undefined || Math.abs((r.y0 + r.y1) / 2 - cy) < Math.abs((lineY.get(best)!.y0 + lineY.get(best)!.y1) / 2 - cy))) best = line;
    if (best !== undefined) {
      // the character position: after the last token that ends left of the box
      const onLine = tokens.filter((t) => t.line === best && t.word);
      const before = onLine.filter((t) => t.word!.x1 <= b.x0 + 1).pop();
      const after = onLine.find((t) => t.word!.x0 >= b.x1 - 1);
      const at = before ? before.end : after ? after.start : lines[best].length;
      // A box opening the line a little in from the margin, with nothing read before it, is a
      // portion marking whose struck-through "(TS//" and "//NF)" the OCR lost: "(TS//█//NF)".
      const xPt = (b.x0 * 72) / DPI;
      if (!before && xPt > marginPt + 10 && xPt < marginPt + 45) portionGaps.add(best);
      gaps.set(best, [...(gaps.get(best) ?? []), { at, box: bi }]);
      placed.add(bi);
      return;
    }
    // A row of its own: after the last line above it that has text.
    let above = -1;
    for (const [line, r] of lineY) if (r.y1 <= cy && line > above) above = line;
    const charW = median(tokens.filter((t) => t.word).map((t) => (t.word!.x1 - t.word!.x0) / (t.end - t.start))) || 6;
    const indent = Math.max(0, Math.round(b.x0 / charW) - Math.round(leftMargin(tokens) / charW));
    rows.push({ after: above, y: cy, indent });
    placed.add(bi);
  });
  // Boxes on a row of their own: one inserted line per row (centres within 4 px), marks in x order.
  rows.sort((a, b) => a.after - b.after || a.y - b.y || a.indent - b.indent);
  for (let i = 0; i < rows.length; ) {
    let j = i;
    let line = "";
    while (j < rows.length && rows[j].after === rows[i].after && Math.abs(rows[j].y - rows[i].y) <= 4) {
      const pad = Math.max(line ? 1 : 0, rows[j].indent - line.length);
      line += " ".repeat(pad) + MARK;
      j++;
    }
    rec.inserts.push({ after: rows[i].after, text: line });
    i = j;
  }
  // Rewrite each touched line.
  const text = new Map<number, string>();
  const kinds = new Map<number, Set<string>>();
  const why = (line: number, kind: string) => kinds.set(line, (kinds.get(line) ?? new Set()).add(kind));
  const touched = new Set([...covered.keys(), ...gaps.keys()]);
  for (const line of [...touched].sort((a, b) => a - b)) {
    const from = lines[line];
    const row = covered.get(line) ?? [];
    const ins = (gaps.get(line) ?? []).sort((a, b) => a.at - b.at);
    let out = "";
    let prevBox: number | undefined;
    for (let c = 0; c <= from.length; c++) {
      for (const g of ins) if (g.at === c) out += (out && !out.endsWith(" ") ? " " : "") + MARK + (c < from.length && from[c] !== " " ? " " : "");
      if (c === from.length) break;
      const bi = row[c];
      if (bi !== undefined) {
        if (bi !== prevBox) out += MARK;
        prevBox = bi;
        continue;
      }
      // spaces between two characters of the same box are the box's own
      if (prevBox !== undefined && from[c] === " ") {
        let d = c;
        while (d < from.length && from[d] === " ") d++;
        if (row[d] === prevBox) {
          c = d - 1;
          continue;
        }
      }
      prevBox = undefined;
      out += from[c];
    }
    out = absorbJunk(out);
    if (out !== from) {
      text.set(line, out);
      why(line, "redaction");
    }
  }
  const current = (line: number) => text.get(line) ?? lines[line];

  // Portion markings: "(U)", "(S//NF)", "(TS//█//NF)" opening a paragraph. Classification control
  // markings, all struck through on declassification; the redacted ones read as garble.
  lines.forEach((_, line) => {
    const t = current(line);
    const m = /^(\s*)\(([^()]{0,45})\)\s+(?=\S)/.exec(t);
    if (m && isPortion(m[2])) {
      text.set(line, m[1] + t.slice(m[0].length));
      why(line, "portion");
    } else if (portionGaps.has(line)) {
      const g = new RegExp(`^(\\s*)${MARK}\\s+(?=[A-Z"'\u201c])`).exec(t);
      if (g) {
        text.set(line, g[1] + t.slice(g[0].length));
        why(line, "portion");
      }
    }
  });

  // Furniture: the classification banners at the head and foot of each page, a section's own "Page
  // N of M" or bare page number above the GPO folio, and the GPO's typesetting slugs.
  const pt = (px: number) => (px * 72) / DPI;
  const yMid = (line: number) => {
    const r = lineY.get(line);
    return r ? pt((r.y0 + r.y1) / 2) : undefined;
  };
  // Narrow bands for garble beside a banner; wide ones for a line that reads as a banner itself (the
  // views' pages set theirs lower: "SECRET" under "UNCLASSIFIED", PDF p.541).
  const band = (line: number, wide = false) => {
    const y = yMid(line);
    const [top, bottom] = wide ? [TOP_BAND + 20, BOTTOM_BAND - 6] : [TOP_BAND, BOTTOM_BAND];
    return y === undefined ? undefined : y < top ? "top" : y > bottom ? "bottom" : undefined;
  };
  const textLines = [...lineY.keys()].sort((a, b) => a - b);
  const lowest = textLines.length ? textLines.reduce((a, b) => (yMid(b)! > yMid(a)! ? b : a)) : -1;
  const drop = new Set<number>();
  const banners: number[] = [];
  lines.forEach((_, line) => {
    if (SLUG.test(current(line))) {
      drop.add(line);
      why(line, "slug");
    }
  });
  // The letter of transmittal's letterhead (PDF p.2): the committee's members in two columns beside
  // the Senate's name, which the OCR read as scrambled letters ("RON W YD E.N.M O REG O N"). Everything
  // above the letter's date goes; PROCESSING.md says so.
  if (page === 2) {
    const date = lines.findIndex((l) => /^\s*December 9,\s?2014\s*$/.test(l));
    for (let line = 0; line < date; line++)
      if (lines[line].trim()) {
        drop.add(line);
        why(line, "letterhead");
      }
  }
  for (const line of textLines) {
    const t = current(line);
    if (drop.has(line)) continue;
    if (!band(line, true)) continue;
    if (/^\s*Page \d+ of \d+\s*$/.test(t) || (band(line) === "bottom" && /^\s*-\s?\d{1,3}\s?-\s*$/.test(t))) {
      drop.add(line);
      why(line, "counter");
      banners.push(line);
    } else if (isBanner(t)) {
      drop.add(line);
      why(line, "banner");
      banners.push(line);
    }
  }
  for (const line of textLines) {
    if (drop.has(line) || !band(line)) continue;
    const t = current(line).trim();
    const near = banners.some((b) => Math.abs(yMid(b)! - yMid(line)!) <= 28);
    if (line === lowest && /^\(?[0-9ivxlcdmIVXLCDM]{1,5}\)?$|^in$/.test(t)) continue; // the GPO folio
    if (band(line) === "bottom" && /^[0-9]{1,3}$|^[ivxlcIVXLC]{1,6}$/.test(t) && line !== lowest) {
      drop.add(line);
      why(line, "counter");
    } else if (near && wordlike(t) === 0 && !/\d{4}/.test(t)) {
      drop.add(line);
      why(line, "banner");
    }
  }
  for (const line of [...kinds.keys()].sort((a, b) => a - b))
    rec.edits.push({ line, from: lines[line], to: drop.has(line) ? null : current(line), kinds: [...kinds.get(line)!] });
  return rec;
}

const TOP_BAND = 74; // pt from the top of the page
const BOTTOM_BAND = 686;
const SLUG = /VerDate \w+ \d+ \d{4}|\bon DSK\w+PROD with REPORTS\b/;

/** Words of prose: a letter, then two or more lower-case letters. */
const wordlike = (t: string) => t.split(/\s+/).filter((w) => /^["'(\[]?[A-Za-z][a-z]{2,}[.,;:)\]'"]*$/.test(w)).length;

/** Edit distance from `target` to its best match anywhere in `s`. */
function fuzzyIn(target: string, s: string): number {
  let prev = new Array(s.length + 1).fill(0);
  for (let i = 1; i <= target.length; i++) {
    const cur = [i];
    for (let j = 1; j <= s.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (target[i - 1] === s[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.min(...prev);
}

/** A classification banner, struck through and partly redacted: UNCLASSIFIED, TOP SECRET//█//NOFORN. */
function isBanner(t: string): boolean {
  const letters = t.toUpperCase().replace(/[^A-Z]/g, "");
  if (wordlike(t) >= 3) return false;
  return fuzzyIn("UNCLASSIFIED", letters) <= 4 || fuzzyIn("NOFORN", letters) <= 2 || fuzzyIn("SECRET", letters) <= 1 || /^TOP/.test(letters) && letters.length <= 12;
}

/** The inside of a portion marking: U, C, S, S//NF, S//OC/NF, or TS// with its redaction. */
function isPortion(inner: string): boolean {
  const d = inner.replace(/\s+/g, "");
  if (/^(U|C|S|TS)$/.test(d)) return true;
  if (/^S\/\/[A-Z/]{1,12}$/.test(d)) return true;
  if (/^T[S&]/.test(d) && !/[a-z]{3}/.test(d) && /[\/^|█]/.test(d) && d.length <= 30) return true;
  // the marking's middle redacted, its struck-through letters misread: "( █ )", "( ^ S █ i 1 )"
  return d.includes(MARK) && d.length <= 30 && new RegExp(`^[A-Z0-9/\\\\|^${MARK}&'!;:.,~\\-ilyVvZz]+$`).test(d);
}

/**
 * A token of nothing but carets and bars beside a mark is the box's own edge, read as glyphs (the OCR
 * never prints a caret or a bar as text in this report): it goes into the mark.
 */
function absorbJunk(line: string): string {
  const junk = "[\\^|]+";
  let prev;
  do {
    prev = line;
    line = line.replace(new RegExp(`${MARK}( +)${junk}(?=\\s|$)`, "g"), MARK).replace(new RegExp(`(^|\\s)${junk} +${MARK}`, "g"), `$1${MARK}`);
  } while (line !== prev);
  return line;
}

function popplerVersion(): string {
  // pdftotext -v prints to stderr
  const r = spawnSync("pdftotext", ["-v"], { encoding: "utf8" });
  return (r.stderr || r.stdout).split("\n")[0].trim();
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function leftMargin(tokens: Token[]): number {
  const firsts = new Map<number, Token>();
  for (const t of tokens) if (t.word && !firsts.has(t.line)) firsts.set(t.line, t);
  const xs = [...firsts.values()].map((t) => t.word!.x0 - t.start * ((t.word!.x1 - t.word!.x0) / (t.end - t.start)));
  return median(xs);
}

function main() {
  const raw = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", pdf, "-"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  // as @rtm/ingest's extractPages: split on form feeds; C0 controls become spaces
  const pages = raw.split("\f").map((p) => p.split("\n").map((l) => l.replace(/[\u0000-\u0008\u000b\u000d-\u001f]/g, " ")));
  const records: PageRecord[] = [];
  const total = pages.length - (pages[pages.length - 1].every((l) => !l.trim()) ? 1 : 0);
  for (let p = 1; p <= total; p++) {
    if (ONLY && !ONLY.includes(p)) continue;
    const rec = processPage(p, pages[p - 1]);
    if (rec.boxes.length || rec.edits.length || rec.inserts.length) records.push(rec);
    if (p % 50 === 0) process.stderr.write(`page ${p}/${total}\n`);
  }
  const pack = {
    pdf: "archive/CRPT-113srpt288.pdf",
    sha256: createHash("sha256").update(readFileSync(pdf)).digest("hex"),
    poppler: popplerVersion(),
    dpi: DPI,
    params: { open: OPEN, minHeight: MIN_H, minWidth: MIN_W, minFill: MIN_FILL, dark: DARK },
    mark: MARK,
    pages: records,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  const json = JSON.stringify(pack);
  writeFileSync(OUT, OUT.endsWith(".gz") ? gzipSync(json, { level: 9 }) : json);
  const boxes = records.reduce((n, r) => n + r.boxes.length, 0);
  const edits = records.reduce((n, r) => n + r.edits.length, 0);
  const inserts = records.reduce((n, r) => n + r.inserts.length, 0);
  const unpaired = records.reduce((n, r) => n + r.unpaired, 0);
  process.stderr.write(`${records.length} pages with boxes, ${boxes} boxes, ${edits} lines edited, ${inserts} lines inserted, ${unpaired} tokens unpaired → ${OUT}\n`);
}

main();
