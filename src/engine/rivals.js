/**
 * AI 車の組み立て（docs/設計/経済とシーズン.md「AI の構成」）。
 *
 * AI は**自車の構成を参照しない。** 名簿（data/rivals.json）の強さと性格から、固定の構成を持つ。
 *
 * 3段階とも**同じノート**（data/notes.json のそのコース・クラスの基準セッティング）を見る。
 * 違うのは、そのうち何点を積めるか。**金の無いチームほど高いパーツから欠ける**ので、
 * ノートを安い順に並べて頭から取る。
 *
 *   遅い：ノートの3割（切り捨て。最低1点）
 *   並　：ノートの7割（四捨五入）
 *   速い：ノート全点 ＋ 性格に合うパーツ 2〜3点
 *         （直線型＝ギア比・出力、コーナー型＝足・空力、低速型＝ブレーキ・LSD）
 *
 * 遅い・並の点数はノートの長さだけで決まる（種で散らさない）。速いが足すパーツだけ
 * シーズン開始時の種で確定し、そのシーズン中は固定。基準はコースごとに引き直す。
 * セッティング（連続値）は3段階とも同じ。金が要らないので、貧乏でも詰められる。
 *
 * この作り方をするのは、**遅いと並の間に車を置く**ため。遅いを「純正＋安物1〜2点」に
 * していたときは、ノートを持つ群と持たない群に場が割れ、自車が3点買っても5点買っても
 * 同じ位置に落ちた（docs/設計/経済とシーズン.md「AI の構成」）。
 *
 * AI も規定内（クラスとスポンサー段階）のパーツしか使わない。I/O は持たない。
 */
import { buildPerformance, occupiedSlots } from './race.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 性格。data/rivals.json の profile がこのキーを指す。
 * radio は雑談と解説の語り口（data/radio.json chat.ai、commentary.json analyst_traits）。
 * keys は「速い」が足すパーツを選ぶときに重く見る効果。
 */
export const AI_PROFILES = {
  straight: { radio: 'straight', keys: ['top_speed', 'power', 'top_end_power'] },
  power:    { radio: 'straight', keys: ['power', 'top_end_power', 'throttle_response'] },
  corner:   { radio: 'corner', keys: ['downforce', 'cornering_grip', 'rigidity', 'road_compliance'] },
  stopgo:   { radio: 'slow', keys: ['braking', 'fade_resistance', 'traction', 'acceleration'] },
  balanced: { radio: 'aggressive', keys: ['stability', 'cornering_grip', 'power'] },
};

/**
 * 強さ3段階。差はパーツで付け、技量の差は小さく（遅いの技量を大きく下げると、
 * パーツの差を打ち消して純正の自車が遅い車に勝ってしまう）。
 *
 *   noteFrac  ノートのうち積める割合（安い順に頭から取る）
 *   rounding  点数の丸め。遅いは切り捨て（ただし最低1点）、並は四捨五入
 *   extras    ノート全点に足す性格のパーツの点数（この範囲から乱数で）
 */
export const AI_STRENGTH = {
  fast:   { skill: +3, extras: [2, 3] },
  normal: { skill: 0, noteFrac: 0.7, rounding: 'round' },
  slow:   { skill: -2, noteFrac: 0.3, rounding: 'floor' },
};

/**
 * ノートのうち、その強さが積める点数ぶんを返す。**高いほうから欠ける。**
 * 同じ値段のときは id 順で決める（種を使わない＝同じノートなら毎回同じ構成）。
 * @param {object[]} noteParts そのコース・クラスのノートのパーツ
 * @param {object}   str       AI_STRENGTH の要素
 */
export function notePortion(noteParts, str) {
  if (!str.noteFrac) return noteParts;
  const raw = noteParts.length * str.noteFrac;
  const n = str.rounding === 'floor' ? Math.max(1, Math.floor(raw)) : Math.round(raw);
  return [...noteParts]
    .sort((a, b) => a.price - b.price || (a.id < b.id ? -1 : 1))
    .slice(0, Math.min(n, noteParts.length));
}

/** AI が使える規定内のパーツ。スポンサー段階はクラス − 1 とみなす。 */
export const aiLegal = (part, cls) => part.class_required <= cls && part.sponsor_tier <= Math.max(0, cls - 1);

/** スロットが重なるか。 */
const conflicts = (a, b) => occupiedSlots(a).some((s) => occupiedSlots(b).includes(s));

/** base のうち extras とスロットが重なるものを外し、extras を足す（追加が上書きする）。 */
export function mergeLoadout(base, extras) {
  const kept = base.filter((p) => !extras.some((e) => conflicts(p, e)));
  return [...kept, ...extras];
}

/**
 * 「並」の基準：そのコース・クラスの親父のノート。無ければ、そのコースの下のクラスのノート、
 * それも無ければ同じクラスの別コースのノート。何も無ければ純正。
 * @returns {{ parts: object[], settings: object, note: object|null }}
 */
export function baselineFor(notes, parts, course, cls) {
  const byId = (id) => parts.find((p) => p.id === id);
  let note = null;
  for (let c = cls; c >= 1 && !note; c--) note = notes.find((n) => n.course === course.id && n.class === c) ?? null;
  for (let c = cls; c >= 1 && !note; c--) note = notes.find((n) => n.class === c) ?? null;
  if (!note) return { parts: [], settings: {}, note: null };
  return {
    parts: note.parts.map(byId).filter((p) => p && aiLegal(p, cls)),
    settings: { ...(note.settings ?? {}) },
    note,
  };
}

/**
 * シーズン開始時に決める、各 AI の「足すパーツ」。乱数の種から決定的に作る。
 *   速い：性格の keys で効果を採点し、上位から extras 点（スロットが重ならないように）
 *   並・遅い：なし（積む点数はノートの長さで決まる。notePortion）
 * @returns {Object<string, string[]>} ai id → パーツ id
 */
export function seasonRivalPlan(entries, parts, cls, rng) {
  const legal = parts.filter((p) => aiLegal(p, cls));
  const plan = {};
  entries.forEach((entry, i) => {
    const str = AI_STRENGTH[entry.strength] ?? AI_STRENGTH.normal;
    const prof = AI_PROFILES[entry.profile] ?? AI_PROFILES.balanced;
    const chosen = [];
    const take = (pool, count) => {
      for (const p of pool) {
        if (chosen.length >= count) break;
        if (chosen.some((c) => conflicts(c, p))) continue;
        chosen.push(p);
      }
    };
    if (str.extras) {
      const [lo, hi] = str.extras;
      const count = lo + Math.floor(rng() * (hi - lo + 1));
      const score = (p) => prof.keys.reduce((s, k) => s + (p.effects?.[k] ?? 0), 0);
      // 同点なら乱数で散らす（同じ性格の車が全部同じ構成にならないように）
      const ranked = legal.map((p) => ({ p, s: score(p), r: rng() }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.r - b.r).map((x) => x.p);
      take(ranked, count);
    }
    plan[`ai${i}`] = chosen.map((p) => p.id);
  });
  return plan;
}

/**
 * そのコースでの AI の装着と連続値。3段階ともコースごとにノートを引き直す。
 * 遅い・並はそのうち積める点数だけ、速いは全点にシーズンの追加ぶんを載せる。
 * セッティングは3段階とも同じ（金が要らない）。
 */
export function rivalLoadout(entry, i, plan, parts, notes, course, cls) {
  const str = AI_STRENGTH[entry.strength] ?? AI_STRENGTH.normal;
  const base = baselineFor(notes, parts, course, cls);
  if (str.noteFrac) return { parts: notePortion(base.parts, str), settings: base.settings };
  const extras = (plan[`ai${i}`] ?? []).map((id) => parts.find((p) => p.id === id)).filter((p) => p && aiLegal(p, cls));
  return { parts: mergeLoadout(base.parts, extras), settings: base.settings };
}

/**
 * 名簿の1行から AI 車の中身を組む。画面側はこれに描画用の状態を足す。
 * @param {object} entry   rivals.json の要素
 * @param {number} i       名簿での位置（id に使う）
 * @param {object} ctx     { loadout: { parts, settings }, driver, chassis, rng }
 */
export function rivalSpec(entry, i, { loadout, driver, chassis, rng }) {
  const prof = AI_PROFILES[entry.profile] ?? AI_PROFILES.balanced;
  const str = AI_STRENGTH[entry.strength] ?? AI_STRENGTH.normal;
  const aiDriver = {
    ...driver,
    skill: clamp(driver.skill + str.skill + Math.round((rng() - 0.5) * 6), 30, 99),
    consistency: clamp(driver.consistency + Math.round((rng() - 0.5) * 30), 20, 95),
    preferred_balance: driver.preferred_balance + Math.round((rng() - 0.5) * 4),
  };
  return {
    id: `ai${i}`,
    name: `${entry.number}号車 ${entry.name}`,
    short: `#${entry.number} ${entry.name}`,
    number: entry.number,
    radio: prof.radio,
    perf: buildPerformance(loadout.parts, aiDriver, chassis, loadout.settings),
    driver: aiDriver,
    partIds: loadout.parts.map((p) => p.id),
  };
}

/** そのコース・クラスの出走台数ぶん、名簿の先頭から相手を取る（自車ぶんを除く）。 */
export function fieldEntries(rivals, course, cls) {
  const gridSize = clamp(Number(course.grid?.[cls] ?? 6), 2, rivals.length + 1);
  return rivals.slice(0, gridSize - 1);
}
