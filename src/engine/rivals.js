/**
 * AI 車の組み立て（docs/設計/レース方式.md）。
 *
 * 名簿は data/rivals.json。性格（5種）と強さ（3段階）から、自車と同じ構成を借りて
 * 少しだけ違う車を作る。同クラス想定なので、得意分野を散らして総合力は近づける。
 * レース画面もツールもここを使う。I/O は持たない。
 */
import { buildPerformance } from './race.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 性格。data/rivals.json の profile がこのキーを指す。
 * radio は雑談と解説の語り口（data/radio.json chat.ai、commentary.json analyst_traits）。
 */
export const AI_PROFILES = {
  straight: { radio: 'straight', tune: { power: 10, top_speed: 6, drag: -2, downforce: -6, cornering_grip: -4 } },
  corner:   { radio: 'corner', tune: { downforce: 12, cornering_grip: 6, drag: 5, power: -6, top_speed: -3 } },
  balanced: { radio: 'aggressive', tune: { power: 3, cornering_grip: 2, stability: 3, weight: -6 } },
  power:    { radio: 'straight', tune: { power: 16, heat: 5, reliability: -7, driver_demand: 4, cornering_grip: -3 } },
  stopgo:   { radio: 'slow', tune: { acceleration: 9, traction: 7, braking: 5, top_speed: -7, tire_wear: 3 } },
};

/** 強さ3段階。技量の差と、全域に薄く乗せる性能差。同じ性格・同じ強さでも個体差はこの上に乗る。 */
export const AI_STRENGTH = {
  fast:   { skill: +5, boost: 3 },
  normal: { skill: 0, boost: 0 },
  slow:   { skill: -5, boost: -3 },
};

/**
 * 名簿の1行から AI 車の中身を組む。画面側はこれに描画用の状態を足す。
 * @param {object} entry   rivals.json の要素
 * @param {number} i       名簿での位置（id と乱数の種に使う）
 * @param {object} ctx     { mine, driver, chassis, settings, rng }
 *   mine は自車のパーツ（消耗前のもの）。AI は構成を借りるが消耗は借りない
 */
export function rivalSpec(entry, i, { mine, driver, chassis, settings, rng }) {
  const prof = AI_PROFILES[entry.profile] ?? AI_PROFILES.balanced;
  const str = AI_STRENGTH[entry.strength] ?? AI_STRENGTH.normal;
  const jitter = {};
  for (const key of ['power', 'cornering_grip', 'downforce', 'acceleration', 'braking']) {
    jitter[key] = str.boost + Math.round((rng() - 0.5) * 6);
  }
  const tune = { id: `ai_tune_${i}`, effects: prof.tune, side_effects: jitter };
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
    perf: buildPerformance([...mine, tune], aiDriver, chassis, settings),
    driver: aiDriver,
  };
}

/** そのコース・クラスの出走台数ぶん、名簿の先頭から相手を取る（自車ぶんを除く）。 */
export function fieldEntries(rivals, course, cls) {
  const gridSize = clamp(Number(course.grid?.[cls] ?? 6), 2, rivals.length + 1);
  return rivals.slice(0, gridSize - 1);
}
