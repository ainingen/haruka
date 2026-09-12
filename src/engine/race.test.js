/**
 * レース計算エンジンの挙動テスト。
 *
 *   node --test src/engine/
 *   node src/engine/race.test.js
 *
 * 通らなければ race.js の WEIGHTS を調整する。各テストはラップタイム差も出力するので、
 * 差が「体感できる大きさ」（目安 0.3〜2秒/周）に収まっているかも合わせて見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPerformance, simulateRace, formatTime, SLOTS, occupiedSlots, resolveLoadout } from './race.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));

const PARTS = load('parts.json');
const CHASSIS = load('chassis.json');
const COURSES = load('courses.json');
const DRIVERS = load('drivers.json');

const part = (id) => {
  const p = PARTS.find((x) => x.id === id);
  if (!p) throw new Error(`parts.json に ${id} がない`);
  return p;
};
const course = (id) => {
  const c = COURSES.find((x) => x.id === id);
  if (!c) throw new Error(`courses.json に ${id} がない`);
  return c;
};

const haruka = DRIVERS.find((d) => d.id === 'haruka');
const sedan = CHASSIS.sedan;
const STRAIGHT = 'nagasawa';
const CORNER = 'misaki';
const BALANCED = 'hibaridaira';

/** テストは決定的に。乱数要素（ばらつき・リタイア）は切る。 */
const OPTIONS = { noise: false, retire: false, seed: 1 };
const BASE_PARTS = ['tire_compound_02'];

/** 目安の範囲。外れてもテストは落とさず、出力に印を付ける。 */
const PERCEPTIBLE = { min: 0.3, max: 2.0 };

function race({ parts = BASE_PARTS, extra = [], courseId, laps, driver = haruka }) {
  const perf = buildPerformance([...parts.map(part), ...extra], driver, sedan);
  return simulateRace(perf, course(courseId), laps, driver, OPTIONS);
}

/** A と B のレース結果から、B − A の 1周あたり差（秒）を出力して返す。正なら A が速い。 */
function report(label, a, b) {
  const laps = Math.min(a.laps.length, b.laps.length);
  const diff = (b.total - a.total) / laps;
  const abs = Math.abs(diff);
  const mark = abs < PERCEPTIBLE.min ? '  ← 小さすぎ' : abs > PERCEPTIBLE.max ? '  ← 大きすぎ' : '';
  console.log(
    `  ${label}: ${diff >= 0 ? '+' : ''}${diff.toFixed(3)} 秒/周` +
      `（A 平均 ${formatTime(a.average)} / B 平均 ${formatTime(b.average)}, ${laps}周）${mark}`,
  );
  return diff;
}

test('1. ストレート主体では final_02（最高速寄り）が final_01（加速寄り）より速い', () => {
  const laps = 10;
  const a = race({ extra: [part('drivetrain_final_02')], courseId: STRAIGHT, laps });
  const b = race({ extra: [part('drivetrain_final_01')], courseId: STRAIGHT, laps });
  const diff = report('final_02 − final_01 @ ながさわ', a, b);
  assert.ok(diff > 0, 'final_02 が速いはず');
});

test('2. コーナー主体では final_01（加速寄り）が final_02（最高速寄り）より速い', () => {
  const laps = 10;
  const a = race({ extra: [part('drivetrain_final_01')], courseId: CORNER, laps });
  const b = race({ extra: [part('drivetrain_final_02')], courseId: CORNER, laps });
  const diff = report('final_01 − final_02 @ みさき', a, b);
  assert.ok(diff > 0, 'final_01 が速いはず');
});

test('3. aero_02 はコーナー主体で速くなり、ストレート主体で遅くなる', () => {
  const laps = 10;
  const aero = part('aero_weight_aero_02');

  const cornerWith = race({ extra: [aero], courseId: CORNER, laps });
  const cornerWithout = race({ courseId: CORNER, laps });
  const gain = report('aero_02 あり − なし @ みさき', cornerWith, cornerWithout);
  assert.ok(gain > 0, 'コーナー主体では速くなるはず');

  const straightWith = race({ extra: [aero], courseId: STRAIGHT, laps });
  const straightWithout = race({ courseId: STRAIGHT, laps });
  const loss = report('aero_02 なし − あり @ ながさわ', straightWithout, straightWith);
  assert.ok(loss > 0, 'ストレート主体では遅くなるはず');
});

test('4. ソフトタイヤは5周ならハードより速いが、25周ではハードが逆転する', () => {
  const soft = ['tire_compound_03'];
  const hard = ['tire_compound_01'];

  const soft5 = race({ parts: soft, courseId: BALANCED, laps: 5 });
  const hard5 = race({ parts: hard, courseId: BALANCED, laps: 5 });
  const shortDiff = report('ソフト − ハード @ ひばり平 5周', soft5, hard5);
  assert.ok(shortDiff > 0, '5周ならソフトが速いはず');

  const soft25 = race({ parts: soft, courseId: BALANCED, laps: 25 });
  const hard25 = race({ parts: hard, courseId: BALANCED, laps: 25 });
  const longDiff = report('ハード − ソフト @ ひばり平 25周', hard25, soft25);
  assert.ok(longDiff > 0, '25周ならハードが速いはず');

  const crossover = soft25.laps.findIndex((lap, i) => lap.time > hard25.laps[i].time) + 1;
  console.log(`  逆転する周: ${crossover || 'なし'}周目（ソフト最終周 ${formatTime(soft25.laps[24].time)} / ハード最終周 ${formatTime(hard25.laps[24].time)}）`);
});

test('5. balance が preferred_balance から離れるほどラップタイムが落ちる', () => {
  const laps = 5;
  const preferred = haruka.preferred_balance;
  const deviations = [0, 2, 4, 6];
  const totals = deviations.map((dev) => {
    const synthetic = { id: `balance_dev_${dev}`, effects: { balance: preferred + dev }, side_effects: {} };
    return race({ extra: [synthetic], courseId: BALANCED, laps }).total;
  });
  for (let i = 1; i < totals.length; i++) {
    const perLap = (totals[i] - totals[i - 1]) / laps;
    console.log(`  ズレ ${deviations[i - 1]} → ${deviations[i]}: +${perLap.toFixed(3)} 秒/周`);
    assert.ok(totals[i] > totals[i - 1], `ズレ ${deviations[i]} はズレ ${deviations[i - 1]} より遅いはず`);
  }
  const span = (totals[totals.length - 1] - totals[0]) / laps;
  console.log(`  ズレ 0 → 6 の合計差: +${span.toFixed(3)} 秒/周`);
});

test('6. 同じ −8 でも unsprung_weight の方が weight より速い', () => {
  const laps = 10;
  const sprung = { id: 'test_weight', effects: { weight: -8 }, side_effects: {} };
  const unsprung = { id: 'test_unsprung', effects: { unsprung_weight: -8 }, side_effects: {} };
  const a = race({ extra: [unsprung], courseId: BALANCED, laps });
  const b = race({ extra: [sprung], courseId: BALANCED, laps });
  const diff = report('unsprung −8 − weight −8 @ ひばり平', a, b);
  assert.ok(diff > 0, 'ばね下軽量化の方が速いはず');
});

test('7. brake_rotor_01 はひばり平5周では基準車より遅いが、コーナー主体25周では速い', () => {
  const rotor = part('brake_rotor_01');

  const shortWith = race({ extra: [rotor], courseId: BALANCED, laps: 5 });
  const shortWithout = race({ courseId: BALANCED, laps: 5 });
  const shortDiff = report('基準車 − ローター @ ひばり平 5周', shortWithout, shortWith);
  assert.ok(shortDiff > 0, '短いレースではばね下重量の分だけ遅いはず');

  const longWith = race({ extra: [rotor], courseId: CORNER, laps: 25 });
  const longWithout = race({ courseId: CORNER, laps: 25 });
  const longDiff = report('ローター − 基準車 @ みさき 25周', longWith, longWithout);
  assert.ok(longDiff > 0, 'ブレーキの厳しい長いレースではフェードの差で速いはず');

  const last = longWithout.laps[24];
  console.log(`  基準車のブレーキ温度 最終周 ${last.brakeTemp.toFixed(0)}（フェード −${last.brakeFade.toFixed(1)} pt）/ ローター車 ${longWith.laps[24].brakeTemp.toFixed(0)}（−${longWith.laps[24].brakeFade.toFixed(1)} pt）`);
});

test('8. スロット: 前後スタビは別スロットなので同時装着でき、balance が相殺される', () => {
  const front = part('suspension_stabi_01');   // balance -3
  const rear = part('suspension_stabi_02');    // balance +3
  assert.equal(front.slot, 'stabi_front');
  assert.equal(rear.slot, 'stabi_rear');

  const both = buildPerformance([part('tire_compound_02'), front, rear], haruka, sedan);
  assert.equal(both.stats.balance, 0, '前後を揃えれば balance は 0 になるはず');

  const onlyFront = buildPerformance([part('tire_compound_02'), front], haruka, sedan);
  assert.equal(onlyFront.stats.balance, -3);
  console.log(`  フロントのみ balance ${onlyFront.stats.balance} / 前後セット balance ${both.stats.balance}`
    + `（好み ${haruka.preferred_balance}）`);

  // 同じスロットの2点は同時装着できない
  assert.throws(() => buildPerformance([part('brake_pad_01'), part('brake_pad_02')], haruka, sedan),
    /スロット "pad" が重複/);
  // ユニット部品は占有スロットを塞ぐ
  assert.deepEqual(occupiedSlots(part('engine_works_01')), SLOTS.engine);
  assert.throws(() => buildPerformance([part('engine_works_01'), part('engine_intake_01')], haruka, sedan),
    /スロット "intake" が重複/);

  // スロット → パーツ の対応表でも渡せる
  const byArray = buildPerformance([part('tire_compound_02'), front, rear], haruka, sedan);
  const byMap = buildPerformance(
    { compound: part('tire_compound_02'), stabi_front: front, stabi_rear: rear }, haruka, sedan);
  assert.deepEqual(byMap.stats, byArray.stats);
  assert.equal(resolveLoadout({ pad: null, rotor: undefined }).length, 0);
});

test('9. スロット: 内装・外板・ホイールは別スロットなので併用でき、重量が合算される', () => {
  const interior = part('aero_weight_light_01');   // 内装剥がし     weight -12
  const wheel = part('aero_weight_light_02');      // 軽量ホイール   unsprung_weight -8
  const body = part('aero_weight_light_04');       // カーボン外板   weight -35
  assert.equal(interior.slot, 'interior');
  assert.equal(wheel.slot, 'wheel');
  assert.equal(body.slot, 'body');

  const all = buildPerformance([part('tire_compound_02'), interior, wheel, body], haruka, sedan);
  assert.equal(all.stats.weight, -47, '内装 −12 と外板 −35 が合算されるはず');
  assert.equal(all.stats.unsprung_weight, -8, 'ホイールはばね下に乗る');

  // 有効重量はセクターで違う（ばね下はコーナーで5倍相当）
  assert.equal(all.weightEff.straight, -55);
  assert.equal(all.weightEff.fast_corner, -87);
  console.log(`  3点併用: weight ${all.stats.weight} / ばね下 ${all.stats.unsprung_weight}`
    + ` → 有効重量 直線 ${all.weightEff.straight} / コーナー ${all.weightEff.fast_corner}`);

  // 大幅軽量化は interior と body をまとめて占有するので、上の2点とは同時装着できない
  const heavyCut = part('aero_weight_light_03');
  assert.deepEqual(occupiedSlots(heavyCut), ['interior', 'body']);
  assert.throws(() => buildPerformance([heavyCut, interior], haruka, sedan), /スロット "interior" が重複/);
  assert.throws(() => buildPerformance([heavyCut, body], haruka, sedan), /スロット "body" が重複/);
  // ホイールと空力は別スロットなので大幅軽量化と併用できる
  const mixed = buildPerformance([heavyCut, wheel, part('aero_weight_aero_02')], haruka, sedan);
  assert.equal(mixed.stats.weight, -28 + 7);
  console.log(`  大幅軽量化 + ホイール + エアロ: weight ${mixed.stats.weight} / ばね下 ${mixed.stats.unsprung_weight}`);
});

test('補足: 乱数ありでも同じシードなら同じ結果、reliability が低いとリタイアが起きうる', () => {
  const perf = buildPerformance([part('tire_compound_02'), part('engine_turbo_02')], haruka, sedan);
  const r1 = simulateRace(perf, course(BALANCED), 30, haruka, { seed: 7 });
  const r2 = simulateRace(perf, course(BALANCED), 30, haruka, { seed: 7 });
  assert.deepEqual(r1, r2);

  let retired = 0;
  for (let seed = 1; seed <= 50; seed++) {
    if (simulateRace(perf, course(BALANCED), 30, haruka, { seed }).retired) retired++;
  }
  console.log(`  ビッグタービン（reliability −10）30周 × 50レース: リタイア ${retired} 回`);
  assert.ok(retired > 0 && retired < 50, 'リタイアは起きるが毎回ではないはず');
});
