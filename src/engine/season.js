/**
 * シーズン進行（docs/設計/経済とシーズン.md「シーズン」「スポンサー」）。
 *
 * 6戦、ポイント制、昇降格、オフシーズンのノート、スポンサー段階。
 * state を受け取る関数は新しい state を返し、元は変えない。数値は data/economy.json。
 */
import { createRng, createRunner, runField, simulateQualifying, START } from './race.js';
import { rivalSpec, fieldEntries, seasonRivalPlan, rivalLoadout } from './rivals.js';

/** そのクラスで走れるコース。classes が無いデータは全クラス可とみなす。 */
export const coursesFor = (courses, cls) => courses.filter((c) => !c.classes || c.classes.includes(cls));

/**
 * 新しいシーズンを組む。走れるコースから rounds_per_season 戦を引く（同じコースが2回入ることもある）。
 * @param {function} rng 0〜1 の乱数
 */
export function newSeason(cls, courses, economy, rng = Math.random, year = 1, note = null) {
  const pool = coursesFor(courses, cls);
  if (!pool.length) throw new Error(`クラス${cls}で走れるコースが無い`);
  const n = economy.rounds_per_season;
  const rounds = [];
  for (let i = 0; i < n; i++) {
    // 直前と同じコースが続くのは避ける（2回入ること自体はある）
    let c = pool[Math.floor(rng() * pool.length)];
    if (rounds.length && pool.length > 1 && c.id === rounds.at(-1).course) c = pool[(pool.indexOf(c) + 1) % pool.length];
    rounds.push({ course: c.id, laps: economy.laps[cls], result: null });
  }
  // AI の構成（速いが足すパーツ、遅いの安物）はこの種から決まり、シーズン中は固定（rivals.js）
  const rivalSeed = Math.floor(rng() * 1e9);
  return { year, rounds, next: 0, points: {}, symptoms: {}, note, rivalSeed };
}

/** そのシーズンの AI の構成。種から決定的に作るので state には種だけを持つ。 */
export function rivalPlanFor(season, entries, parts, cls) {
  return seasonRivalPlan(entries, parts, cls, createRng(season?.rivalSeed ?? 1));
}

/** いま走る戦。全部終わっていれば null。 */
export const currentRound = (season) => (season && season.next < season.rounds.length ? season.rounds[season.next] : null);
export const seasonOver = (season) => !!season && season.next >= season.rounds.length;

/** 順位 → ポイント。表の外は 0。リタイアも 0。 */
export function pointsFor(economy, pos, retired = false) {
  if (retired || !pos) return 0;
  return economy.points[pos - 1] ?? 0;
}

/**
 * 1戦の結果を記録する。
 * @param {object} state
 * @param {object} result
 *   @param {Array<{id, pos, retired}>} result.classification 全車の着順（自車は id 'me'）
 *   @param {object} result.mine  自車の収支など { pos, retired, prize, fee, sponsorFee, repair, best }
 *   @param {object} [result.symptoms]  その戦で自車に出た情報系トリガー → 回数
 */
export function recordResult(state, result, economy) {
  const season = state.season;
  const round = currentRound(season);
  if (!round) throw new Error('走る戦が無い');
  const points = { ...season.points };
  for (const car of result.classification) {
    points[car.id] = (points[car.id] ?? 0) + pointsFor(economy, car.pos, car.retired);
  }
  const symptoms = { ...season.symptoms };
  for (const [id, n] of Object.entries(result.symptoms ?? {})) symptoms[id] = (symptoms[id] ?? 0) + n;
  const rounds = season.rounds.map((r, i) => (i === season.next
    ? { ...r, result: { ...result.mine, points: pointsFor(economy, result.mine.pos, result.mine.retired) } }
    : r));
  return { ...state, season: { ...season, rounds, next: season.next + 1, points, symptoms } };
}

/** ポイント順の並び。同点なら自車を上に（プレイヤーに有利な曖昧さ）。 */
export function standings(season, ids) {
  const all = [...new Set([...ids, ...Object.keys(season.points)])];
  return all
    .map((id) => ({ id, points: season.points[id] ?? 0 }))
    .sort((a, b) => b.points - a.points || (a.id === 'me' ? -1 : b.id === 'me' ? 1 : 0));
}

/** 自車のランキング（1始まり）。 */
export const myRank = (season, ids) => standings(season, ids).findIndex((s) => s.id === 'me') + 1;

/**
 * シーズン終了の判定。昇格・降格・残留と、新しいクラス。クラス1からは下がらない、クラス5からは上がらない。
 * @param {string[]} ids そのシーズンに出走した車の id（'me' と 'ai0'…）
 */
export function verdictFor(state, ids, economy) {
  const rank = myRank(state.season, ids);
  const total = ids.length;
  const cls = state.cls;
  const promoteLine = economy.promote[cls];
  const relegateCount = economy.relegate[cls] ?? 0;
  if (promoteLine && rank <= promoteLine && cls < 5) return { verdict: 'promote', rank, total, from: cls, to: cls + 1 };
  if (relegateCount && rank > total - relegateCount && cls > 1) return { verdict: 'relegate', rank, total, from: cls, to: cls - 1 };
  return { verdict: 'stay', rank, total, from: cls, to: cls };
}

/** その年にいちばん多かった症状。無ければ null。 */
export function topSymptom(season) {
  const entries = Object.entries(season.symptoms ?? {}).filter(([, n]) => n > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

/**
 * スポンサー段階の更新（上がるだけ。下がらない）。
 *   1：クラス2に昇格した時点
 *   2：クラス3で1シーズン完走（6戦すべて出走）
 *   3：クラス4でシーズン3位以内
 *   4：クラス5に昇格
 */
export function sponsorTierAfter(state, verdict) {
  let tier = state.tier;
  const finished = state.season.rounds.every((r) => r.result);
  if (verdict.to >= 2) tier = Math.max(tier, 1);
  if (state.cls === 3 && finished) tier = Math.max(tier, 2);
  if (state.cls === 4 && verdict.rank <= 3) tier = Math.max(tier, 3);
  if (verdict.to >= 5) tier = Math.max(tier, 4);
  return tier;
}

/**
 * シーズンを閉じて次を組む。昇降格、スポンサー段階、ハルカのノート、新しい6戦。
 * @param {object[]} sponsors data/sponsors.json（段階ごとの会社）
 * @returns {{ state, verdict, note, sponsorChanged }}
 */
export function endSeason(state, ids, courses, economy, sponsors, rng = Math.random, noteLines = null) {
  const verdict = verdictFor(state, ids, economy);
  const tier = sponsorTierAfter(state, verdict);
  const symptom = topSymptom(state.season);
  const note = noteLines ? pickNote(noteLines, symptom, rng) : null;
  let sponsor = state.sponsor;
  let sponsorChanged = false;
  if (tier > (sponsor?.tier ?? 0)) {
    const pool = (sponsors ?? []).filter((s) => s.tier === tier);
    if (pool.length) { sponsor = { tier, id: pool[Math.floor(rng() * pool.length)].id }; sponsorChanged = true; }
  }
  const next = { ...state, cls: verdict.to, tier, sponsor };
  next.season = newSeason(verdict.to, courses, economy, rng, state.season.year + 1, note);
  return { state: next, verdict, note, symptom, sponsorChanged };
}

/** radio.json の season_note から一行。症状が無ければ clean。 */
export function pickNote(noteLines, symptom, rng = Math.random) {
  const pool = noteLines[symptom] ?? noteLines.clean;
  if (!pool?.length) return null;
  const e = pool[Math.floor(rng() * pool.length)];
  return typeof e === 'string' ? e : e.text;
}

/**
 * そのレースの出走表を組む（自車 ＋ 名簿の相手）。画面（src/ui/race.html）と同じ並び。
 * @returns {Array<{ id, name, perf, driver, partIds }>}
 */
export function buildField({ myPerf, driver, chassis, course, rivals, parts, notes, cls, seed = 1, rivalSeed = 1 }) {
  const rng = createRng(seed);
  const field = [{ id: 'me', name: '神谷ハルカ', perf: myPerf, driver, partIds: myPerf.partIds }];
  const entries = fieldEntries(rivals, course, cls);
  const plan = seasonRivalPlan(entries, parts, cls, createRng(rivalSeed));
  for (const [i, entry] of entries.entries()) {
    const loadout = rivalLoadout(entry, i, plan, parts, notes, course, cls);
    const spec = rivalSpec(entry, i, { loadout, driver, chassis, rng });
    field.push({ id: spec.id, name: spec.name, perf: spec.perf, driver: spec.driver, partIds: spec.partIds });
  }
  return field;
}

/**
 * 1戦を通しで走らせて着順を出す（画面を使わない。ツールとテスト用）。
 *
 * **画面の決勝と同じ経路を通る。** 予選でグリッドを決め、全車を同じ場で dt 秒ずつ進める
 * （race.js の runField）。スタートの遅れと混雑がそのまま入るので、ここで出る順位は
 * 画面で見る順位と同じ性質を持つ。
 *
 * @param {object} args { myPerf, driver, chassis, course, laps, rivals, parts, notes, cls, seed, rivalSeed }
 * @returns {Array<{ id, name, pos, retired, total, best, gridPos, partIds }>}
 */
export function simulateField(args) {
  const { course, laps, seed = 1 } = args;
  const field = buildField(args);

  // --- 予選。ベストラップの順にグリッドが決まる（画面の流れと同じ） ---------
  const grid = field
    .map((car, i) => ({ car, best: simulateQualifying(car.perf, course, car.driver, { seed: seed + i * 977 }).best }))
    .sort((a, b) => a.best - b.best)
    .map((x) => x.car);

  // --- 決勝 -----------------------------------------------------------------
  const runners = field.map((car, i) => ({
    ...car,
    ...createRunner({ perf: car.perf, driver: car.driver, seed: seed + i * 977, laps }),
  }));
  const byId = Object.fromEntries(runners.map((r) => [r.id, r]));
  grid.forEach((car, i) => {
    const r = byId[car.id];
    r.gridPos = i + 1;
    r.delay = i * START.slotDelay;
  });
  const order = runField(runners, { course, laps, grid: true });
  return order.map((r, i) => ({
    id: r.id, name: r.name, pos: i + 1, retired: r.retired, retireReason: r.retireReason,
    total: r.raceTime, best: r.best, laps: r.lapTimes.length, gridPos: r.gridPos, partIds: r.partIds,
  }));
}
