/**
 * お金・購入・消耗・セーブのテスト。
 *   node --test src/engine/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  owns, buyBlocker, buy, sell, sellPrice, prizeFor, entryFee, sponsorFee,
  condition, wearPerRace, effectScale, applyWear, repairCost, repair, applyRaceWear,
} from './economy.js';
import { encode, decode, newGame, searchWithState, stateFromSearch, SAVE_VERSION } from './save.js';
import { buildPerformance } from './race.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
const ECONOMY = load('economy.json');
const PARTS = load('parts.json');
const CHASSIS = load('chassis.json');
const DRIVERS = load('drivers.json');
const part = (id) => PARTS.find((p) => p.id === id);
const haruka = DRIVERS[0];

test('E1. economy.json: 表の形。賞金は順位で単調に減り、クラスで増える', () => {
  for (const cls of [1, 2, 3, 4, 5]) {
    const table = ECONOMY.prize[cls];
    assert.ok(Array.isArray(table) && table.length >= 8, `クラス${cls} の賞金表`);
    for (let i = 1; i < table.length; i++) assert.ok(table[i] <= table[i - 1], `クラス${cls} ${i + 1}位 ≤ ${i}位`);
    assert.ok(ECONOMY.entry_fee[cls] > 0 && ECONOMY.laps[cls] > 0);
  }
  for (let cls = 2; cls <= 5; cls++) assert.ok(ECONOMY.prize[cls][0] > ECONOMY.prize[cls - 1][0], '上のクラスほど賞金が大きい');
  assert.equal(ECONOMY.points.length, 8);
  assert.ok(ECONOMY.sponsor_fee.length === 5 && ECONOMY.sponsor_fee[0] === 0, '段階0は自腹');
  // クラス1の初期資金で中古パーツが2〜3点
  const cheap = PARTS.filter((p) => p.class_required === 1 && p.sponsor_tier === 0).map((p) => p.price).sort((a, b) => a - b);
  const afford = cheap.reduce((n, price, i) => (cheap.slice(0, i + 1).reduce((a, b) => a + b, 0) <= ECONOMY.initial_money ? i + 1 : n), 0);
  assert.ok(afford >= 2 && afford <= 4, `初期資金で買える中古パーツ ${afford} 点（2〜3点のはず）`);
  console.log(`  初期資金 ¥${ECONOMY.initial_money.toLocaleString()} で中古パーツ ${afford} 点。クラス1の賞金 ${ECONOMY.prize[1].join('/')}`);
});

test('E2. 購入と売却：買えない理由、所持金の増減、売ると装着から外れる', () => {
  let s = newGame(ECONOMY);
  const intake = part('engine_intake_01');   // cls1 tier0
  const lsd = part('drivetrain_lsd_01');      // cls3 tier1
  assert.equal(buyBlocker(s, intake), null);
  assert.equal(buyBlocker(s, lsd), 'class', '規定で買えない');
  s = buy(s, intake);
  assert.ok(owns(s, intake.id) && s.money === ECONOMY.initial_money - intake.price);
  assert.equal(s.cond[intake.id], intake.durability, '買った直後は満タン');
  assert.equal(buyBlocker(s, intake), 'owned', '二重に買わない');
  const broke = { ...s, money: 0 };
  assert.equal(buyBlocker(broke, part('engine_exhaust_01')), 'money');
  assert.throws(() => buy(broke, part('engine_exhaust_01')));

  s = { ...s, setup: { race: { parts: [intake.id], settings: {} }, quali: null } };
  const sold = sell(s, intake, ECONOMY);
  assert.equal(sold.money, s.money + sellPrice(ECONOMY, intake));
  assert.ok(!owns(sold, intake.id) && !sold.setup.race.parts.includes(intake.id), '売ると外れる');
  assert.equal(sellPrice(ECONOMY, intake), Math.round(intake.price * 0.4), '売値は4割');
});

test('E3. 収支：賞金は順位別、リタイアは0。参加費とスポンサー料', () => {
  assert.equal(prizeFor(ECONOMY, 1, 1), ECONOMY.prize[1][0]);
  assert.ok(prizeFor(ECONOMY, 1, 8) > 0 && prizeFor(ECONOMY, 1, 9) === 0);
  assert.equal(prizeFor(ECONOMY, 1, 1, true), 0, 'リタイアは賞金なし');
  assert.equal(entryFee(ECONOMY, 3), ECONOMY.entry_fee[3]);
  assert.equal(sponsorFee(ECONOMY, 0), 0);
  assert.ok(sponsorFee(ECONOMY, 2) > sponsorFee(ECONOMY, 1));
});

test('E4. 消耗：reliability が低いほど速く減り、リタイアで跳ねる。閾値を切ると効果が落ち、0 で故障', () => {
  const normal = wearPerRace(ECONOMY, 0);
  assert.ok(wearPerRace(ECONOMY, -10) > normal, '信頼性が低いと速く減る');
  assert.equal(wearPerRace(ECONOMY, 5), normal, '信頼性が高くても基準より遅くはならない');
  assert.ok(wearPerRace(ECONOMY, 0, true) > normal * 2, 'リタイアで跳ねる');

  const th = ECONOMY.wear.threshold;
  assert.equal(effectScale(ECONOMY, 100), 1);
  assert.equal(effectScale(ECONOMY, th), 1, '閾値ちょうどは100%');
  assert.ok(effectScale(ECONOMY, th / 2) < 1 && effectScale(ECONOMY, th / 2) > 0.5);
  assert.equal(effectScale(ECONOMY, 0), 0, '0 は故障');

  const turbo = part('engine_turbo_01');
  const worn = applyWear(ECONOMY, turbo, 0);
  assert.equal(worn.effects.power, 0, '故障したら効果なし');
  assert.equal(worn.side_effects.weight, turbo.side_effects.weight, '副作用は残る');
  assert.equal(applyWear(ECONOMY, turbo, turbo.durability), turbo, '満タンならそのもの');

  // 計算に乗ること：故障したタービンの車は、健全な車より遅い
  const gt = CHASSIS.gt;
  const fresh = buildPerformance([turbo], haruka, gt);
  const broken = buildPerformance([worn], haruka, gt);
  assert.ok(broken.stats.power < fresh.stats.power);
  assert.equal(broken.stats.weight, fresh.stats.weight, '重さはそのまま');
});

test('E5. 修理：減った割合に比例。レース後の消耗は装着していた所有パーツだけ', () => {
  const turbo = part('engine_turbo_01');
  assert.equal(repairCost(ECONOMY, turbo, turbo.durability), 0, '満タンは0');
  const half = repairCost(ECONOMY, turbo, turbo.durability / 2);
  assert.ok(half > 0 && half < turbo.price, '半分減って買値より安い');
  assert.ok(repairCost(ECONOMY, turbo, 0) > half, '減るほど高い');

  let s = { ...newGame(ECONOMY), money: 5000000, cls: 4, tier: 3 };
  s = buy(s, turbo);
  const intake = part('engine_intake_01');   // 持っていない
  const { state: after, worn } = applyRaceWear(s, [turbo, intake], -8, false, ECONOMY);
  assert.equal(worn.length, 1, '持っていないパーツは減らない');
  assert.ok(condition(after, turbo) < turbo.durability);
  const { state: crashed } = applyRaceWear(s, [turbo], -8, true, ECONOMY);
  assert.ok(condition(crashed, turbo) < condition(after, turbo), 'リタイアのほうが減る');

  const fixed = repair(after, turbo, ECONOMY);
  assert.equal(condition(fixed, turbo), turbo.durability);
  assert.equal(fixed.money, after.money - repairCost(ECONOMY, turbo, condition(after, turbo)));
  console.log(`  タービン：1レースで −${(turbo.durability - condition(after, turbo)).toFixed(1)}、リタイアで −${(turbo.durability - condition(crashed, turbo)).toFixed(1)}、修理 ¥${repairCost(ECONOMY, turbo, condition(after, turbo)).toLocaleString()}`);
});

test('E6. セーブ：encode → decode で元に戻る。URL に載る。壊れた文字列は null', () => {
  const s = {
    ...newGame(ECONOMY), money: 123456, cls: 2, tier: 1,
    owned: ['engine_intake_01', 'tire_compound_02'], cond: { engine_intake_01: 87.5 },
    setup: { race: { parts: ['engine_intake_01'], settings: { tire_pressure: 2.2 } }, quali: null },
    season: { year: 2, rounds: [{ course: 'misaki', laps: 8, result: { pos: 3, points: 6, prize: 15000, fee: 4000, sponsorFee: 0, repair: 1200, retired: false, best: 91.2 } }], next: 1, points: { me: 6, ai0: 10 }, symptoms: { understeer: 2 }, note: null },
    sponsor: { tier: 1, id: 'local_garage' },
  };
  const str = encode(s);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(str), 'base64url だけ');
  assert.deepEqual(decode(str), s);
  assert.equal(decode('!!!'), null);
  assert.equal(decode(''), null);
  const future = Buffer.from(JSON.stringify({ v: SAVE_VERSION + 1, m: 1 })).toString('base64url');
  assert.equal(decode(future), null, '未来の形式は読まない');
  const search = searchWithState(s, { session: 'race', grid: 'last' });
  const back = stateFromSearch(search);
  assert.deepEqual(back, s);
  assert.equal(new URLSearchParams(search).get('session'), 'race');
  console.log(`  state ${JSON.stringify(s).length} 文字 → URL ${str.length} 文字`);
});
