/**
 * 自由設定（タイムアタック）のテスト。docs/設計/自由設定.md。
 *
 *   node --test src/engine/free.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  OVERRIDE, clampFactor, hasOverride, overridePart, applyOverrides, packOverrides,
  runAttack, WARMUP_LAPS, readFree, writeFree, putBest, emptyFree, FREE_SLOT, NOTE_MAX,
  harukaLine, mainParts, pushNote, NOTE_PARTS, NOTE_LINE_MAX,
} from './free.js';
import { buildPerformance } from './race.js';
import { encode, decode, newGame, LOCAL_KEY, SAVE_KEY } from './save.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
const PARTS = load('parts.json');
const CHASSIS = load('chassis.json');
const COURSES = load('courses.json');
const DRIVERS = load('drivers.json');
const ECONOMY = load('economy.json');
const part = (id) => PARTS.find((p) => p.id === id);

test('F1. 上書きは ±50% に収まる。素のままの倍率は記録に残さない', () => {
  assert.deepEqual([OVERRIDE.min, OVERRIDE.max], [0.5, 1.5]);
  // 範囲の外は端で止まる
  assert.equal(clampFactor(2), 1.5);
  assert.equal(clampFactor(0), 0.5);
  assert.equal(clampFactor(-3), 0.5);
  assert.equal(clampFactor(1.2), 1.2);
  // 数でないものは素のまま（1）
  for (const v of [undefined, null, '', 'abc', NaN, Infinity]) assert.equal(clampFactor(v), 1, String(v));

  assert.equal(hasOverride(null), false);
  assert.equal(hasOverride({ effects: { power: 1 } }), false, '倍率1は上書きではない');
  assert.equal(hasOverride({ effects: { power: 1.5 } }), true);

  // **保存する形には、素のままの倍率を残さない**
  const packed = packOverrides({
    a: { effects: { power: 1, weight: 1.5 }, side_effects: { heat: 1 } },
    b: { effects: { power: 1 } },
    c: { side_effects: { reliability: 0.5 } },
  });
  assert.deepEqual(packed, { a: { effects: { weight: 1.5 } }, c: { side_effects: { reliability: 0.5 } } });
  // 範囲の外も畳むときに収まる
  assert.deepEqual(packOverrides({ a: { effects: { power: 9 } } }), { a: { effects: { power: 1.5 } } });
});

test('F2. 上書きは元の部品を変えず、buildPerformance の結果に出る', () => {
  const works = part('engine_works_01');
  const before = JSON.parse(JSON.stringify(works));
  const over = { effects: { power: 1.5 }, side_effects: { reliability: 1.5 } };

  const bent = overridePart(works, over);
  assert.deepEqual(works, before, '元の部品が書き換わっている');
  assert.equal(bent.effects.power, works.effects.power * 1.5);
  assert.equal(bent.effects.top_end_power, works.effects.top_end_power, '触っていないキーは素のまま');
  // **負の値は罰が重くなる向きに伸びる**（信頼性 −8 → −12）
  assert.ok(works.side_effects.reliability < 0);
  assert.equal(bent.side_effects.reliability, works.side_effects.reliability * 1.5);

  // 素のままなら同じものを返す（写しを作らない）
  assert.equal(overridePart(works, {}), works);
  assert.equal(overridePart(works, { effects: { power: 1 } }), works);

  // 性能に出る
  const driver = DRIVERS[0];
  const chassis = CHASSIS.formula;
  const plain = buildPerformance([works], driver, chassis, {});
  const up = buildPerformance(applyOverrides([works], { [works.id]: { effects: { power: 1.5 } } }), driver, chassis, {});
  const down = buildPerformance(applyOverrides([works], { [works.id]: { effects: { power: 0.5 } } }), driver, chassis, {});
  assert.ok(up.stats.power > plain.stats.power, '上げたのに出力が増えていない');
  assert.ok(down.stats.power < plain.stats.power, '下げたのに出力が減っていない');
  // 効果は ±50% ぶんだけ動く（部品の効果の半分）
  assert.ok(Math.abs((up.stats.power - plain.stats.power) - works.effects.power * 0.5) < 1e-9);
  // 副作用も同じように動く
  const risky = buildPerformance(applyOverrides([works], { [works.id]: { side_effects: { reliability: 1.5 } } }), driver, chassis, {});
  assert.ok(risky.stats.reliability < plain.stats.reliability, '副作用を伸ばしたのに信頼性が落ちていない');
  console.log(`  ワークスエンジン：出力 ${plain.stats.power.toFixed(0)} → 上書き +50% で ${up.stats.power.toFixed(0)} / −50% で ${down.stats.power.toFixed(0)}`);
});

test('F3. 1本走る：アウトラップを捨てて計測し、信頼性が低ければ壊れる', () => {
  const course = COURSES.find((c) => c.id === 'misaki');
  const driver = DRIVERS[0];
  const perf = buildPerformance([], driver, CHASSIS.hatchback, {});

  const one = runAttack(perf, course, driver, { laps: 1, seed: 3 });
  assert.equal(one.laps.length, 1, '1周の計測');
  assert.equal(one.warmup.length, WARMUP_LAPS, 'アウトラップを1周ころがす');
  assert.equal(one.complete, true);
  assert.ok(Number.isFinite(one.best) && one.best > 0);
  assert.equal(one.laps[0].lap, 1, '計測の1周目から数える');
  assert.ok(Array.isArray(one.laps[0].sectors) && one.laps[0].sectors.length === course.sectors.length,
    'セクター別のタイムがある');
  assert.ok(one.laps[0].sectors.every((t) => t > 0), 'セクターのタイムが正');
  // 腕のブレを切れば、セクターの和がそのままラップタイムになる
  const clean = runAttack(perf, course, driver, { laps: 1, seed: 3, noise: false });
  assert.ok(Math.abs(clean.laps[0].sectors.reduce((a, b) => a + b, 0) - clean.laps[0].time) < 1e-6,
    'セクターの和がラップタイム');

  const three = runAttack(perf, course, driver, { laps: 3, seed: 3 });
  assert.equal(three.laps.length, 3);
  assert.ok(Math.abs(three.total - three.laps.reduce((a, l) => a + l.time, 0)) < 1e-9);
  assert.ok(three.best <= three.laps[0].time);
  // **フライング計測**：温まった状態で測るので、アウトラップ込みの素の1周目より速い
  assert.ok(one.best < three.warmup[0].time, `アウトラップ ${three.warmup[0].time.toFixed(3)} より速いはず`);

  // 同じ種なら同じ結果
  assert.equal(runAttack(perf, course, driver, { laps: 1, seed: 3 }).best, one.best);

  // **信頼性が大きく負なら壊れる。** 上書きで副作用を伸ばした構成で確かめる
  const works = part('engine_works_01');
  const wild = applyOverrides([works], { [works.id]: { side_effects: { reliability: 1.5 } } });
  const wildPerf = buildPerformance(wild, driver, CHASSIS.formula, {});
  assert.ok(wildPerf.stats.reliability < 0, 'この構成は信頼性が負');
  let broke = 0;
  for (let seed = 1; seed <= 60; seed += 1) {
    if (runAttack(wildPerf, course, driver, { laps: 3, seed }).retired) broke += 1;
  }
  assert.ok(broke > 0, `信頼性 ${wildPerf.stats.reliability.toFixed(1)} でも一度も壊れない`);
  console.log(`  みさき：1周 ${one.best.toFixed(3)}秒（アウトラップ ${three.warmup[0].time.toFixed(3)}）`
    + `　信頼性 ${wildPerf.stats.reliability.toFixed(1)} の構成は 60本中 ${broke} 本リタイア`);
});

test('F4. ベストは速くなったときだけ差し替わる。記録は localStorage の区画だけに入る', () => {
  let free = emptyFree();
  assert.deepEqual(free, { best: {}, note: [] });

  const mk = (time) => ({ time, laps: 1, parts: ['tire_compound_02'], over: {}, settings: {}, at: 0 });
  let r = putBest(free, 'misaki', mk(60));
  assert.equal(r.updated, true);
  assert.equal(r.prev, null);
  free = r.free;

  r = putBest(free, 'misaki', mk(61));
  assert.equal(r.updated, false, '遅いタイムで上書きしている');
  assert.equal(r.free.best.misaki.time, 60);

  r = putBest(free, 'misaki', mk(60));
  assert.equal(r.updated, false, '同じタイムは更新ではない');

  r = putBest(free, 'misaki', mk(59.5));
  assert.equal(r.updated, true);
  assert.equal(r.prev.time, 60, '前のベストを返す');
  free = r.free;
  // コースごとに別
  free = putBest(free, 'asahina', mk(40)).free;
  assert.deepEqual(Object.keys(free.best).sort(), ['asahina', 'misaki']);

  // **読み書きは localStorage の区画。進行（URL の s=）には一切入らない**
  const local = writeFree({ prologueSeen: true }, free);
  assert.equal(local.prologueSeen, true, '他の区画を消している');
  assert.deepEqual(readFree(local).best.misaki.time, 59.5);
  assert.deepEqual(readFree(null), { best: {}, note: [] }, '無ければ空');
  assert.deepEqual(readFree({ free: { best: 'こわれている' } }), { best: {}, note: [] });
  assert.notEqual(LOCAL_KEY, SAVE_KEY, '進行と別の鍵');
  assert.equal(FREE_SLOT, 'free');

  // E7：記録をいくら積んでも保存文字列の長さは変わらない
  const g = newGame(ECONOMY);
  const before = encode(g).length;
  for (let i = 0; i < 100; i += 1) free = putBest(free, `c${i}`, mk(30 + i)).free;
  assert.equal(encode(g).length, before, '記録が進行に混ざっている');
  assert.ok(encode(g).length <= 4000);
  // 進行を通しても記録は付いてこない
  assert.equal(decode(encode(g)).free, undefined);
  console.log(`  ベスト ${Object.keys(free.best).length} 件を積んでも保存文字列は ${before} 字のまま　ノート上限 ${NOTE_MAX} 行`);
});

test('F5. ハルカのノート：ベストの一行と、プレイヤーの一行。50行で止まる', () => {
  const works = part('engine_works_01');
  const tyre = part('tire_compound_02');
  const bias = part('brake_bias_01');

  // **形式は「コース　タイム　主な部品」。数字を出してよい**（ノートの字。無線ではない）
  const line = harukaLine('ながさわ高速周回路', 74.3628, [tyre, works, bias]);
  assert.match(line, /^ながさわ高速周回路　1:14\.363　/);
  assert.ok(line.includes(works.name), '効きの大きい部品が入っていない');
  assert.ok(/[0-9]/.test(line), 'ノートの一行に数字が無い');
  // 部品が無ければ「素のまま」
  assert.equal(harukaLine('みさき山道コース', 60, []), 'みさき山道コース　1:00.000　素のまま');
  // 並べるのは多くても3点
  const many = PARTS.filter((p) => p.class_required <= 2).slice(0, 8);
  assert.ok(mainParts(many).length <= NOTE_PARTS);
  // 効きの大きい順
  const ordered = mainParts([bias, works], 2);
  assert.equal(ordered[0], works.name, '効きの大きいほうが先');

  // --- 足し方と上限 --------------------------------------------------------
  let free = emptyFree();
  free = pushNote(free, { who: 'haruka', text: line, at: 1 });
  free = pushNote(free, { who: 'player', text: '  タイヤは 前を1段 柔らかく  ', at: 2 });
  assert.equal(free.note.length, 2);
  assert.deepEqual(free.note.map((n) => n.who), ['haruka', 'player']);
  assert.equal(free.note[1].text, 'タイヤは 前を1段 柔らかく', '前後の空白を落として1つに畳む');
  // 空の行は足さない
  assert.equal(pushNote(free, { who: 'player', text: '   ' }).note.length, 2);
  assert.equal(pushNote(free, { who: 'player', text: null }).note.length, 2);
  // 知らない who はハルカ扱いにしない（player 以外はハルカ）
  assert.equal(pushNote(free, { who: 'だれか', text: 'x' }).note.at(-1).who, 'haruka');

  // **50行で止まり、古い順に消える**
  let big = emptyFree();
  for (let i = 1; i <= NOTE_MAX + 20; i += 1) big = pushNote(big, { who: 'haruka', text: `${i}行目`, at: i });
  assert.equal(big.note.length, NOTE_MAX, `${NOTE_MAX} 行で止まっていない`);
  assert.equal(big.note[0].text, `${20 + 1}行目`, '古いほうから消えていない');
  assert.equal(big.note.at(-1).text, `${NOTE_MAX + 20}行目`, '新しい行が末尾');
  // 上限まで積んでも進行には入らない
  const g = newGame(ECONOMY);
  const before = encode(g).length;
  writeFree(null, big);
  assert.equal(encode(g).length, before);
  assert.ok(NOTE_LINE_MAX === 40, 'プレイヤーの一行は40字');
  console.log(`  ノート：「${line}」　${NOTE_MAX} 行で古い順に消える`);
});
