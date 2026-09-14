/**
 * シーズン進行のテスト。
 *   node --test src/engine/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  newSeason, currentRound, seasonOver, pointsFor, recordResult, standings, myRank,
  verdictFor, topSymptom, sponsorTierAfter, endSeason, pickNote, simulateField, coursesFor,
} from './season.js';
import { rivalSpec, fieldEntries, AI_PROFILES } from './rivals.js';
import { newGame } from './save.js';
import { buildPerformance, createRng } from './race.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
const ECONOMY = load('economy.json');
const COURSES = load('courses.json');
const PARTS = load('parts.json');
const CHASSIS = load('chassis.json');
const RIVALS = load('rivals.json');
const RADIO = load('radio.json');
const haruka = load('drivers.json')[0];
const part = (id) => PARTS.find((p) => p.id === id);

test('S1. 新しいシーズン：6戦、そのクラスで走れるコースだけ、周回はクラスごと', () => {
  const rng = createRng(7);
  for (const cls of [1, 3, 5]) {
    const season = newSeason(cls, COURSES, ECONOMY, rng);
    assert.equal(season.rounds.length, ECONOMY.rounds_per_season);
    const ok = new Set(coursesFor(COURSES, cls).map((c) => c.id));
    for (const r of season.rounds) {
      assert.ok(ok.has(r.course), `クラス${cls}で ${r.course} は走れない`);
      assert.equal(r.laps, ECONOMY.laps[cls]);
      assert.equal(r.result, null);
    }
    assert.equal(season.next, 0);
    assert.ok(currentRound(season) && !seasonOver(season));
  }
  const many = Array.from({ length: 20 }, (_, i) => newSeason(1, COURSES, ECONOMY, createRng(i)));
  assert.ok(many.some((s) => new Set(s.rounds.map((r) => r.course)).size < s.rounds.length), '同じコースが2回入ることもある');
});

test('S2. ポイント：1位10…8位1、9位以下とリタイアは0。記録すると次の戦へ進み、全車に積む', () => {
  assert.deepEqual([1, 2, 3, 8, 9].map((p) => pointsFor(ECONOMY, p)), [10, 8, 6, 1, 0]);
  assert.equal(pointsFor(ECONOMY, 1, true), 0);

  let s = { ...newGame(ECONOMY), season: newSeason(1, COURSES, ECONOMY, createRng(1)) };
  const classification = [
    { id: 'ai0', pos: 1, retired: false }, { id: 'me', pos: 2, retired: false },
    { id: 'ai1', pos: 3, retired: false }, { id: 'ai2', pos: 4, retired: true },
  ];
  s = recordResult(s, { classification, mine: { pos: 2, retired: false, prize: 19000, fee: 4000, sponsorFee: 0, repair: 0, best: 60 }, symptoms: { understeer: 2 } }, ECONOMY);
  assert.equal(s.season.next, 1);
  assert.equal(s.season.rounds[0].result.points, 8);
  assert.equal(s.season.rounds[0].result.prize, 19000);
  assert.deepEqual(s.season.points, { ai0: 10, me: 8, ai1: 6, ai2: 0 });
  assert.equal(s.season.symptoms.understeer, 2);
  const ids = ['me', 'ai0', 'ai1', 'ai2'];
  assert.equal(myRank(s.season, ids), 2);
  assert.equal(standings(s.season, ids)[0].id, 'ai0');
  // 元の state は変わらない
  const before = { ...newGame(ECONOMY), season: newSeason(1, COURSES, ECONOMY, createRng(1)) };
  recordResult(before, { classification, mine: { pos: 2, retired: false } }, ECONOMY);
  assert.equal(before.season.next, 0);
});

test('S3. 昇降格：上位で昇格、最下位付近で降格。クラス1からは下がらず、クラス5からは上がらない', () => {
  const ids = Array.from({ length: 8 }, (_, i) => (i === 0 ? 'me' : `ai${i}`));
  const mk = (cls, myPoints, others) => ({
    ...newGame(ECONOMY), cls,
    season: { year: 1, rounds: [], next: 6, points: Object.fromEntries(ids.map((id, i) => [id, id === 'me' ? myPoints : others[i - 1]])), symptoms: {} },
  });
  const top = mk(1, 50, [40, 30, 20, 10, 5, 3, 1]);
  assert.equal(verdictFor(top, ids, ECONOMY).verdict, 'promote');
  assert.equal(verdictFor(top, ids, ECONOMY).to, 2);
  const bottom = mk(2, 0, [40, 30, 20, 10, 5, 3, 1]);
  assert.equal(verdictFor(bottom, ids, ECONOMY).verdict, 'relegate');
  assert.equal(verdictFor(bottom, ids, ECONOMY).to, 1);
  assert.equal(verdictFor(mk(1, 0, [40, 30, 20, 10, 5, 3, 1]), ids, ECONOMY).verdict, 'stay', 'クラス1からは下がらない');
  assert.equal(verdictFor(mk(5, 99, [1, 1, 1, 1, 1, 1, 1]), ids, ECONOMY).verdict, 'stay', 'クラス5からは上がらない');
  // 8台・クラス2：昇格線は4位、降格は下から2台。6位は残留、4位は昇格
  const mid = mk(2, 4, [40, 30, 20, 10, 5, 3, 1]);
  const v = verdictFor(mid, ids, ECONOMY);
  assert.equal(v.rank, 6);
  assert.equal(v.verdict, 'stay');
  assert.equal(verdictFor(mk(2, 15, [40, 30, 20, 10, 5, 3, 1]), ids, ECONOMY).verdict, 'promote', '4位は昇格線の内側');
});

test('S4. スポンサー段階は成績とクラスで上がり、下がらない。オフシーズンでノートに一行', () => {
  const full = (cls) => ({ year: 1, rounds: Array(6).fill({ result: {} }), next: 6, points: {}, symptoms: { understeer: 3, tire_wear: 1 } });
  assert.equal(sponsorTierAfter({ cls: 1, tier: 0, season: full(1) }, { to: 2, rank: 1 }), 1, 'クラス2昇格で1');
  assert.equal(sponsorTierAfter({ cls: 3, tier: 1, season: full(3) }, { to: 3, rank: 6 }), 2, 'クラス3完走で2');
  assert.equal(sponsorTierAfter({ cls: 4, tier: 2, season: full(4) }, { to: 4, rank: 3 }), 3, 'クラス4で3位以内なら3');
  assert.equal(sponsorTierAfter({ cls: 4, tier: 2, season: full(4) }, { to: 4, rank: 4 }), 2, '4位では上がらない');
  assert.equal(sponsorTierAfter({ cls: 4, tier: 3, season: full(4) }, { to: 5, rank: 1 }), 4, 'クラス5昇格で4');
  assert.equal(sponsorTierAfter({ cls: 2, tier: 3, season: full(2) }, { to: 1, rank: 8 }), 3, '降格しても下がらない');

  assert.equal(topSymptom(full(1)), 'understeer');
  assert.equal(topSymptom({ symptoms: {} }), null);
  const notes = RADIO.season_note;
  assert.ok(notes && notes.clean?.length >= 2, 'season_note.clean');
  for (const id of ['understeer', 'oversteer', 'tire_wear', 'brake_fade', 'straight_loss', 'corner_loss', 'retire_sign', 'cold_tire', 'fuel_low']) {
    assert.ok(notes[id]?.length >= 2, `season_note.${id} は2本以上`);
    for (const e of notes[id]) assert.ok(!(e.text ?? e).includes('ハルノート'));
  }
  assert.ok(typeof pickNote(notes, 'understeer', () => 0) === 'string');
  assert.ok(typeof pickNote(notes, 'nonexistent', () => 0) === 'string', '無い症状は clean');

  // シーズンを閉じると、次のシーズンが新しいクラスで組まれ、ノートが残る
  const ids = Array.from({ length: 8 }, (_, i) => (i === 0 ? 'me' : `ai${i}`));
  const s = { ...newGame(ECONOMY), cls: 1, tier: 0, season: { ...full(1), points: Object.fromEntries(ids.map((id) => [id, id === 'me' ? 50 : 1])) } };
  const sponsors = [{ id: 'x', tier: 1, name: 'テスト' }];
  const { state: next, verdict, note, sponsorChanged } = endSeason(s, ids, COURSES, ECONOMY, sponsors, () => 0, notes);
  assert.equal(verdict.verdict, 'promote');
  assert.equal(next.cls, 2);
  assert.equal(next.tier, 1);
  assert.ok(sponsorChanged && next.sponsor.id === 'x');
  assert.equal(next.season.year, 2);
  assert.equal(next.season.next, 0);
  assert.equal(next.season.note, note);
  assert.ok(note.length > 0);
  for (const r of next.season.rounds) assert.ok(coursesFor(COURSES, 2).some((c) => c.id === r.course));
  console.log(`  昇格後のノート：「${note}」`);
});

test('S5. AI 車と通し走行：性格ごとに得意が違い、着順が出る', () => {
  const rng = createRng(3);
  const mine = [part('tire_compound_02')];
  const sedan = CHASSIS.sedan;
  const spec = rivalSpec(RIVALS[0], 0, { mine, driver: haruka, chassis: sedan, settings: {}, rng });
  assert.equal(spec.id, 'ai0');
  assert.ok(spec.perf.stats.power !== undefined && spec.driver.skill >= 30);
  assert.ok(Object.keys(AI_PROFILES).includes(RIVALS[0].profile));
  const course = COURSES.find((c) => c.id === 'hibaridaira');
  assert.equal(fieldEntries(RIVALS, course, 1).length, course.grid[1] - 1);

  const myPerf = buildPerformance(mine, haruka, sedan);
  const runs = simulateField({ myPerf, driver: haruka, mine, chassis: sedan, settings: {}, course, laps: 5, rivals: RIVALS, cls: 1, seed: 5 });
  assert.equal(runs.length, course.grid[1]);
  assert.deepEqual(runs.map((r) => r.pos), runs.map((_, i) => i + 1));
  assert.ok(runs.some((r) => r.id === 'me'));
  const finished = runs.filter((r) => !r.retired);
  for (let i = 1; i < finished.length; i++) assert.ok(finished[i].total >= finished[i - 1].total, '総時間の順');
  console.log(`  ひばり平 5周（クラス1、8台）：自車 ${runs.find((r) => r.id === 'me').pos} 位`);
});
