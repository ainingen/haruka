/**
 * 自由設定（タイムアタック）の計算と記録（docs/設計/自由設定.md）。
 *
 * **race.js は触らない。** 上書きは `buildPerformance` に渡す**前**に部品へ当てる。
 * 走行も既存の `simulateRace` をそのまま呼ぶ。ここにあるのは
 *
 *   1. 効果値の上書き（±50%）
 *   2. 1本走る手順（アウトラップを捨てるフライング計測）
 *   3. 記録とノートの入れ物（localStorage の `haruka.local.v1` の中）
 *
 * ここは純関数だけ（I/O なし）。localStorage の読み書きは save.js の
 * `loadLocal` / `saveLocal` を呼ぶ側（画面）がやる。
 */
import { simulateRace } from './race.js';

// ---------------------------------------------------------------------------
// 効果値の上書き
// ---------------------------------------------------------------------------

/** 上書きの範囲。**±50%**。元の値に倍率を掛ける（負の値は罰が重くなる向きに伸びる）。 */
export const OVERRIDE = { min: 0.5, max: 1.5, step: 0.05 };

/**
 * 倍率を範囲に収める。**未設定（null / undefined / 空文字）と数でないものは 1**＝素のまま。
 * 0 を「素のまま」にしないのは、0 を入れたら効果を消したい、という意図が読めるため
 * （それでも下限の 0.5 で止まる）。
 */
export const clampFactor = (v) => {
  if (v === null || v === undefined || v === '') return 1;
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(OVERRIDE.max, Math.max(OVERRIDE.min, n));
};

/** 上書きが1つでも入っているか（素のままなら false）。 */
export const hasOverride = (o) => !!o && ['effects', 'side_effects']
  .some((k) => Object.values(o[k] ?? {}).some((v) => clampFactor(v) !== 1));

/**
 * 部品1つに上書きを当てた写しを返す。**元の部品は変えない。**
 * @param {object} part data/parts.json の1件
 * @param {object} [over] { effects: {key: 倍率}, side_effects: {key: 倍率} }
 */
export function overridePart(part, over) {
  if (!hasOverride(over)) return part;
  const bend = (table, factors) => {
    if (!table) return table;
    const out = {};
    for (const [k, v] of Object.entries(table)) out[k] = v * clampFactor(factors?.[k]);
    return out;
  };
  return {
    ...part,
    effects: bend(part.effects, over.effects),
    side_effects: bend(part.side_effects, over.side_effects),
  };
}

/**
 * 装着中の部品に上書きを当てる。**buildPerformance に渡す前に通す。**
 * @param {object[]} parts 装着中の部品
 * @param {object} overrides { [partId]: { effects, side_effects } }
 */
export const applyOverrides = (parts, overrides = {}) =>
  parts.map((p) => overridePart(p, overrides[p.id]));

/**
 * 上書きを保存できる形に畳む。**素のままの倍率は捨てる**（記録が太らないように）。
 * @returns {object} 1つも無ければ空オブジェクト
 */
export function packOverrides(overrides = {}) {
  const out = {};
  for (const [id, o] of Object.entries(overrides)) {
    const one = {};
    for (const table of ['effects', 'side_effects']) {
      const keep = {};
      for (const [k, v] of Object.entries(o?.[table] ?? {})) {
        const f = clampFactor(v);
        if (f !== 1) keep[k] = Math.round(f * 100) / 100;
      }
      if (Object.keys(keep).length) one[table] = keep;
    }
    if (Object.keys(one).length) out[id] = one;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 走行
// ---------------------------------------------------------------------------

/**
 * 計測の前にころがす周回。**冷えたタイヤで測らない**（予選のアウトラップと同じ考え）。
 * 「1周＝フライング計測」はこれがあって成り立つ。
 */
export const WARMUP_LAPS = 1;

/**
 * タイムアタックを1本走る。**計算は本編と同じ `simulateRace`。**
 * 先頭の `WARMUP_LAPS` 周はアウトラップとして捨てる。信頼性は効く（リタイアあり）。
 *
 * @param {object} perf buildPerformance の結果（上書き済みの部品で組んだもの）
 * @param {object} course data/courses.json の1件
 * @param {object} driver data/drivers.json の1件
 * @param {object} [opts] { laps 計測する周回数, seed, noise 腕のブレ（テストで切れる） }
 * @returns {{ laps, best, total, retired, retiredLap, retireReason, warmup }}
 */
export function runAttack(perf, course, driver, { laps = 1, seed = 1, noise = true } = {}) {
  const n = Math.max(1, Math.round(laps));
  const r = simulateRace(perf, course, n + WARMUP_LAPS, driver, { seed, noise, retire: true });
  const timed = r.laps.slice(WARMUP_LAPS);
  // アウトラップの途中で壊れたら、計測に入れていない
  const retired = r.retired;
  const best = timed.length ? Math.min(...timed.map((l) => l.time)) : Infinity;
  return {
    courseId: course.id,
    warmup: r.laps.slice(0, WARMUP_LAPS),
    laps: timed.map((l, i) => ({ ...l, lap: i + 1 })),
    best,
    total: timed.reduce((a, l) => a + l.time, 0),
    retired,
    retiredLap: r.retiredLap == null ? null : r.retiredLap - WARMUP_LAPS,
    retireReason: r.retireReason,
    complete: !retired && timed.length === n,
  };
}

// ---------------------------------------------------------------------------
// 記録（localStorage の区画。**URL には乗せない**）
// ---------------------------------------------------------------------------

/** `loadLocal()` の中のどこに置くか。 */
export const FREE_SLOT = 'free';

/** ノートの上限。超えたら古い順に消す。 */
export const NOTE_MAX = 50;

/** 空の記録。 */
export const emptyFree = () => ({ best: {}, note: [] });

/** `loadLocal()` の結果から自由設定の区画を取り出す（無ければ空）。 */
export function readFree(local) {
  const f = local?.[FREE_SLOT];
  return {
    best: (f && typeof f.best === 'object' && f.best) || {},
    note: Array.isArray(f?.note) ? f.note : [],
  };
}

/** 自由設定の区画を `loadLocal()` の結果に畳んで返す（他の区画は残す）。 */
export const writeFree = (local, free) => ({ ...(local ?? {}), [FREE_SLOT]: free });

/**
 * ベストを更新する。**速くなったときだけ**差し替える。
 * @param {object} free 記録
 * @param {string} courseId
 * @param {object} entry { time, laps, parts, over, settings, at }
 * @returns {{ free, updated, prev }} updated＝更新したか
 */
export function putBest(free, courseId, entry) {
  const prev = free.best[courseId] ?? null;
  if (prev && !(entry.time < prev.time)) return { free, updated: false, prev };
  return { free: { ...free, best: { ...free.best, [courseId]: entry } }, updated: true, prev };
}
