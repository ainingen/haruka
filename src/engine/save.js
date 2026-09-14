/**
 * ゲームの進行（state）のシリアライズ。docs/設計/経済とシーズン.md「セーブ」。
 *
 * ブラウザストレージは使えない前提なので、画面間は URL の `s=` パラメータ1つで持ち回る。
 * **形式を触るのはこのファイルだけ。** 将来 PLiCy のセーブ機能に置き換えるときも、
 * encode / decode の中身を差し替えるだけで画面側は変わらない。
 *
 * 中身は短いキーの JSON を base64url にしたもの。長くなるようなら圧縮はここだけ変えればいい。
 * I/O は持たない（URL を読むのは画面側）。
 */

export const SAVE_VERSION = 1;

/** 長いキー → 短いキー。両方向で使う。 */
const KEYS = {
  v: 'v', money: 'm', cls: 'c', tier: 't', owned: 'o', cond: 'd', setup: 's',
  season: 'z', sponsor: 'p',
  // setup
  race: 'r', quali: 'q', parts: 'P', settings: 'S',
  // season
  year: 'y', rounds: 'R', next: 'n', points: 'K', symptoms: 'Y', note: 'N', rivalSeed: 'V',
  course: 'C', laps: 'L', result: 'E',
  // result
  pos: 'a', prize: 'b', fee: 'f', sponsorFee: 'g', repair: 'h', retired: 'i', best: 'j',
  // sponsor
  id: 'I',
};
const SHORT = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [v, k]));

function mapKeys(value, table) {
  if (Array.isArray(value)) return value.map((v) => mapKeys(v, table));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[table[k] ?? k] = mapKeys(v, table);
    return out;
  }
  return value;
}

/** UTF-8 → base64url。Node でもブラウザでも動く。 */
function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** state → URL に載せられる文字列。 */
export function encode(state) {
  return toBase64Url(JSON.stringify(mapKeys({ ...state, v: SAVE_VERSION }, KEYS)));
}

/** 文字列 → state。壊れていれば null。古い形式はここで読み替える。 */
export function decode(str) {
  if (!str) return null;
  try {
    const raw = mapKeys(JSON.parse(fromBase64Url(str)), SHORT);
    return migrate(raw);
  } catch {
    return null;
  }
}

/** 古いバージョンの state を今の形に直す。今は v1 しか無い。 */
function migrate(state) {
  if (!state || typeof state !== 'object') return null;
  if ((state.v ?? 1) > SAVE_VERSION) return null;   // 未来の形式は読まない
  state.v = SAVE_VERSION;
  return state;
}

/**
 * 新しいゲーム。所持金と空の所有リスト。シーズンは season.js が作る（ここでは null）。
 * @param {object} economy data/economy.json
 */
export function newGame(economy) {
  return {
    v: SAVE_VERSION,
    money: economy.initial_money,
    cls: 1,
    tier: 0,
    owned: [],
    cond: {},
    setup: { race: { parts: [], settings: {} }, quali: null },
    season: null,
    sponsor: null,
  };
}

/** URL の検索文字列から state を取り出す。無ければ null。 */
export function stateFromSearch(search) {
  return decode(new URLSearchParams(search).get('s'));
}

/** state と追加のパラメータから、次の画面の検索文字列を作る。 */
export function searchWithState(state, extra = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined) q.set(k, String(v));
  q.set('s', encode(state));
  return `?${q}`;
}
