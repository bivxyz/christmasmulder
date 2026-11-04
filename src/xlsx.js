// Minimal .xlsx reader, zero dependencies. Works in Workers and Node 18+.
// Returns [{ name, rows: string[][], comments: [{ row, col, text }] }].
// Date-formatted cells come back as ISO yyyy-mm-dd; numbers as their raw text.

const dec = new TextDecoder();

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    files[name] = { method, data: u8.subarray(start, start + size) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => name in files,
    async text(name) {
      const f = files[name];
      if (!f) return null;
      return dec.decode(f.method === 0 ? f.data : await inflateRaw(f.data));
    },
  };
}

const unescape = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

const attr = (s, name) => (s.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
const texts = (s) => [...s.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => unescape(m[1])).join('');

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}
const rowIndex = (ref) => +ref.match(/\d+$/)[0] - 1;

function resolve(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) seg === '..' ? parts.pop() : parts.push(seg);
  return parts.join('/');
}

async function rels(zip, partPath) {
  const dir = partPath.split('/').slice(0, -1).join('/');
  const file = partPath.split('/').pop();
  const xml = await zip.text(`${dir}/_rels/${file}.rels`);
  const out = {};
  for (const m of (xml || '').matchAll(/<Relationship\s[^>]*>/g)) {
    out[attr(m[0], 'Id')] = { target: resolve(partPath, attr(m[0], 'Target')), type: attr(m[0], 'Type') };
  }
  return out;
}

function serialToIso(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  return d.toISOString().slice(0, 10);
}

export async function readXlsx(buf) {
  const zip = await unzip(buf);

  const shared = [];
  const sst = await zip.text('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(texts(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));

  const styles = (await zip.text('xl/styles.xml')) || '';
  const custom = {};
  for (const m of styles.matchAll(/<numFmt\s[^>]*>/g)) custom[+attr(m[0], 'numFmtId')] = unescape(attr(m[0], 'formatCode') || '');
  const xfs = (styles.match(/<cellXfs[\s\S]*?<\/cellXfs>/) || [''])[0];
  const isDateXf = [...xfs.matchAll(/<xf\s[^>]*?(?:\/>|>)/g)].map((m) => {
    const id = +(attr(m[0], 'numFmtId') || 0);
    const code = (custom[id] || '').split(';')[0].replace(/"[^"]*"|\[[^\]]*\]/g, '');
    return (id >= 14 && id <= 22) || /[dy]/i.test(code);
  });

  const wbPath = 'xl/workbook.xml';
  const wb = await zip.text(wbPath);
  const wbRels = await rels(zip, wbPath);
  const sheets = [];

  for (const m of wb.matchAll(/<sheet\s[^>]*>/g)) {
    const name = unescape(attr(m[0], 'name'));
    const path = wbRels[attr(m[0], 'r:id')].target;
    const xml = await zip.text(path);
    const rows = [];
    for (const c of xml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = c[1];
      const body = c[2] || '';
      const ref = attr(a, 'r');
      const t = attr(a, 't');
      let val;
      if (t === 'inlineStr') val = texts(body);
      else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/);
        if (!v) continue;
        val = unescape(v[1]);
        if (t === 's') val = shared[+val];
        else if (!t || t === 'n') {
          const n = +val;
          if (isDateXf[+(attr(a, 's') || 0)] && n > 10000) val = serialToIso(n);
        }
      }
      const r = rowIndex(ref);
      (rows[r] ||= [])[colIndex(ref)] = val;
    }
    for (let i = 0; i < rows.length; i++) rows[i] = Array.from(rows[i] || [], (v) => v ?? '');

    const comments = [];
    for (const rel of Object.values(await rels(zip, path))) {
      if (!/\/comments$/.test(rel.type)) continue;
      const cx = (await zip.text(rel.target)) || '';
      for (const cm of cx.matchAll(/<comment\s([^>]*)>([\s\S]*?)<\/comment>/g)) {
        let text = texts(cm[2]);
        // Google exports threaded comments with Excel boilerplate ahead of the real text
        if (text.startsWith('[Threaded comment]')) text = text.split(/\nComment:\n/).pop().split(/\nReply:\n/)[0];
        text = text.replace(/^\s+|\s+$/g, '');
        const ref = attr(cm[1], 'ref');
        if (text) comments.push({ row: rowIndex(ref), col: colIndex(ref), text });
      }
    }
    sheets.push({ name, rows, comments });
  }
  return sheets;
}
