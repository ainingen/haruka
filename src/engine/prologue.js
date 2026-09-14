/**
 * プロローグ第2場のダイジェスト（docs/シナリオ/プロローグ台本.md）。
 *
 * **走りは本編と同じ経路**（race.js の `createRunner` / `runField`）。カート用の別計算は作らない。
 * 第1場の3つの選択は `data/prologue.json` の値ぶんだけ性能を動かす＝「わずかにタイムに反映」。
 * 空気圧を高くすると序盤が速く終盤にタレるので、**そのときだけ1台に抜かれて2位**になる。
 * どの選択でも2位以上であることは、テスト S12 が18通りすべてで見張る。
 *
 * ここは純関数だけ（I/O なし）。画面は `src/ui/prologue.html`。
 */
import { buildPerformance, createRunner, runField, rankRunners } from './race.js';

/** 自車の id。順位を引くときに使う。 */
export const ME = 'me';

/** 第1場の選択 → 性能の差。data/prologue.json の値を delta ぶん効かせる。 */
function applyChoices(perf, cfg, flags) {
  const deltas = {
    ...(cfg.sprocket[flags.sprocket] ?? {}),
    ...(cfg.sidebar[flags.sidebar] ?? {}),
  };
  for (const [key, value] of Object.entries(deltas)) perf.stats[key] += value * cfg.delta;
  return perf;
}

/**
 * 出走する8台。先頭が自車（ハルカ）、あとは名簿を使わない当て馬。
 * @param {object} cfg data/prologue.json
 * @param {object} flags 第1場の選択（pressure / sprocket / sidebar）
 * @param {object} data { course, chassis, driver }
 */
export function prologueCars(cfg, flags, { chassis, driver }) {
  const pressure = cfg.pressure[flags.pressure] ?? cfg.pressure.mid;
  const mine = applyChoices(buildPerformance([], driver, chassis, { tire_pressure: pressure }), cfg, flags);
  const cars = [{ id: ME, ...createRunner({ perf: mine, driver, seed: cfg.seed, laps: cfg.laps }) }];
  cfg.rivals.forEach((gap, i) => {
    // 当て馬は基準の空気圧のまま。gap がマイナスなら自車より速い（先頭の1台だけ近い）
    const perf = buildPerformance([], driver, chassis, { tire_pressure: cfg.pressure.mid });
    perf.stats.power -= gap;
    perf.stats.cornering_grip -= gap;
    cars.push({ id: `ai${i}`, ...createRunner({ perf, driver, seed: cfg.seed + 100 + i, laps: cfg.laps }) });
  });
  return cars;
}

/** 走り終えた場から自車の順位を引く（1始まり）。 */
export function prologuePos(cars, course) {
  const ranked = rankRunners(cars, course.length);
  return ranked.findIndex((c) => c.id === ME) + 1;
}

/**
 * 最後まで走らせて順位を返す（テストと、画面を飛ばしたときに使う）。
 * 画面は同じ車を1フレームずつ `stepField` で進める。
 */
export function runPrologue(cfg, flags, { course, chassis, driver }) {
  const cars = prologueCars(cfg, flags, { chassis, driver });
  runField(cars, { course, laps: cfg.laps, grid: false });
  return { cars, pos: prologuePos(cars, course) };
}
