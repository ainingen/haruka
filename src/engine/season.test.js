/**
 * シーズン進行のテスト。
 *   node --test src/engine/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  newSeason, currentRound, seasonOver, pointsFor, recordResult, standings, myRank,
  verdictFor, topSymptom, sponsorTierAfter, endSeason, pickNote, simulateField, coursesFor,
  seasonEvents, SEASON_EVENTS, titleClinched, winSceneDue,
} from './season.js';
import { rivalSpec, fieldEntries, AI_PROFILES, AI_STRENGTH, aiLegal, baselineFor, seasonRivalPlan, rivalLoadout, notePortion, aiNotes } from './rivals.js';
import {
  ENDURANCE, PIT, enduranceTank, enduranceFuel, fuelPerLap, canRunLap, advanceFuel, refuel,
  setupEndurance, pitStop, pitStopSeconds, createPitCall, pressPitCall, lapsePitCall,
  createRunner, runField, planLap, stepField, rankRunners, createClock, courseLoad, progress,
  occupiedSlots,
} from './race.js';
import {
  newGame, encode, decode, markScene, trimTo,
  LINE_MAX, NAME_MAX, DEFAULT_LINE, DEFAULT_NAME, PROLOGUE_CHOICES,
} from './save.js';
import { runPrologue } from './prologue.js';
import { buildPerformance, createRng, simulateRace, WEIGHTS } from './race.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
const ECONOMY = load('economy.json');
const COURSES = load('courses.json');
const PARTS = load('parts.json');
const CHASSIS = load('chassis.json');
const RIVALS = load('rivals.json');
const RADIO = load('radio.json');
const CLASS_CHASSIS = { 1: 'hatchback', 2: 'hatchback', 3: 'sedan', 4: 'gt', 5: 'formula' };
const NOTES = load('notes.json');
const BASELINE = load('ai-baseline.json');
const haruka = load('drivers.json')[0];
const part = (id) => PARTS.find((p) => p.id === id);

test('S1. 新しいシーズン：6戦、そのクラスで走れるコースだけ、周回はクラスごと', () => {
  const rng = createRng(7);
  for (const cls of [1, 3, 5]) {
    const season = newSeason(cls, COURSES, ECONOMY, rng);
    assert.equal(season.rounds.length, ECONOMY.rounds_per_season);
    const ok = new Set(coursesFor(COURSES, cls).map((c) => c.id));
    season.rounds.forEach((r, i) => {
      assert.ok(ok.has(r.course), `クラス${cls}で ${r.course} は走れない`);
      // **第4戦だけ耐久戦。** 周回数が2倍になる（docs/設計/ピットストップ.md）
      const endurance = i === ENDURANCE.round - 1;
      assert.equal(!!r.endurance, endurance, `第${i + 1}戦の耐久の印`);
      assert.equal(r.laps, ECONOMY.laps[cls] * (endurance ? ENDURANCE.lapFactor : 1));
      assert.equal(r.result, null);
    });
    assert.equal(season.rounds.filter((r) => r.endurance).length, 1, '耐久はシーズンに1戦だけ');
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

test('S5. AI の構成は自車と無関係：遅いはノートの3割、並は7割、速いは全点＋性格のパーツ。すべて規定内', () => {
  const course = COURSES.find((c) => c.id === 'hibaridaira');
  const cls = 2;
  const entries = fieldEntries(RIVALS, course, cls);
  assert.equal(entries.length, course.grid[cls] - 1);
  const plan = seasonRivalPlan(entries, PARTS, cls, createRng(11));
  const note = NOTES.find((n) => n.course === course.id && n.class === cls);
  const seen = { slow: 0, normal: 0, fast: 0 };
  entries.forEach((entry, i) => {
    const lo = rivalLoadout(entry, i, plan, PARTS, NOTES, course, cls);
    for (const p of lo.parts) assert.ok(aiLegal(p, cls), `${entry.name} の ${p.id} は規定外`);
    const ids = lo.parts.map((p) => p.id);
    seen[entry.strength] += 1;
    // 遅い・並はノートの一部。安い順に頭から取るので、欠けるのは必ず高いほう
    if (entry.strength !== 'fast') {
      const frac = AI_STRENGTH[entry.strength].noteFrac;
      const want = entry.strength === 'slow'
        ? Math.max(1, Math.floor(note.parts.length * frac))
        : Math.round(note.parts.length * frac);
      assert.equal(ids.length, want, `${entry.strength} はノート${note.parts.length}点のうち${want}点`);
      for (const id of ids) assert.ok(note.parts.includes(id), 'ノートの外のパーツを積まない');
      const dropped = note.parts.filter((id) => !ids.includes(id)).map((id) => part(id).price);
      const kept = ids.map((id) => part(id).price);
      if (dropped.length) assert.ok(Math.max(...kept) <= Math.min(...dropped), '欠けるのは高いほうから');
      assert.deepEqual(lo.settings, note.settings, 'セッティングは金が要らないので全段階に付く');
    }
    if (entry.strength === 'fast') {
      const extras = plan[`ai${i}`];
      assert.ok(extras.length >= 2 && extras.length <= 3, '速いは2〜3点足す');
      const keys = AI_PROFILES[entry.profile].keys;
      for (const id of extras) {
        const p = PARTS.find((x) => x.id === id);
        assert.ok(keys.some((k) => (p.effects?.[k] ?? 0) > 0), `${p.id} は ${entry.profile} の性格に合わない`);
      }
      assert.ok(ids.length >= note.parts.length, '並より多い');
    }
  });
  assert.ok(seen.fast && seen.normal && seen.slow, '3段階とも名簿にいる');
  // 丸め：ノート5点なら遅い1点・並4点（切り捨て／四捨五入）
  const five = [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, price: n * 1000 }));
  assert.deepEqual(notePortion(five, AI_STRENGTH.slow).map((p) => p.id), ['p1']);
  assert.deepEqual(notePortion(five, AI_STRENGTH.normal).map((p) => p.id), ['p1', 'p2', 'p3', 'p4']);
  assert.equal(notePortion([{ id: 'p1', price: 1 }, { id: 'p2', price: 2 }], AI_STRENGTH.slow).length, 1, '2点でも遅いは1点');
  assert.deepEqual(notePortion(five, AI_STRENGTH.fast), five, '速いはノート全点');
  assert.deepEqual(seasonRivalPlan(entries, PARTS, cls, createRng(11)), plan, '種が同じなら同じ構成');
  const kaza = COURSES.find((c) => c.id === 'kazahaya');
  assert.equal(baselineFor(NOTES, PARTS, kaza, 5).note.class, 3, 'かざはやのクラス5は、クラス3のノートを借りる');

  // 走らせると着順が出る。自車の構成を変えても AI の**構成**は変わらない
  // （タイムは変わる。同じ場で走るので、グリッドとスタートの混雑を通して影響し合う）
  const sedan = CHASSIS.sedan;
  const spec = rivalSpec(RIVALS[0], 0, { loadout: { parts: [part('tire_compound_02')], settings: {} }, driver: haruka, chassis: sedan, rng: createRng(3) });
  assert.equal(spec.id, 'ai0');
  assert.ok(Object.keys(AI_PROFILES).includes(RIVALS[0].profile) && AI_STRENGTH[RIVALS[0].strength]);
  const bare = buildPerformance([], haruka, sedan);
  const rich = buildPerformance(note.parts.map(part), haruka, sedan, note.settings);
  const args = { driver: haruka, chassis: sedan, course, laps: 5, rivals: RIVALS, parts: PARTS, notes: NOTES, cls, seed: 5, rivalSeed: 11 };
  const runsBare = simulateField({ ...args, myPerf: bare });
  const runsRich = simulateField({ ...args, myPerf: rich });
  const aiParts = (runs) => runs.filter((r) => r.id !== 'me').map((r) => [r.id, r.partIds.join(',')]).sort();
  assert.deepEqual(aiParts(runsBare), aiParts(runsRich), '自車の構成を変えても AI の構成は同じ');
  // グリッドは予選の結果で決まり、後ろほどスタートが遅れる
  const grid = runsRich.map((r) => r.gridPos);
  assert.deepEqual([...grid].sort((a, b) => a - b), runsRich.map((_, i) => i + 1), '全車にグリッドが付く');
  const posBare = runsBare.find((r) => r.id === 'me').pos;
  const posRich = runsRich.find((r) => r.id === 'me').pos;
  assert.ok(posRich < posBare, `ノート通りに揃えれば順位が上がる（純正 ${posBare} 位 → ノート ${posRich} 位）`);
  assert.equal(runsRich.length, course.grid[cls]);
  assert.deepEqual(runsRich.map((r) => r.pos), runsRich.map((_, i) => i + 1));
  const finished = runsRich.filter((r) => !r.retired);
  for (let i = 1; i < finished.length; i++) assert.ok(finished[i].total >= finished[i - 1].total, '総時間の順');
  console.log(`  クラス2 ひばり平 ${entries.length + 1}台：純正 ${posBare} 位 → ノート通り ${posRich} 位`);
});

test('S6. スポンサー：段階1〜4に3社ずつ、架空名。実況の紹介は {sponsor} を埋める', () => {
  const SPONSORS = load('sponsors.json');
  const C = load('commentary.json');
  for (const tier of [1, 2, 3, 4]) {
    const pool = SPONSORS.filter((s) => s.tier === tier);
    assert.ok(pool.length >= 3, `段階${tier} は3社以上（${pool.length}）`);
  }
  assert.equal(new Set(SPONSORS.map((s) => s.id)).size, SPONSORS.length, 'id が重複');
  for (const s of SPONSORS) assert.ok(s.name && s.kind && s.tier >= 1 && s.tier <= 4);
  const intro = C.triggers.sponsor_intro;
  assert.ok(intro?.announcer.length >= 3 && intro.announcer.every((e) => e.text.includes('{sponsor}')), '実況は会社名を言う');
  assert.ok(intro.analyst.length >= 2);
  // 段階が上がったときだけ会社が付く。上がらなければそのまま
  const ids = Array.from({ length: 8 }, (_, i) => (i === 0 ? 'me' : `ai${i}`));
  const season = { year: 1, rounds: Array(6).fill({ result: {} }), next: 6, points: Object.fromEntries(ids.map((id) => [id, id === 'me' ? 30 : 1])), symptoms: {} };
  const s = { ...newGame(ECONOMY), cls: 2, tier: 1, sponsor: { tier: 1, id: 'local_ramen' }, season };
  const { state, sponsorChanged } = endSeason(s, ids, COURSES, ECONOMY, SPONSORS, () => 0.5, RADIO.season_note);
  assert.equal(state.cls, 3, '昇格');
  assert.equal(state.tier, 1, 'クラス3に上がっただけでは段階2にならない（完走してから）');
  assert.ok(!sponsorChanged && state.sponsor.id === 'local_ramen', '会社はそのまま');
  console.log(`  スポンサー ${SPONSORS.length} 社：${SPONSORS.map((x) => x.name).join('、')}`);
});

test('S7. クラス5に親父のノートは無い。AI だけが内部の基準を持ち、昇格で note_ends が立つ', () => {
  // --- 親父のノートはクラス4で終わる -----------------------------------------
  assert.ok(!NOTES.some((n) => n.class === 5), 'notes.json にクラス5は無い');
  // setup.html（プレイヤーの画面）は notes.json しか読まない。
  // ここが崩れると「ノート通りにする」がクラス5でも出てしまう
  const setupHtml = readFileSync(join(ROOT, 'src', 'ui', 'setup.html'), 'utf8');
  assert.ok(setupHtml.includes('data/notes.json'), 'setup.html は親父のノートを読む');
  assert.ok(!setupHtml.includes('ai-baseline'), 'setup.html は AI の基準を読んではいけない');

  // --- AI は内部の基準で組む ---------------------------------------------------
  const all = aiNotes(NOTES, BASELINE);
  const course = COURSES.find((c) => c.id === 'kazahaya');
  const base = baselineFor(all, PARTS, course, 5);
  assert.equal(base.note.class, 5, 'クラス5は自分の基準を引く（クラス3を借りない）');
  assert.ok(base.parts.some((p) => p.class_required === 5), 'クラス5のパーツが入っている');
  // 借用規則は生きている：クラス4のかざはやはノートが無いのでクラス3を借りる
  assert.equal(baselineFor(all, PARTS, course, 4).note.class, 3, 'クラス4のかざはやはクラス3を借りる');

  const entries = fieldEntries(RIVALS, course, 5);
  const plan = seasonRivalPlan(entries, PARTS, 5, createRng(11));
  const seen = { slow: 0, normal: 0, fast: 0 };
  for (const [i, entry] of entries.entries()) {
    const lo = rivalLoadout(entry, i, plan, PARTS, all, course, 5);
    seen[entry.strength] += 1;
    assert.ok(lo.parts.length >= 1, `${entry.name} の構成が空`);
    for (const p of lo.parts) assert.ok(aiLegal(p, 5), `${entry.name} の ${p.id} は規定外`);
    if (entry.strength !== 'fast') {
      for (const p of lo.parts) assert.ok(base.parts.includes(p), '基準の外のパーツを積まない');
    }
  }
  assert.ok(seen.fast && seen.normal && seen.slow, '3段階とも出走する');

  // --- クラス5は「全部積むと壊れる」クラス。基準はワークスを全部は積まない ----------
  // 並は16周で 15% 以下、速い（基準＋性格のパーツ）は 25% 以下（docs/設計/経済とシーズン.md）
  const LAPS5 = ECONOMY.laps[5];
  const dnf = (parts) => {
    const rel = buildPerformance(parts, haruka, CHASSIS.formula, {}).stats.reliability;
    return (1 - (1 - WEIGHTS.reliability.retirePerPointPerLap * Math.max(0, -rel)) ** LAPS5) * 100;
  };
  for (const c of COURSES.filter((x) => x.classes.includes(5))) {
    const b = baselineFor(all, PARTS, c, 5);
    const works = b.parts.filter((p) => p.class_required === 5);
    assert.ok(works.length >= 1, `${c.id}: クラス5のパーツが1点も無い`);
    assert.ok(works.length < 6, `${c.id}: ワークス部品を全部積んでいる（罠が残らない）`);
    const norm = dnf(notePortion(b.parts, AI_STRENGTH.normal));
    assert.ok(norm <= 15, `${c.id}: 並のリタイア率 ${norm.toFixed(0)}% が 15% を超えている`);
    const es = fieldEntries(RIVALS, c, 5);
    const pl = seasonRivalPlan(es, PARTS, 5, createRng(11));
    for (const [i, e] of es.entries()) {
      if (e.strength !== 'fast') continue;
      const f = dnf(rivalLoadout(e, i, pl, PARTS, all, c, 5).parts);
      assert.ok(f <= 25, `${c.id}: 速い（${e.name}）のリタイア率 ${f.toFixed(0)}% が 25% を超えている`);
    }
    // 基準全点は並より速い。着順が逆転しないための前提
    const t = (parts) => simulateRace(buildPerformance(parts, haruka, CHASSIS.formula, b.settings), c, LAPS5, haruka, { noise: false, retire: false }).total;
    assert.ok(t(b.parts) < t(notePortion(b.parts, AI_STRENGTH.normal)), `${c.id}: 基準全点が並より遅い`);
  }

  // --- クラス5へ昇格した瞬間に note_ends -----------------------------------------
  assert.deepEqual(seasonEvents({ verdict: 'promote', to: 5, from: 4 }), ['note_ends']);
  assert.deepEqual(seasonEvents({ verdict: 'promote', to: 4, from: 3 }), [], 'クラス4では立たない');
  assert.deepEqual(seasonEvents({ verdict: 'stay', to: 5, from: 5 }), [], '残留では立たない');
  assert.ok(SEASON_EVENTS.includes('note_ends'));
  // 台詞の枠は radio.json にある（中身はこれから書く）
  assert.ok(RADIO.season_event?.note_ends, 'radio.json に season_event.note_ends の枠がある');
  assert.ok(Array.isArray(RADIO.season_event.note_ends.lines), 'lines は配列');

  // ハルカのノート（症状の一行）はクラス5でも書かれる
  const ids = Array.from({ length: 20 }, (_, i) => (i === 0 ? 'me' : `ai${i}`));
  const s5 = {
    ...newGame(ECONOMY), cls: 4, tier: 3,
    season: { year: 3, rounds: Array(6).fill({ result: {} }), next: 6, symptoms: { tire_wear: 4 }, points: Object.fromEntries(ids.map((id) => [id, id === 'me' ? 60 : 1])) },
  };
  const out = endSeason(s5, ids, COURSES, ECONOMY, [], () => 0, RADIO.season_note);
  assert.equal(out.state.cls, 5);
  assert.deepEqual(out.events, ['note_ends']);
  assert.ok(out.note && out.note.length > 0, 'クラス5でもハルカの一行は書かれる');
  console.log(`  クラス5昇格：note_ends。ハルカの一行は残る「${out.note}」`);
});

test('S8. 場面：台本どおりの台詞が scenes.json にあり、一度見たら二度出ない', async () => {
  const S = await import('./save.js');
  const SCENES = load('scenes.json').scenes;
  const byId = Object.fromEntries(SCENES.map((s) => [s.id, s]));
  for (const id of ['promote5', 'win', 'ending', 'blank']) assert.ok(byId[id], `場面 ${id} が無い`);

  // 第5場。台本の最初と最後の台詞（一字でも変わったら落ちる）
  const s5 = byId.promote5;
  const says = s5.steps.filter((x) => x.say);
  assert.deepEqual(says[0], { say: 'ハルカ', text: 'かざはや。' });
  assert.deepEqual(says.at(-1), { say: 'ハルカ', text: 'うるさい。' });
  assert.ok(s5.steps.some((x) => x.do === 'cue' && x.cue === 'note.turn'), 'ページをめくる音（cue: note.turn）');
  assert.ok(s5.steps.some((x) => x.note === 'かざはや　クラス5'), 'ノートに書かれる見出し');
  // 【 】は画面に出さない。出す手は say と note だけ
  for (const step of s5.steps) assert.ok(step.say || step.note || step.stage, '知らない手がある');

  // **場面は一度だけ。** 見た記録は ending.seen
  let g = S.newGame(ECONOMY);
  assert.deepEqual(g.ending, { seen: [], line: '', done: false });
  assert.equal(S.sawScene(g, 'promote5'), false);
  g = S.markScene(g, 'promote5');
  assert.equal(S.sawScene(g, 'promote5'), true);
  assert.deepEqual(S.markScene(g, 'promote5').ending.seen, ['promote5'], '二度目は増えない');
  assert.equal(S.markScene(g, 'promote5'), g, '二度目は同じものを返す');
  // 形式を通っても消えない
  assert.deepEqual(decode(encode(g)).ending, g.ending);
  // 第8場は会話まで。**自由設定の無線6本は場面ではなく無線**（画面はまだ無い）
  const blank = byId.blank;
  assert.equal(blank.steps.at(-1).stage.startsWith('タイムアタック（自由設定）へ'), true, '第8場は自由設定の入口で終わる');
  for (const step of blank.steps) {
    assert.ok(!/壊れるって言った/.test(step.text ?? ''), '自由設定の無線が場面に混ざっている');
  }
  const free = RADIO.class5.free_setup;
  assert.equal(free.lines.length, 6, '自由設定の無線は6本');
  assert.equal(free.where, 'free');
  assert.equal(free.lines[0].text, 'それ壊れるよ。');
  assert.equal(free.lines.at(-1).text, '（新記録）……書いた。親父、これ知らないやつ。');
  for (const l of free.lines) assert.equal(l.speaker, 'haruka', 'すべてハルカの声');

  console.log(`  場面 ${SCENES.length} 本：${SCENES.map((s) => `${s.id}(台詞${s.steps.filter((x) => x.say).length})`).join(' ')}`);
});

test('S9. 優勝の場面はクラス5で優勝が確定した戦だけ。クラス4以下では出ない', () => {
  const ids = ['me', ...Array.from({ length: 11 }, (_, i) => `ai${i}`)];
  const max = ECONOMY.points[0];
  // 残り2戦。2位に max*2 + 1 差を付けていれば、全部取られても届かない
  const seasonAt = (next, lead) => ({
    year: 5, rounds: Array.from({ length: 6 }, () => ({ course: 'kazahaya', laps: 16 })), next,
    points: { me: 100, ai0: 100 - lead, ai1: 10 }, symptoms: {},
  });
  const g5 = { ...newGame(ECONOMY), cls: 5 };
  const left = 6 - 4;
  assert.equal(titleClinched(seasonAt(4, left * max + 1), ids, ECONOMY), true, '届かない差なら確定');
  assert.equal(titleClinched(seasonAt(4, left * max - 1), ids, ECONOMY), false, '追いつける差なら未確定');
  assert.equal(titleClinched(seasonAt(4, -1), ids, ECONOMY), false, '2位なら確定しない');
  assert.equal(titleClinched(seasonAt(6, 1), ids, ECONOMY), true, '最終戦が終われば1点差でも確定');

  const clinch = seasonAt(4, left * max + 1);
  // **クラス4以下では出ない。** 優勝が確定していても、昇格するだけ
  for (const cls of [1, 2, 3, 4]) {
    assert.equal(winSceneDue({ ...g5, cls, season: clinch }, ids, ECONOMY), false, `クラス${cls}では出ない`);
  }
  assert.equal(winSceneDue({ ...g5, season: clinch }, ids, ECONOMY), true, 'クラス5の確定した戦で出る');
  // **二度は出ない**
  const seen = markScene({ ...g5, season: clinch }, 'win');
  assert.equal(winSceneDue(seen, ids, ECONOMY), false, '一度見たら出ない');
  // 確定していない戦では出ない
  assert.equal(winSceneDue({ ...g5, season: seasonAt(4, left * max - 1) }, ids, ECONOMY), false);
  console.log(`  優勝確定：残り${left}戦、満点${max}点 → ${left * max + 1}点差で確定`);
});

test('S10. エンディングの一行と既読が進行に残り、保存文字列は 4,000 字に収まる', () => {
  const SCENE_DEFAULT = load('scenes.json').scenes
    .find((s) => s.id === 'ending').steps.find((s) => s.do === 'input').default;
  assert.equal(SCENE_DEFAULT, '今日、ウチが決めた。おいちゃんとふたりで', '第7場の既定文は台本のまま');

  let g = newGame(ECONOMY);
  assert.equal(g.ending.line, '');
  assert.equal(g.ending.done, false);
  // 第7場：書いた一行は 40 字まで。書かなければ既定文
  const write = (text) => ({ ...g, ending: { ...g.ending, line: trimTo(text, LINE_MAX, SCENE_DEFAULT), done: true } });
  assert.equal(write('').ending.line, SCENE_DEFAULT, '書かなければ既定文');
  assert.equal([...write('あ'.repeat(80)).ending.line].length, LINE_MAX, '40 字で切る');

  // 一番かさむ形（長い名前・長い一行・場面を全部見た・6戦すべて結果あり）で 4,000 字に収まる
  g = write('あ'.repeat(LINE_MAX));
  g = { ...g, cls: 5, player: { name: 'あ'.repeat(NAME_MAX) }, prologue: { line: 'あ'.repeat(LINE_MAX) } };
  for (const id of load('scenes.json').scenes.map((s) => s.id)) g = markScene(g, id);
  const ids = ['me', ...Array.from({ length: 19 }, (_, i) => `ai${i}`)];
  g.season = newSeason(5, COURSES, ECONOMY, createRng(7));
  for (let i = 0; i < 6; i += 1) {
    g = recordResult(g, {
      classification: ids.map((id, n) => ({ id, pos: n + 1, retired: false })),
      mine: { pos: 1, retired: false, prize: 12000, fee: 3000, sponsorFee: 4000, repair: 900, best: 92.345 },
      symptoms: { tire_wear: 3, understeer: 2 },
    }, ECONOMY);
  }
  const str = encode(g);
  assert.ok(str.length <= 4000, `保存文字列が長い：${str.length} 字`);
  const back = decode(str);
  assert.deepEqual(back.ending, g.ending, 'エンディングの一行と既読は形式を通っても消えない');
  assert.equal(back.ending.done, true);
  console.log(`  エンディング込みの保存文字列：${str.length} / 4,000 字（場面${g.ending.seen.length}本・6戦ぶん）`);
});

test('S11. 台本の台詞が、そのまま scenes.json と radio.json に入っている', async () => {
  // 台本はリポジトリに入っている。**無ければ落ちる**（生成物だけが残る事故を防ぐ）
  // **クラス5とプロローグの両方**を読み直して、生成物と突き合わせる
  const { build, SCRIPTS } = await import('../../tools/build-scenes.mjs');
  const texts = Object.fromEntries(SCRIPTS.map((sc) => [
    sc.file, readFileSync(join(ROOT, 'docs', 'シナリオ', sc.file), 'utf8'),
  ]));
  assert.equal(Object.keys(texts).length, 2, '読む台本は2本（クラス5とプロローグ）');
  const { scenes, class5, seasonNote } = build(texts);

  // 場面：台本から抜いたものと data/scenes.json が一字一句同じ
  assert.deepEqual(load('scenes.json').scenes, scenes, 'data/scenes.json が台本と合っていない（--write で作り直す）');
  // 無線：クラス5の差し込みと、シーズン末の一行
  assert.deepEqual(RADIO.class5, class5, 'data/radio.json の class5 が台本と合っていない');
  assert.deepEqual(RADIO.season_note.class5, seasonNote, 'season_note.class5 が台本と合っていない');
  const says = scenes.flatMap((s) => s.steps.filter((x) => x.say)).length;
  const lines = Object.values(class5).filter((t) => t.lines).reduce((n, t) => n + t.lines.length, 0);
  console.log(`  台本と一致：場面 ${scenes.length} 本 / 台詞 ${says} 行、無線 ${lines} 本、シーズン末 ${seasonNote.length} 本`);
});

test('S12. プロローグの第2場：18通りの選択すべてで2位以上。空気圧を高くしたときだけ2位', () => {
  const cfg = load('prologue.json');
  const course = COURSES.find((c) => c.id === cfg.course);
  const chassis = load('chassis.json')[cfg.chassis];
  const driver = load('drivers.json')[0];
  assert.ok(course, 'プロローグのコースが courses.json にある');
  assert.ok(chassis?.base_speed, 'プロローグの車体が chassis.json にある');

  const rows = [];
  for (const pressure of PROLOGUE_CHOICES.pressure) {
    for (const sprocket of PROLOGUE_CHOICES.sprocket) {
      for (const sidebar of ['on', 'off']) {
        const flags = { pressure, sprocket, sidebar };
        const { cars, pos } = runPrologue(cfg, flags, { course, chassis, driver });
        const me = cars[0];
        assert.ok(pos <= 2, `${pressure}/${sprocket}/${sidebar} が ${pos} 位（2位以上のはず）`);
        // **空気圧を高くしたときだけ2位。** 台本の「終盤タレたな」と「空気圧、俺のせいかも」に合わせる
        assert.equal(pos, pressure === 'high' ? 2 : 1, `${pressure}/${sprocket}/${sidebar} の順位`);
        assert.ok(!me.retired, 'プロローグではリタイアしない');
        rows.push({ flags, pos, total: me.raceTime, first: me.lapTimes[0], last: me.lapTimes.at(-1) });
      }
    }
  }
  // 選択の差は「わずか」。18通りの総時間の開きが、1周のタイムより小さい
  const totals = rows.map((r) => r.total);
  const spread = Math.max(...totals) - Math.min(...totals);
  assert.ok(spread < rows[0].first, `選択の差が大きすぎる：${spread.toFixed(2)}秒`);
  // 空気圧・高は序盤が速くて終盤がタレる（同じスプロケ・サイドバーで比べる）
  const at = (p) => rows.find((r) => r.flags.pressure === p && r.flags.sprocket === 'mid' && r.flags.sidebar === 'on');
  assert.ok(at('high').first < at('mid').first, '高は序盤が速い');
  assert.ok(at('high').last > at('mid').last, '高は終盤がタレる');
  console.log(`  プロローグ18通り：総時間の開き ${spread.toFixed(2)}秒`
    + `　高の1周目 ${at('high').first.toFixed(2)}s→最終周 ${at('high').last.toFixed(2)}s`
    + `／標準 ${at('mid').first.toFixed(2)}s→${at('mid').last.toFixed(2)}s`);
});

test('S13. プロローグで決まる5つが進行に入り、飛ばしても既定で成立する', () => {
  const SCENES = load('scenes.json').scenes;
  const byId = Object.fromEntries(SCENES.map((s) => [s.id, s]));
  for (const id of ['p1', 'p2', 'p3', 'p4']) assert.ok(byId[id], `場面 ${id} が無い`);

  // 第1場の3つの選択は、state の枠（PROLOGUE_CHOICES）と同じ選択肢を持つ
  const choices = byId.p1.steps.filter((s) => s.do === 'choose');
  assert.equal(choices.length, 3, '第1場の操作は3つ');
  assert.deepEqual(choices.map((c) => c.key), ['pressure', 'sprocket', 'sidebar']);
  assert.deepEqual(choices[0].options.map((o) => o.id), PROLOGUE_CHOICES.pressure);
  assert.deepEqual(choices[1].options.map((o) => o.id), PROLOGUE_CHOICES.sprocket);
  assert.deepEqual(choices[2].options.map((o) => o.id), ['on', 'off']);
  // 第2場の結果で台詞が分かれ、第4場は3択と名前の入力を持つ
  assert.ok(byId.p2.steps.some((s) => s.when?.pos === 1) && byId.p2.steps.some((s) => s.when?.pos === 2), '順位で分岐する');
  assert.ok(byId.p4.steps.some((s) => s.do === 'choose' && s.options.length === 3), '第4場の3択');
  assert.ok(byId.p4.steps.some((s) => s.do === 'name'), '第4場で名前を入れる');
  assert.equal(byId.p3.steps.find((s) => s.do === 'input')?.default, DEFAULT_LINE, '第3場の既定文は save.js と同じ');

  // **飛ばしたとき**：何も選ばなくても既定のまま成立する
  const skipped = newGame(ECONOMY);
  assert.equal(skipped.player.name, DEFAULT_NAME);
  assert.equal(skipped.prologue.line, DEFAULT_LINE);
  assert.ok(PROLOGUE_CHOICES.pressure.includes(skipped.prologue.pressure));
  assert.ok(PROLOGUE_CHOICES.sprocket.includes(skipped.prologue.sprocket));
  assert.equal(typeof skipped.prologue.sidebar, 'boolean');
  assert.ok([1, 2].includes(skipped.prologue.pos));
  assert.deepEqual(decode(encode(skipped)).prologue, skipped.prologue, '形式を通しても消えない');

  // 一番かさむ形でも 4,000 字に収まる（E7）
  let g = {
    ...skipped,
    player: { name: 'あ'.repeat(NAME_MAX) },
    prologue: { line: 'あ'.repeat(LINE_MAX), pressure: 'high', sprocket: 'top', sidebar: true, pos: 2 },
  };
  for (const id of ['p1', 'p2', 'p3', 'p4']) g = markScene(g, id);
  const str = encode(g);
  assert.ok(str.length <= 4000, `保存文字列が長い：${str.length} 字`);
  assert.deepEqual(decode(str).prologue, g.prologue);
  console.log(`  プロローグ直後の保存文字列：${str.length} / 4,000 字（選択3つ・順位・一行・名前）`);
});

test('S14. PLiCy に上げる一式：index.html の最初の要素がタイトルの canvas で、読み込みに穴が無い', async () => {
  const { collect, check, firstBodyElement, zip, crc32 } = await import('../../tools/pack-plicy.mjs');

  // **PLiCy はページの最初の canvas からサムネイルを撮る。** ここが動くと絵が変わる
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const first = firstBodyElement(html);
  assert.equal(first.tag, 'canvas', 'body の最初の要素は canvas');
  assert.equal(first.id, 'cover', 'タイトルの canvas');
  assert.match(html, /src\/ui\/title\.js/, 'タイトルを描く module を読んでいる');

  // 配布物：画面とデータと絵だけ。テストと開発用は入れない
  const files = collect();
  assert.ok(files.includes('index.html'));
  assert.ok(files.includes('src/ui/title.js'));
  assert.ok(files.includes('data/scenes.json'));
  assert.ok(!files.some((f) => f.includes('.test.')), 'テストは入れない');
  assert.ok(!files.some((f) => f.startsWith('tools/') || f.startsWith('docs/')), '開発用は入れない');
  assert.deepEqual(check(files), [], '読み込みの取りこぼし');

  // ZIP が壊れていない（自前で書いているので、印と長さだけ見る）
  const entries = files.map((name) => ({ name, data: readFileSync(join(ROOT, name)) }));
  const buf = zip(entries);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'ZIP の先頭');
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50, 'ZIP の終わり');
  assert.equal(buf.readUInt16LE(end + 10), files.length, '件数');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC-32 が合っている');
  console.log(`  PLiCy 一式：${files.length} 件 → ZIP ${(buf.length / 1024).toFixed(1)} KB`
    + `　最初の要素 <${first.tag} id="${first.id}">`);
});

test('S15. 立ち絵：決めた場所に image の手が入り、絵のファイルが実在する', async () => {
  const { existsSync, statSync } = await import('node:fs');
  const { IMAGES } = await import('../../tools/build-scenes.mjs');
  const SCENES = load('scenes.json').scenes;
  const byId = Object.fromEntries(SCENES.map((s) => [s.id, s]));

  const rows = [];
  for (const image of IMAGES) {
    const scene = byId[image.scene];
    assert.ok(scene, `場面が無い: ${image.scene}`);
    const at = scene.steps.findIndex((s) => s.do === 'image' && s.src === image.src);
    assert.ok(at > 0, `${image.scene} に ${image.src} の手が無い`);
    // 直前の【 】が、決めた置き場所であること（台本が動いたら落ちる）
    const before = scene.steps[at - 1];
    if (image.head) assert.equal(at, 1, `${image.scene} は場面の頭に置く`);
    else assert.match(before.stage ?? '', image.match, `${image.scene} の置き場所がずれている`);
    // 絵が実在して、軽いこと（配布に丸ごと入る）
    const file = join(ROOT, 'assets', image.src);
    assert.ok(existsSync(file), `絵が無い: assets/${image.src}`);
    const kb = statSync(file).size / 1024;
    assert.ok(kb < 400, `assets/${image.src} が重い：${Math.round(kb)} KB`);
    rows.push(`${image.scene}→${image.src.replace('scene/', '')} ${Math.round(kb)}KB`);
  }
  // **第6場のピットレーンには絵を敷かない**（歩き去る絵だけ）
  const win = byId.win;
  const images = win.steps.filter((s) => s.do === 'image');
  assert.equal(images.length, 1, '第6場の絵は1枚だけ');
  assert.equal(images[0].src, 'scene/haruka_walk.jpg');
  assert.ok(win.steps.findIndex((s) => s.do === 'image') > win.steps.length / 2, '第6場の絵は終わりのほう');
  console.log(`  立ち絵 ${IMAGES.length} 箇所：${rows.join('／')}`);
});

test('S16. 選択の手は選択として出る。say を持つ第4場の3択も台詞に流れない', async () => {
  // 場面エンジンは UI だが、手の読み分けだけは純粋な関数にしてある
  const { stepKind } = await import('../ui/scene.js');
  const SCENES = load('scenes.json').scenes;
  const byId = Object.fromEntries(SCENES.map((s) => [s.id, s]));

  // **第4場の3択は「主人公：（選択肢）」から来るので say を持つ。**
  // say を先に見ると台詞として流れ、A/B/C が出ないまま分岐が死ぬ
  const greet = byId.p4.steps.find((s) => s.key === 'greet');
  assert.ok(greet, '第4場に3択がある');
  assert.equal(greet.say, '主人公', '3択は主人公の台詞として出る');
  assert.equal(stepKind(greet), 'choose', 'say を持っていても選択として出す');

  // ふつうの台詞とノートの文字は、これまでどおり
  assert.equal(stepKind({ say: 'ハルカ', text: '……。' }), 'say');
  assert.equal(stepKind({ note: 'かざはや　クラス5' }), 'note');
  assert.equal(stepKind({ stage: '【フェードアウト】' }), 'stage');

  // すべての場面で、分岐（when）の答えを出す手が必ず選択として出る。**pos は走行の結果**
  for (const scene of SCENES) {
    for (const step of scene.steps) {
      for (const key of Object.keys(step.when ?? {})) {
        if (key === 'pos') continue;
        const src = scene.steps.find((x) => x.key === key);
        assert.ok(src, `${scene.id}：${key} を決める手が無い`);
        assert.equal(stepKind(src), 'choose', `${scene.id}：${key} が選択として出ない`);
        assert.ok(src.options.some((o) => o.id === step.when[key]),
          `${scene.id}：${key}=${step.when[key]} という選択肢が無い`);
      }
    }
  }
  const chooses = SCENES.flatMap((s) => s.steps.filter((x) => stepKind(x) === 'choose'));
  console.log(`  選択 ${chooses.length} 箇所：${chooses.map((c) => `${c.key}(${c.options.length})`).join(' ')}`);
});

test('S17. 耐久戦の燃料：満タンでも走り切れず、ぎりぎりは節約と組まないと届かない', () => {
  const CLASS_CHASSIS = { 1: 'hatchback', 2: 'hatchback', 3: 'sedan', 4: 'gt', 5: 'formula' };
  const chassisData = load('chassis.json');
  const driver = load('drivers.json')[0];

  /**
   * 1回だけピットに入って走り切れるか。**満タンまで入れる**ので、残っているぶんは捨てる
   * ＝引っぱるほど総距離は伸びる。when は入る周の決め方。
   *   'never'   入らない
   *   'window'  窓（残り30%）が開いた最初の周で入る
   *   'late'    走れなくなる直前まで引っぱる
   */
  const run = (perf, laps, key, { saving = false, when = 'late' } = {}) => {
    let fuel = enduranceFuel(perf.stats, laps, key);
    let pitLap = null;
    let windowLap = null;
    for (let lap = 1; lap <= laps; lap += 1) {
      if (!canRunLap(fuel, perf.stats, saving)) return { ok: false, out: lap, pitLap, windowLap };
      fuel = advanceFuel(fuel, perf.stats, saving);
      const open = fuel.level < fuel.tank * PIT.window;
      if (windowLap === null && open) windowLap = lap;
      if (pitLap !== null || lap >= laps || when === 'never' || !open) continue;
      if (when === 'window' || !canRunLap(fuel, perf.stats, saving)) { fuel = refuel(fuel); pitLap = lap; }
    }
    return { ok: true, pitLap, windowLap };
  };

  const rows = [];
  for (const cls of [1, 2, 3, 4, 5]) {
    const laps = ECONOMY.laps[cls] * ENDURANCE.lapFactor;
    const perf = buildPerformance([], driver, chassisData[CLASS_CHASSIS[cls]], {});
    // **満タン＝全周回の6割。** 基準の車（fuel_consumption 0）でちょうど tankShare
    const tankLaps = enduranceTank(laps, perf.stats) / fuelPerLap(perf.stats);
    assert.ok(Math.abs(tankLaps / laps - ENDURANCE.tankShare) < 1e-9, `クラス${cls}の満タンが6割でない`);

    // ピット無しなら、満タンでも燃料切れ（fuel_out に届く）
    const noStop = run(perf, laps, 'full', { when: 'never' });
    assert.equal(noStop.ok, false, `クラス${cls}：満タンでピット無しでも走り切れてしまう`);
    assert.ok(noStop.out <= Math.ceil(laps * ENDURANCE.tankShare) + 1, `クラス${cls}：切れるのが遅すぎる`);
    // 節約しても、ピット無しでは届かない（必ず一度は入る）
    assert.equal(run(perf, laps, 'full', { when: 'never', saving: true }).ok, false, `クラス${cls}：節約だけで走り切れてしまう`);

    // 満タンと必要分＋余裕は1回のピットで届く
    for (const key of ['full', 'margin']) {
      assert.ok(run(perf, laps, key).ok, `クラス${cls}：${key} が1回のピットで届かない`);
    }
    // **満タンだけは、窓が開いてすぐ入っても届く。** 入る周を気にしなくていいのが重い代償の見返り
    assert.ok(run(perf, laps, 'full', { when: 'window' }).ok, `クラス${cls}：満タンで早入りすると届かない`);
    // 余裕の早入りは**クラスによる**（周の粗さ次第で越えたり越えなかったりする）。決め打たずに控える
    const earlyMargin = run(perf, laps, 'margin', { when: 'window' }).ok;

    // **ぎりぎり：節約なしでは届かず、節約と組めば1回のピットで届く**
    const tight = run(perf, laps, 'tight');
    const tightSave = run(perf, laps, 'tight', { saving: true });
    assert.equal(tight.ok, false, `クラス${cls}：ぎりぎりが節約なしで届いてしまう`);
    assert.equal(tightSave.ok, true, `クラス${cls}：ぎりぎり＋節約で届かない`);
    assert.equal(tightSave.pitLap !== null, true, 'ぎりぎり＋節約でも一度は入る');

    // --- 3択が何周ぶんになるか。**軽いほど速い**ので、ぎりぎり < 余裕 < 満タン ---------
    const carry = (k) => enduranceFuel(perf.stats, laps, k).level / fuelPerLap(perf.stats);
    const [t, m, f] = ['tight', 'margin', 'full'].map(carry);
    assert.ok(t < m && m < f, `クラス${cls}：積む量の順が合っていない`);
    assert.ok(Math.abs(f - tankLaps) < 1e-9, `クラス${cls}：満タンがタンクいっぱいでない`);
    // 1回のピットで走れる距離＝積んだぶん ＋ 満タン1杯（**残して入ったぶんは捨てる**）
    const reach = (k) => carry(k) + tankLaps;
    assert.ok(reach('full') > laps && reach('margin') > laps, `クラス${cls}：満タン／余裕が届かない`);
    assert.ok(reach('tight') < laps, `クラス${cls}：ぎりぎりが節約なしで届いてしまう`);
    assert.ok(reach('tight') / ENDURANCE.save.fuel > laps, `クラス${cls}：ぎりぎりが節約しても届かない`);
    // 窓は、いちばん軽いぎりぎりでも間に合う位置で開く
    assert.ok(tight.windowLap != null && tight.windowLap < laps, `クラス${cls}：ぎりぎりで窓が開かない`);

    rows.push(`クラス${cls} ${String(laps).padStart(2)}周：満タン ${f.toFixed(1)}周ぶん(${(f / laps * 100).toFixed(0)}%)`
      + ` / 余裕 ${m.toFixed(1)} / ぎりぎり ${t.toFixed(1)}`
      + `　1回のピットで ${reach('full').toFixed(1)} / ${reach('margin').toFixed(1)} / ${reach('tight').toFixed(1)}`
      + `（節約で ${(reach('tight') / ENDURANCE.save.fuel).toFixed(1)}）`
      + `　窓${tight.windowLap}周目・ぎりぎり＋節約はpit${tightSave.pitLap}`
      + `　余裕の早入り${earlyMargin ? '○' : '×'}`);
  }
  // 節約は燃費 −10%、周のタイム +0.3%
  const perf1 = buildPerformance([], driver, chassisData.hatchback, {});
  assert.ok(Math.abs(fuelPerLap(perf1.stats, true) / fuelPerLap(perf1.stats) - ENDURANCE.save.fuel) < 1e-12);
  for (const r of rows) console.log(`  ${r}`);

  // --- 燃費は「積む量」に出る。**周ぶん（距離）は車が変わっても同じ** ---------
  //
  // タンクは車ごとに測る（enduranceTank(laps, stats)）ので、どの車も満タンで
  // 全周回の 65% を走る。燃費の悪い車は同じ距離を走るのに多く積む＝そのぶん重い。
  const cls5 = 5;
  const laps5 = ECONOMY.laps[cls5] * ENDURANCE.lapFactor;
  const season5 = newSeason(cls5, COURSES, ECONOMY, createRng(7));
  const course5 = COURSES.find((c) => c.id === season5.rounds[ENDURANCE.round - 1].course);
  const note5 = baselineFor(NOTES, PARTS, course5, cls5);
  const works = PARTS.find((p) => p.id === 'engine_works_01');
  assert.ok(note5.parts.length && works, 'ノートとワークスエンジンが引けている');
  const builds = [
    { label: '純正', parts: [] },
    { label: 'ノート通り', parts: note5.parts },
    // ワークスエンジンはユニット部品で複数スロットを埋めるので、当たるものを外して置き換える
    { label: '＋ワークスエンジン', parts: [
      ...note5.parts.filter((p) => !occupiedSlots(p).some((sl) => occupiedSlots(works).includes(sl))),
      works,
    ] },
  ];

  const shown = [];
  let lastLaps = null;
  for (const build of builds) {
    const bp = buildPerformance(build.parts, driver, chassisData[CLASS_CHASSIS[cls5]], note5.settings);
    const fc = bp.stats.fuel_consumption;
    const per = fuelPerLap(bp.stats);
    const cell = ['full', 'margin', 'tight'].map((k) => {
      const f = enduranceFuel(bp.stats, laps5, k);
      return { laps: f.level / per, units: f.level };
    });
    // **周ぶんは車によらず同じ。** 変わるのは積む量（＝重さ）
    const lapsOf = cell.map((c) => c.laps);
    if (lastLaps) {
      lapsOf.forEach((v, i) => assert.ok(Math.abs(v - lastLaps[i]) < 1e-9,
        `${build.label}：周ぶんが変わっている（${v.toFixed(2)} ≠ ${lastLaps[i].toFixed(2)}）`));
    }
    lastLaps = lapsOf;
    assert.ok(Math.abs(cell[0].laps / laps5 - ENDURANCE.tankShare) < 1e-9, `${build.label}：満タンが65%でない`);
    shown.push(`  ${build.label.padEnd(9)} 燃費${fc.toFixed(1).padStart(5)}`
      + `　周ぶん ${cell.map((c) => c.laps.toFixed(1)).join(' / ')}`
      + `　積む量 ${cell.map((c) => c.units.toFixed(1)).join(' / ')}`);
  }
  // 燃費が悪いほど多く積む（＝重い）。ここが耐久での fuel_consumption の効き方
  const units = builds.map((b) => {
    const bp = buildPerformance(b.parts, driver, chassisData[CLASS_CHASSIS[cls5]], note5.settings);
    return { fc: bp.stats.fuel_consumption, u: enduranceFuel(bp.stats, laps5, 'full').level };
  });
  for (let i = 1; i < units.length; i += 1) {
    const dFc = Math.sign(units[i].fc - units[i - 1].fc);
    const dU = Math.sign(units[i].u - units[i - 1].u);
    assert.equal(dU, dFc, `積む量が燃費と同じ向きに動いていない（燃費 ${units[i - 1].fc}→${units[i].fc}）`);
  }
  // 純正とノート通りの差は、そのまま重さの差（weightPerUnit ぶん）
  assert.ok(units[1].u > units[0].u * 1.2, 'ノート通りは純正よりはっきり多く積む');
  console.log(`  クラス5 ${laps5}周 ${course5.name}：燃費は距離ではなく積む量（重さ）に出る`);
  for (const l of shown) console.log(l);
});

test('S18. 画面の中の module が構文として通る（ビルドが無いので、開くまで気づけない）', () => {
  // **ビルドもバンドルも無い。** 画面の module は開くまで誰も構文を見ない。
  // 2,000 行の中の閉じ忘れが、テストを全部通したまま画面だけ真っ白にする
  const dir = mkdtempSync(join(tmpdir(), 'haruka-'));
  const pages = ['index.html', 'src/ui/setup.html', 'src/ui/race.html', 'src/ui/season.html', 'src/ui/prologue.html'];
  const rows = [];
  for (const page of pages) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    const head = '<script type="module">';
    const open = html.indexOf(head);
    assert.ok(open >= 0, `${page} に module が無い`);
    const body = html.slice(open + head.length, html.indexOf('</script>', open));
    const file = join(dir, `${page.replace(/[\/]/g, '_')}.mjs`);
    writeFileSync(file, body);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      const where = String(err.stderr ?? '').split('\n').slice(0, 4).join(' / ');
      assert.fail(`${page} の module が構文エラー：${where}`);
    }
    rows.push(`${page.split('/').pop()} ${body.split('\n').length}行`);
  }
  console.log(`  構文 OK：${rows.join('、')}`);
});

test('S19. ピットイン：二段の合図、AI は全車一度、停止時間は式どおり、止まっている間に抜かれる', () => {
  const COURSE = COURSES.find((c) => c.id === 'misaki');
  const chassisData = load('chassis.json');
  const driver = load('drivers.json')[0];
  const laps = ECONOMY.laps[1] * ENDURANCE.lapFactor;

  // --- 二段の合図。**押し切らなければ入らない** -----------------------------
  const call = createPitCall();
  assert.equal(pressPitCall(call, 5), 'ask', '1回目はただの合図（ハルカが抵抗する）');
  assert.equal(call.confirmed, false, '1回押しただけでは決まらない');
  assert.equal(pressPitCall(call, 5), 'confirm', '同じ周にもう一度で決定');
  assert.equal(pressPitCall(call, 5), 'already', '3回目は何も起きない');

  // 1回押して放っておくと、周が変わったところで流れる
  const lapsed = createPitCall();
  pressPitCall(lapsed, 5);
  assert.equal(lapsePitCall(lapsed, 5), false, '同じ周のうちは流れない');
  assert.equal(lapsePitCall(lapsed, 6), true, '周が変わったら流れる');
  assert.equal(lapsed.asked, null);
  assert.equal(lapsed.confirmed, false, '流れたら入らない');
  // 決めたあとは周が変わっても流れない
  const fixed = createPitCall();
  pressPitCall(fixed, 3); pressPitCall(fixed, 3);
  assert.equal(lapsePitCall(fixed, 4), false);

  // --- 停止時間の式 ---------------------------------------------------------
  const S = PIT.stop;
  const tank = { level: 0, tank: 100 };
  const full = { level: 100, tank: 100 };
  assert.equal(pitStopSeconds(tank, false), S.lane + S.still + S.fuelMax, '空なら給油は最長');
  assert.equal(pitStopSeconds(full, false), S.lane + S.still + S.fuelMin, '満タンなら給油は最短');
  assert.equal(pitStopSeconds(tank, true) - pitStopSeconds(tank, false), S.tyre, 'タイヤ交換は +8秒');
  assert.equal(pitStopSeconds({ level: 50, tank: 100 }, false), S.lane + S.still + (S.fuelMax + S.fuelMin) / 2, '半分なら中間');

  // --- 場を走らせる。**AI が全車一度は入る** --------------------------------
  const perf = buildPerformance([], driver, chassisData.hatchback, {});
  const radios = ['straight', 'corner', 'slow', 'aggressive'];
  const cars = Array.from({ length: 8 }, (_, i) => ({
    id: i === 0 ? 'me' : `ai${i}`,
    isPlayer: i === 0,
    radio: radios[i % radios.length],
    ...createRunner({ perf: buildPerformance([], driver, chassisData.hatchback, {}), driver, seed: 11 + i * 977, laps }),
  }));
  setupEndurance(cars, laps, { fuel: 'full', seed: 5 });
  for (const car of cars.slice(1)) {
    assert.ok(['attack', 'steady', 'other'].includes(car.pitStyle), 'AI に入り方がある');
    assert.equal(car.fuel.level, car.fuel.tank, 'AI は満タンで出る');
  }
  assert.equal(cars[0].pitStyle, null, '自車は合図で入る（性格で勝手に入らない）');

  // 自車は「走れなくなる直前」に入る
  const wantsPit = (car, total) => car.id === 'me' && car.pits === 0 && car.lap < total
    && !canRunLap(car.fuel, car.perf.stats, car.saving);
  const order = runField(cars, { course: COURSE, laps, grid: false }, { wantsPit });

  for (const car of cars) {
    assert.equal(car.retired, false, `${car.id} が止まっている（${car.retireReason}）`);
    // **全車が必ず一度は入る。** 早く入った車は二度目が要ることがある（早入りの代償）
    assert.ok(car.pits >= 1, `${car.id} が一度も入っていない`);
    assert.equal(car.pitLaps.length, car.pits);
    assert.ok(car.pitLoss >= PIT.stop.lane + PIT.stop.still + PIT.stop.fuelMin, `${car.id} の停止時間`);
  }
  // 引っぱる型ほど回数が少ない。攻め型は必ず1回で足りる
  for (const car of cars.slice(1).filter((c) => c.pitStyle === 'attack')) {
    assert.equal(car.pits, 1, '攻め型（残り15%）は1回で足りる');
  }
  // 入る周は性格で散る（全車が同じ周に来ない）
  const pitLaps = cars.slice(1).map((c) => c.pitLaps[0]);
  assert.ok(new Set(pitLaps).size >= 3, `AI の入る周が散っていない：${pitLaps.join(',')}`);
  // 攻め型は引っぱり、堅実は早く入る
  const byStyle = (st) => cars.slice(1).filter((c) => c.pitStyle === st).map((c) => c.pitLaps[0]);
  const attack = byStyle('attack'); const steady = byStyle('steady');
  if (attack.length && steady.length) {
    assert.ok(Math.min(...attack) > Math.max(...steady), `攻め型 ${attack} は堅実 ${steady} より遅く入る`);
  }
  // 攻め型はタイヤを替えない＝停止時間が短い
  const attackCar = cars.find((c) => c.pitStyle === 'attack');
  const steadyCar = cars.find((c) => c.pitStyle === 'steady');
  assert.ok(attackCar.pitLoss < steadyCar.pitLoss, '攻め型はタイヤを替えないぶん短い');

  console.log(`  ${laps}周・8台：${cars.map((c) => `${c.id}${c.pitStyle ? `(${c.pitStyle})` : ''}:${c.pitLaps.join('/')}周 ${c.pitLoss.toFixed(0)}s`).join('　')}`
    + `　勝者 ${order[0].id}`);
});

test('S20. ピットで止まっている間も場は進む＝その場で順位が動く', () => {
  const COURSE = COURSES.find((c) => c.id === 'misaki');
  const chassisData = load('chassis.json');
  const driver = load('drivers.json')[0];
  const laps = 6;
  const make = (id) => ({
    id, isPlayer: id === 'me', radio: 'corner',
    ...createRunner({ perf: buildPerformance([], driver, chassisData.hatchback, {}), driver, seed: 4242, laps }),
  });
  // **まったく同じ車2台。** 片方だけピットに入れる
  const cars = [make('me'), make('ai1')];
  const ctx = { course: COURSE, load: courseLoad(COURSE), totalLaps: laps, courseLen: COURSE.length, grid: false, clock: createClock() };
  for (const car of cars) planLap(car, COURSE);
  // 同じ車なので、入れるまでは並んでいる
  stepField(cars, 30, ctx);
  const before = rankRunners(cars, COURSE.length).map((c) => c.id);
  assert.deepEqual(before, ['me', 'ai1'], '同じ車ならスタート順のまま');

  // 自車をボックスに入れる（20秒止める）
  cars[0].fuel = { level: 5, filled: 50, tank: 50 };
  const stop = pitStop(cars[0]);
  assert.ok(stop.seconds > 0);
  assert.ok(cars[0].hold > 0, '止まっている');
  const myDist = progress(cars[0], COURSE.length);
  stepField(cars, stop.seconds - 1, ctx);
  assert.equal(progress(cars[0], COURSE.length), myDist, 'ピット中は1メートルも進まない');
  stepField(cars, 1, ctx);
  assert.ok(progress(cars[1], COURSE.length) > myDist, '相手は進んでいる');
  assert.deepEqual(rankRunners(cars, COURSE.length).map((c) => c.id), ['ai1', 'me'], 'ピット中に抜かれる');
  assert.equal(cars[0].hold, 0, '止まる時間を使い切ったら出る');
  // 止まっていた時間はラップタイムに入る（出た周が遅くなる）
  stepField(cars, 400, ctx);
  assert.ok(cars[0].raceTime > cars[1].raceTime, `止まったぶんだけ遅い：${cars[0].raceTime.toFixed(1)} vs ${cars[1].raceTime.toFixed(1)}`);
  console.log(`  ピット ${stop.seconds.toFixed(1)}秒で ${(cars[0].raceTime - cars[1].raceTime).toFixed(1)}秒の損`);
});
