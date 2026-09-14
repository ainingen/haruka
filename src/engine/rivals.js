/**
 * AI 車の組み立て（docs/設計/経済とシーズン.md「AI の構成」）。
 *
 * AI は**自車の構成を参照しない。** 名簿（data/rivals.json）の強さと性格から、固定の構成を持つ。
 *
 *   遅い：純正ベース ＋ そのクラスで買える最安パーツ 1〜2点
 *   並　：data/notes.json のそのコース・クラスの基準セッティング（親父のノート）
 *   速い：並 ＋ 性格に合うパーツ 2〜3点（直線型＝ギア比・出力、コーナー型＝足・空力、低速型＝ブレーキ・LSD）
 *
 * 「どのパーツを足すか」（速いの追加、遅いの安物）はシーズン開始時に乱数の種で確定し、
 * そのシーズン中は固定。並・速いの基準はコースごとに notes.json から引き直す。
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

/** 強さ3段階。技量の差と、構成の決め方。 */
export const AI_STRENGTH = {
  fast:   { skill: +5, extras: [2, 3] },   // 並に足す点数（この範囲から乱数で）
  normal: { skill: 0 },
  slow:   { skill: -5, cheap: [1, 2] },    // 純正に足す安物の点数
};

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
 *   遅い：最安の規定内パーツを cheap 点（スロットが重ならないように）
 *   速い：性格の keys で効果を採点し、上位から extras 点（スロットが重ならないように）
 *   並　：なし
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
    if (str.cheap) {
      const [lo, hi] = str.cheap;
      const count = lo + Math.floor(rng() * (hi - lo + 1));
      take([...legal].sort((a, b) => a.price - b.price), count);
    } else if (str.extras) {
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
 * そのコースでの AI の装着と連続値。並・速いはコースごとにノートを引き直し、
 * シーズン開始時に決めた追加ぶんを上に載せる。遅いは純正＋安物だけ。
 */
export function rivalLoadout(entry, i, plan, parts, notes, course, cls) {
  const str = AI_STRENGTH[entry.strength] ?? AI_STRENGTH.normal;
  const extras = (plan[`ai${i}`] ?? []).map((id) => parts.find((p) => p.id === id)).filter((p) => p && aiLegal(p, cls));
  if (str.cheap) return { parts: extras, settings: {} };
  const base = baselineFor(notes, parts, course, cls);
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
