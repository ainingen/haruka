/**
 * ゲームの進行（state）のシリアライズと保存先。docs/設計/経済とシーズン.md「セーブ」。
 *
 * **入出口はこのファイルだけ。** 形式も保存先もここにしかない。画面は `loadState()` で読み、
 * `save()` で書き、`searchWithState()` で次の画面へ渡す。将来 PLiCy のセーブ機能に
 * 置き換えるときも、ここだけを差し替える。
 *
 * 保存先は2つあり、**この中で切り替える**。
 *
 *   localStorage  使えればこちら。画面をまたいでも、URL を捨てても残る
 *   URL の `s=`   使えなければこちら。これまで通り、画面間は `s=` 1つで持ち回る
 *
 * どちらの場合も **URL の文字列は出せる**（`encode` / `searchWithState`）。
 * index.html の貼り付けと season.html の保存の箱は、保存先に関係なく動く。
 * 読むときは **URL の `s=` が優先**：貼り付けた文字列と画面間の受け渡しが、保存より強い。
 *
 * 中身は短いキーの JSON を base64url にしたもの。長くなるようなら圧縮はここだけ変えればいい。
 * encode / decode は純粋。I/O を持つのは保存先の層（`save` / `loadSaved` / `saveLocal` …）だけ。
 */

export const SAVE_VERSION = 1;

/** 長いキー → 短いキー。両方向で使う。 */
const KEYS = {
  v: 'v', money: 'm', cls: 'c', tier: 't', owned: 'o', cond: 'd', setup: 's',
  season: 'z', sponsor: 'p', player: 'A', prologue: 'B', ending: 'D',
  // player
  name: 'w',
  // ending（見た場面の記録と、第7場で書いた一行）
  seen: 'G', done: 'H',
  // prologue（プロローグで決まったもの。短いものだけ。台本は docs/シナリオ/プロローグ台本.md）
  // 順位は result と同じ短いキー（pos: 'a'）を使う。下の「result」に定義がある
  line: 'x', pressure: 'u', sprocket: 'e', sidebar: 'k',
  // setup
  race: 'r', quali: 'q', parts: 'P', settings: 'S', fuel: 'F',
  // season
  year: 'y', rounds: 'R', next: 'n', points: 'K', symptoms: 'Y', note: 'N', rivalSeed: 'V',
  course: 'C', laps: 'L', result: 'E', endurance: 'X',
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

/** プレイヤー名の上限。長い名前は実況の行に収まらない。 */
export const NAME_MAX = 20;
/** ハルカがプロローグで書いた一行の上限。ノートの1行に収まる長さ。 */
export const LINE_MAX = 40;

/** 名前の既定。台本では「主人公」と表記する（docs/シナリオ/キャラクター.md）。 */
export const DEFAULT_NAME = '主人公';
/** プロローグでハルカが書く一行の既定。ひらがなが多いのは、まだ小さいから。 */
export const DEFAULT_LINE = 'きょう　あたしがきめた。おいちゃんとふたりで';

/**
 * プロローグで決まるもの。**値はプロローグが入れる。ここでは枠と既定だけ。**
 *
 *   pressure  空気圧を下げたか上げたか（low / mid / high）
 *   sprocket  スプロケットを加速寄りにしたか最高速寄りにしたか（accel / mid / top）
 *   sidebar   サイドバーを入れたか（true / false）
 *   pos       そのレースの順位（1 か 2）
 *
 * 3つの選択と順位は、あとの台詞とハルカの記憶の引き出しに使う。
 * 数値としてレースに効かせるものではない（プロローグの車はもう無い）。
 */
export const PROLOGUE_CHOICES = Object.freeze({
  pressure: ['low', 'mid', 'high'],
  sprocket: ['accel', 'mid', 'top'],
});

/** 文字列を上限で切る。前後の空白は落とし、空なら既定。 */
export const trimTo = (value, max, fallback) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : fallback;
};

/**
 * 新しいゲーム。所持金と空の所有リスト。シーズンは season.js が作る（ここでは null）。
 * プレイヤー名とプロローグの記録は既定値で入れておく（プロローグが上書きする）。
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
    player: { name: DEFAULT_NAME },
    prologue: { line: DEFAULT_LINE, pressure: 'mid', sprocket: 'mid', sidebar: false, pos: 1 },
    ending: { seen: [], line: '', done: false },
  };
}

/** 場面を見たか（`ending.seen`）。場面は一度だけ出す。 */
export const sawScene = (state, id) => !!state?.ending?.seen?.includes(id);

/**
 * 自由設定（タイムアタック）に入れるか。**エンディングを見たあとだけ。**
 * 白紙のページ（第8場）はここから先で、本編を終える前には開かない。
 * 画面（index.html / setup.html の free モード）はどちらもこれを見る。
 */
export const canFreeSetup = (state) => !!state?.ending?.done;

/** 場面を見た記録を足した state。**元は変えない。** 二度目は同じものを返す。 */
export function markScene(state, id) {
  if (sawScene(state, id)) return state;
  const ending = state.ending ?? { seen: [], line: '', done: false };
  return { ...state, ending: { ...ending, seen: [...(ending.seen ?? []), id] } };
}

/** プレイヤー名。未入力・壊れていれば既定。 */
export const playerName = (state) => trimTo(state?.player?.name, NAME_MAX, DEFAULT_NAME);
/** プロローグでハルカが書いた一行。無ければ既定。 */
export const prologueLine = (state) => trimTo(state?.prologue?.line, LINE_MAX, DEFAULT_LINE);

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

// ---------------------------------------------------------------------------
// 保存先（この層だけが I/O を持つ）
// ---------------------------------------------------------------------------

/** 進行の保存先。バージョンを名前に入れて、形式が変わっても古い鍵を踏まないようにする。 */
export const SAVE_KEY = `haruka.save.v${SAVE_VERSION}`;
/**
 * **localStorage 専用の区画。** 進行とは別に持ち、**URL には乗せない**。
 * いまは空。あとでタイムアタックの構成がここに入る（持ち回る必要が無く、量が読めないもの）。
 */
export const LOCAL_KEY = `haruka.local.v${SAVE_VERSION}`;

/**
 * localStorage が使えるか。**必ず try で確かめる。**
 * プライベートウィンドウ、設定でサイトデータを止めている環境、file:// では投げる。
 * PLiCy でも使えるとは限らないので、使えない前提の道（URL の `s=`）は残したまま。
 */
export function canStore() {
  try {
    const probe = '__haruka_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * 進行を保存する。使えなければ何もしない（そのときは URL が保存先）。
 * @returns {boolean} 書けたか
 */
export function save(state) {
  if (!state) return false;
  try {
    localStorage.setItem(SAVE_KEY, encode(state));
    return true;
  } catch {
    return false;
  }
}

/** 保存された進行。無ければ null。 */
export function loadSaved() {
  try {
    return decode(localStorage.getItem(SAVE_KEY));
  } catch {
    return null;
  }
}

/** 保存を消す（「はじめから」）。 */
export function clearSaved() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch { /* 使えない環境では何もしない */ }
}

/**
 * 進行を読む。**URL の `s=` が優先**、無ければ保存先。
 * 貼り付けた文字列と画面間の受け渡しが、前に保存したものより強い。
 * @param {string} search location.search
 */
export function loadState(search) {
  return stateFromSearch(search) ?? loadSaved();
}

/**
 * localStorage 専用の区画を読む。URL には乗らないので、ここにあるものは
 * 「その端末にだけある」。使えない環境では常に null。
 */
export function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** localStorage 専用の区画に書く。**進行はここに入れない**（保存先が二重になる）。 */
export function saveLocal(data) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
