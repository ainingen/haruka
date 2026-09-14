/**
 * PLiCy に上げる ZIP を作る（開発用。配布物に含めない）。
 *
 *   node tools/pack-plicy.mjs            確認だけ（中身と大きさを出す）
 *   node tools/pack-plicy.mjs --write    dist/haruka.zip を書き出す
 *
 * 入れるのは**ブラウザがそのまま開くものだけ**（index.html / src/ui / src/engine / data / assets）。
 * tools と docs、テスト、README は入れない。
 *
 * あわせて歯止めを見る：
 *   - index.html が入っていて、**body の最初の要素が canvas**（PLiCy はそこからサムネイルを撮る）
 *   - 画面が読むファイルが欠けていない（相対パスの拾い漏れ）
 *
 * ZIP は Node だけで書く（npm 依存を足さない）。格納は deflate、無理なら無圧縮。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 入れるもの。ディレクトリはこの下をぜんぶ（除外に当たるものを除く）。 */
export const INCLUDE = ['index.html', 'src/ui', 'src/engine', 'data', 'assets'];
/** 入れないもの。テストと、配布に要らないもの。 */
export const EXCLUDE = [/\.test\.js$/, /(^|[\\/])\./, /(^|[\\/])README\.md$/, /\.map$/];

/** そのパスを入れるか。 */
const skip = (rel) => EXCLUDE.some((re) => re.test(rel));

/** 入れるファイルを集める（リポジトリからの相対パス、'/' 区切り）。 */
export function collect(root = ROOT) {
  const out = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(`${rel}/${name}`);
      return;
    }
    if (!skip(rel)) out.push(rel);
  };
  for (const entry of INCLUDE) {
    try { walk(entry); } catch { /* 無いものは飛ばす（assets/title は絵が来るまで空） */ }
  }
  return out.map((p) => p.split(sep).join('/'));
}

// ---------------------------------------------------------------------------
// ZIP（格納だけ。npm 依存を足さないので自分で書く）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32（ZIP のチェック用）。 */
export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** ZIP を1つ作る。files は { name, data } の配列。 */
export function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = file.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // 展開に要る版
    local.writeUInt16LE(0x0800, 6);        // 名前は UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // 時刻（固定。中身が同じなら同じ ZIP になる）
    local.writeUInt16LE(0x21, 12);         // 日付（1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0x21, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(0, 38);             // 外部属性
    head.writeUInt32LE(offset, 42);
    central.push(head, name);

    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dir, end]);
}

// ---------------------------------------------------------------------------
// 歯止め
// ---------------------------------------------------------------------------

/** body の最初の要素。タグ名と id を返す（PLiCy のサムネイル用に canvas であること）。 */
export function firstBodyElement(html) {
  const body = html.slice(html.search(/<body[^>]*>/i));
  const m = body.replace(/<body[^>]*>/i, '').match(/<([a-zA-Z][\w-]*)([^>]*)>/);
  if (!m) return null;
  const id = m[2].match(/\bid\s*=\s*["']([^"']+)["']/);
  return { tag: m[1].toLowerCase(), id: id ? id[1] : '' };
}

/**
 * ZIP に入れるものの取りこぼしを見る。問題の一覧を返す（空なら通った）。
 *
 * 見るのは**確実に読み込みだと分かるものだけ**：
 *   - ES Modules の import（ファイルからの相対）
 *   - HTML の src= / href=（ページからの相対）
 * `json('../../data/…')` のような自前の読み込みは、書き方が画面ごとに違うので見ない
 * （欠けていれば画面が「読み込みに失敗しました」を出す）。
 */
export function check(files, root = ROOT) {
  const problems = [];
  if (!files.includes('index.html')) problems.push('index.html が入っていない');
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const first = firstBodyElement(html);
  if (first?.tag !== 'canvas') {
    problems.push(`body の最初の要素が canvas でない（${first?.tag ?? '無し'}）。PLiCy のサムネイルが撮れない`);
  }

  const set = new Set(files);
  /** rel から見た ref を、リポジトリからの相対パスに直す。 */
  const resolve = (rel, ref) => {
    const dir = rel.split('/').slice(0, -1);
    const path = [];
    for (const part of [...(ref.startsWith('/') ? [] : dir), ...ref.split('/')]) {
      if (part === '.' || part === '') continue;
      if (part === '..') path.pop();
      else path.push(part);
    }
    return path.join('/');
  };
  const look = (rel, ref) => {
    if (!ref || ref.includes('${') || /^(https?:|data:|#|mailto:)/.test(ref)) {
      if (/^https?:/.test(ref ?? '')) problems.push(`${rel} が外を読んでいる：${ref}`);
      return;
    }
    const target = resolve(rel, ref.split(/[?#]/)[0]);
    if (!set.has(target)) problems.push(`${rel} が読む ${ref} が ZIP に無い（${target}）`);
  };

  for (const rel of files.filter((f) => /\.(html|js)$/.test(f))) {
    const text = readFileSync(join(root, rel), 'utf8');
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) look(rel, m[1]);
    for (const m of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) look(rel, m[1]);
    if (rel.endsWith('.html')) {
      for (const m of text.matchAll(/<(?:script|link|img)[^>]*?(?:src|href)\s*=\s*["']([^"']+)["']/g)) look(rel, m[1]);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();

function main() {
const files = collect();
const entries = files.map((name) => ({ name, data: readFileSync(join(ROOT, name)) }));
const problems = check(files);
const total = entries.reduce((n, f) => n + f.data.length, 0);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`入れるもの ${files.length} 件、元の大きさ ${kb(total)}`);
const byTop = {};
for (const f of entries) {
  const top = f.name.includes('/') ? f.name.split('/').slice(0, 2).join('/') : f.name;
  byTop[top] = (byTop[top] ?? 0) + f.data.length;
}
for (const [top, size] of Object.entries(byTop)) console.log(`  ${top.padEnd(16)} ${kb(size)}`);

const first = firstBodyElement(readFileSync(join(ROOT, 'index.html'), 'utf8'));
console.log(`index.html の body の最初の要素：<${first?.tag}${first?.id ? ` id="${first.id}"` : ''}>`);
// タイトルの絵は src/ui/title.js の TITLE.image が指すもの。無くても壊れないが、報せる
const titleImage = readFileSync(join(ROOT, 'src', 'ui', 'title.js'), 'utf8')
  .match(/image: *'([^']+)'/)?.[1];
if (titleImage && !files.includes(titleImage)) {
  console.log(`※ ${titleImage} が無い。タイトルは地色と題だけで出る（壊れはしない）`);
}
if (problems.length) {
  console.error('\n問題:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log('歯止め：通った');
}

if (process.argv.includes('--write')) {
  const buf = zip(entries);
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const out = join(ROOT, 'dist', 'haruka.zip');
  writeFileSync(out, buf);
  console.log(`\n${relative(ROOT, out)} を書き出した：${kb(buf.length)}`);
}
}
