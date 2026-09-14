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
  seasonEvents, SEASON_EVENTS,
} from './season.js';
import { rivalSpec, fieldEntries, AI_PROFILES, AI_STRENGTH, aiLegal, baselineFor, seasonRivalPlan, rivalLoadout, notePortion, aiNotes } from './rivals.js';
import { newGame, encode, decode } from './save.js';
import { buildPerformance, createRng, simulateRace, WEIGHTS } from './race.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
const ECONOMY = load('economy.json');
const COURSES = load('courses.json');
const PARTS = load('parts.json');
const CHASSIS = load('chassis.json');
const RIVALS = load('rivals.json');
const RADIO = load('radio.json');
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
  console.log(`  場面 ${SCENES.length} 本：${SCENES.map((s) => `${s.id}(台詞${s.steps.filter((x) => x.say).length})`).join(' ')}`);
});
