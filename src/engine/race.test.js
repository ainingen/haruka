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
import {
  buildPerformance, simulateRace, formatTime, SLOTS, occupiedSlots, resolveLoadout,
  RADIO, pitComment, reactionFor, brakeThreshold, tireWearSplit, fuelLevel,
  QUALI, START, gridBlockFactor, simulateQualifying,
} from './race.js';

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
const STRAIGHT = 'nagasawa';      // ストレート主体
const CORNER = 'misaki';         // 低速コーナー主体（テクニカル）
const BALANCED = 'hibaridaira';  // バランス型
const FAST = 'kazahaya';         // 高速コーナー主体
const STOPGO = 'asahina';        // ストップ＆ゴー（ブレーキが一番厳しい）

/** テストは決定的に。乱数要素（ばらつき・リタイア）は切る。 */
const OPTIONS = { noise: false, retire: false, seed: 1 };
const BASE_PARTS = ['tire_compound_02'];

/** 目安の範囲。外れてもテストは落とさず、出力に印を付ける。 */
const PERCEPTIBLE = { min: 0.3, max: 2.0 };

function race({ parts = BASE_PARTS, extra = [], courseId, laps, driver = haruka, settings = null, options = {} }) {
  const perf = buildPerformance([...parts.map(part), ...extra], driver, sedan, settings);
  return simulateRace(perf, course(courseId), laps, driver, { ...OPTIONS, ...options });
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

test('3. aero_02 は高速コーナー主体で速くなり、ストレート主体で遅くなる（低速コーナーでは効かない）', () => {
  const laps = 10;
  const aero = part('aero_weight_aero_02');
  const diffOn = (courseId, label) => {
    const on = race({ extra: [aero], courseId, laps });
    const off = race({ courseId, laps });
    return report(label, on, off);      // 正なら「あり」が速い
  };

  const fast = diffOn(FAST, 'aero_02 あり − なし @ かざはや（高速コーナー主体）');
  assert.ok(fast > 0, '高速コーナー主体では速くなるはず');

  const straight = diffOn(STRAIGHT, 'aero_02 あり − なし @ ながさわ（ストレート主体）');
  assert.ok(straight < 0, 'ストレート主体ではドラッグと重量ぶん遅くなるはず');

  // ダウンフォースが効くのは高速コーナーだけ。低速主体のコースでは割に合わない。
  const slow = diffOn(CORNER, 'aero_02 あり − なし @ みさき（低速コーナー主体）');
  assert.ok(slow < fast, '低速コーナー主体では高速コーナー主体ほど報われないはず');
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

// ---------------------------------------------------------------------------
// 無線（docs/設計/無線.md）。判定だけをテストする。台詞は data/radio.json の担当。
// ---------------------------------------------------------------------------

/** 無線の記録を「3周目 アンダー」の形で並べる。 */
const radioLog = (result) => result.radio.map((c) => `${c.lap}周目 ${c.id}`).join(' / ') || 'なし';

test('10. 無線: アンダーに振った車でみさきを10周すると「アンダー」が出る', () => {
  // フロントスタビだけ（balance −3）＋ ブレーキ前後配分を前寄り（balance −2.5）
  const r = race({
    parts: ['tire_compound_02', 'suspension_stabi_01', 'brake_bias_01'],
    settings: { brake_bias: 70 },
    courseId: CORNER, laps: 10, options: { radio: true },
  });
  console.log(`  みさき10周の無線: ${radioLog(r)}`);

  const under = r.radio.filter((c) => c.id === 'understeer');
  assert.ok(under.length >= 1, 'アンダーが少なくとも1回は出るはず');
  assert.ok(!r.radio.some((c) => c.id === 'oversteer'), 'アンダー側なのにオーバーは出ないはず');

  // 症状が続く間は繰り返す。ただし毎周ではなく repeatLaps おき（悪化したときだけ待たない）
  assert.ok(under.length >= 2, '10周続く症状なら、2回以上は言うはず');
  const perLap = new Map();
  for (const c of r.radio.filter((c) => c.kind === 'info')) perLap.set(c.lap, (perLap.get(c.lap) ?? 0) + 1);
  assert.ok([...perLap.values()].every((n) => n <= RADIO.maxInfoPerLap), `1周の情報系は ${RADIO.maxInfoPerLap} 本まで`);
  for (const id of new Set(r.radio.map((c) => c.id))) {
    if (RADIO.events.includes(id) || id === 'chat') continue;
    const seq = r.radio.filter((c) => c.id === id);
    for (let i = 1; i < seq.length; i++) {
      const soon = seq[i].lap < seq[i - 1].lap + RADIO.repeatLaps;
      assert.ok(!soon || seq[i].level === 'harsh', `${id} が悪化していないのに続けて出ている`);
    }
  }
  // 3回目からは口調がきつくなる
  assert.ok(under.some((c) => c.level === 'harsh'), '続く症状はきつい口調に変わるはず');

  // バランスを好みどおりに戻せば、アンダーは出ない（前後スタビで相殺する）
  const balanced = race({
    parts: ['tire_compound_02', 'suspension_stabi_01', 'suspension_stabi_02'],
    courseId: CORNER, laps: 10, options: { radio: true },
  });
  console.log(`  前後スタビで相殺した場合: ${radioLog(balanced)}`);
  assert.ok(!balanced.radio.some((c) => c.id === 'understeer'), '好みどおりならアンダーは出ないはず');
});

test('11. 無線: あさひなを25周するとブレーキフェードが出る', () => {
  const r = race({ courseId: STOPGO, laps: 25, options: { radio: true } });
  console.log(`  あさひな25周の無線: ${radioLog(r)}`);

  const fade = r.radio.filter((c) => c.id === 'brake_fade');
  assert.ok(fade.length >= 1, 'ブレーキフェードが少なくとも1回は出るはず');

  // 言い出す周には、もう実際に温度が閾値の9割へ来ている
  const lap = r.laps[fade[0].lap - 1];
  console.log(`  初出 ${fade[0].lap}周目（ブレーキ温度 ${Math.round(lap.brakeTemp)}・警告は閾値の ${RADIO.fadeRatio * 100}%）`);
  assert.ok(lap.brakeTemp >= 100 * RADIO.fadeRatio, '温度が閾値の9割に達しているはず');

  // 耐フェードを十分に積めば黙る（症状が出ていないのだから言うことがない）
  const withBrakes = race({ extra: [part('brake_works_01')], courseId: STOPGO, laps: 25, options: { radio: true } });
  console.log(`  カーボンブレーキ（耐フェード +14）の場合: ${radioLog(withBrakes)}`);
  assert.ok(!withBrakes.radio.some((c) => c.id === 'brake_fade'), '閾値が上がれば出ないはず');
});

test('12. 無線: ピットの一言は好みからのズレと無理をしている設定を拾う', () => {
  const pit = (parts, settings) => {
    const list = parts.map(part);
    return pitComment(buildPerformance(list, haruka, sedan, settings), haruka, { parts: list, settings });
  };

  // 素のセダン（balance 0）はハルカの好み（+2）に対してアンダー寄り。何も足していなくても口は出る
  assert.equal(pit(['tire_compound_02'], {}), 'understeer');
  assert.equal(pit(['tire_compound_02', 'suspension_stabi_01'], {}), 'understeer', 'フロントスタビで更にアンダー側へ');

  // リアスタビだけで好みの範囲に入る。バランスに文句がないので、片側装着のほうを言う
  assert.equal(pit(['tire_compound_02', 'suspension_stabi_02'], {}), 'stabi_rear_only');

  // 前後スタビを揃えて配分で好みに合わせれば「これが好き」
  assert.equal(
    pit(['tire_compound_02', 'suspension_stabi_01', 'suspension_stabi_02', 'brake_bias_01'], { brake_bias: 52 }),
    'just_right',
  );
  // 後ろに振りすぎればオーバー側だと言う
  assert.equal(
    pit(['tire_compound_02', 'suspension_stabi_02', 'brake_bias_01'], { brake_bias: 50 }), 'oversteer',
  );

  assert.equal(pit(['tire_compound_02'], { tire_pressure: 2.5 }), 'pressure_high', '空気圧はバランスより先に言う');
  assert.equal(pit(['tire_compound_02', 'suspension_works_01'], {}), 'too_demanding',
    '要求技量（+6）が最優先で拾われるはず');
  console.log(`  ハルカ（技量 ${haruka.skill} / 好み ${haruka.preferred_balance}）に対するピットの一言を7通り確認`);
});

// ---------------------------------------------------------------------------
// データの整合。台詞の量と禁則、ノートの装着可否。
// ---------------------------------------------------------------------------

const RADIO_DATA = load('radio.json');
const COMMENTARY = load('commentary.json');
const NOTES = load('notes.json');

/** ネストした台詞データから { text, sound_cue } のエントリをすべて拾う。 */
function collectEntries(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectEntries(n, out));
  else if (node && typeof node === 'object') {
    if (typeof node.text === 'string') out.push(node);
    else Object.values(node).forEach((n) => collectEntries(n, out));
  }
  return out;
}
const countOf = (node) => collectEntries(node).length;

test('13. radio.json: 4層それぞれの本数、sound_cue、禁則', () => {
  const R = RADIO_DATA;
  const constant = countOf(R.constant);
  const reaction = countOf(R.reaction);
  const chat = countOf(R.chat);
  console.log(`  常時 ${constant} / 反応 ${reaction} / 雑談 ${chat} / 情報系 ${countOf(R.info)} / ピット ${countOf(R.pit)}`);
  assert.ok(constant >= 50, '常時層は50本以上');
  assert.ok(reaction >= 50, '反応は50本以上');
  assert.ok(chat >= 40, '雑談は40本以上');
  for (const id of RADIO.priority) {
    const def = R.info[id];
    assert.ok(def, `radio.json に ${id} がない`);
    const n = def.lines.length + (def.harsh?.length ?? 0);
    assert.ok(n >= 6, `${id} は6本以上（${n}）`);
  }
  for (const id of RADIO.pit.priority) assert.ok(R.pit[id], `pit に ${id} がない`);

  const all = collectEntries(R);
  for (const e of all) {
    assert.equal(typeof e.sound_cue, 'string', `sound_cue が無い: ${e.text}`);
    assert.ok(!e.text.includes('ハルノート'), `禁則「ハルノート」: ${e.text}`);
  }
  // ハルカの台詞は計器を読まない＝数字を言わない（テンプレートの主人公側は除く）
  const haruka = [...collectEntries(R.info), ...collectEntries(R.reaction), ...collectEntries(R.constant.haruka), ...collectEntries(R.chat)];
  for (const e of haruka) assert.ok(!/[0-9０-９]/.test(e.text) || /3周ちょうだい/.test(e.text), `ハルカが数字を言っている: ${e.text}`);
});

test('14. commentary.json: 各トリガーに2人×5本以上、同じ台詞が無い', () => {
  const C = COMMENTARY;
  const need = ['race_start', 'lap_lead', 'position_change', 'gap_shrink', 'gap_grow', 'best_lap', 'pit', 'retire', 'final_lap', 'checkered'];
  for (const id of need) {
    const t = C.triggers[id];
    assert.ok(t, `commentary.json に ${id} がない`);
    assert.ok(t.announcer.length >= 5, `${id} 実況は5本以上`);
    assert.ok(t.analyst.length >= 5, `${id} 解説は5本以上`);
  }
  const all = collectEntries(C);
  const texts = all.map((e) => e.text);
  assert.equal(new Set(texts).size, texts.length, '同じ台詞が2つ以上ある');
  for (const e of all) {
    assert.equal(typeof e.sound_cue, 'string');
    assert.ok(!e.text.includes('ハルノート'));
  }
  assert.ok(C.profile.some((e) => e.text.includes('17歳')), '経歴に触れる台詞');

  // チェッカーの実況は順位で選び分ける。勝っていないのに「優勝」と言わせないため、
  // when 付きの台詞は条件が立ったときだけ使う。どちらの場合も引ける台詞が残ること。
  const checkered = C.triggers.checkered.announcer;
  for (const e of checkered) {
    assert.ok(!e.when || ['win', 'notwin'].includes(e.when), `未知の when: ${e.when}`);
  }
  for (const tag of ['win', 'notwin']) {
    const usable = checkered.filter((e) => !e.when || e.when === tag);
    assert.ok(usable.length >= 2, `${tag} のとき引ける実況が足りない（${usable.length}本）`);
  }
  const winOnly = checkered.filter((e) => e.when === 'win');
  assert.ok(winOnly.length >= 2, '優勝時の実況が2本以上');
  console.log(`  チェッカー実況: 勝利時に引ける ${checkered.filter((e) => !e.when || e.when === 'win').length} 本 / `
    + `非勝利時 ${checkered.filter((e) => !e.when || e.when === 'notwin').length} 本`);

  console.log(`  実況・解説 合計 ${texts.length} 本（トリガー ${need.length} 種＋性格別・神谷の車・経歴）`);
});

test('15. notes.json: 全ノートが装着できて規定を満たす。クラス5は無い', () => {
  const byCourse = Object.fromEntries(COURSES.map((c) => [c.id, c]));
  for (const n of NOTES) {
    const c = byCourse[n.course];
    assert.ok(c, `コース ${n.course} がない`);
    assert.ok(c.classes.includes(n.class), `${n.course} はクラス${n.class}では走れない`);
    const parts = n.parts.map(part);
    for (const p of parts) {
      assert.ok(p.class_required <= n.class, `${n.course}/${n.class}: ${p.id} は規定外`);
      assert.ok(p.sponsor_tier <= n.class - 1, `${n.course}/${n.class}: ${p.id} はスポンサー段階が足りない`);
    }
    resolveLoadout(parts);   // スロット重複なら例外
    const chassisId = { 1: 'hatchback', 2: 'sedan', 3: 'sedan', 4: 'gt' }[n.class];
    const perf = buildPerformance(parts, haruka, CHASSIS[chassisId], n.settings);
    assert.ok(Number.isFinite(perf.stats.power));
    assert.ok(n.note.length > 0 && !n.note.includes('ハルノート'));
  }
  for (const cls of [1, 2, 3]) {
    for (const c of COURSES.filter((c) => c.classes.includes(cls))) {
      assert.ok(NOTES.some((n) => n.course === c.id && n.class === cls), `クラス${cls} の ${c.id} のノートがない`);
    }
  }
  assert.ok(NOTES.some((n) => n.class === 4), 'クラス4のノートは一部ある');
  assert.ok(!NOTES.some((n) => n.class === 5), 'クラス5のノートは無い（父の記述が尽きる）');
  console.log(`  ノート ${NOTES.length} 冊：クラス別 ${[1, 2, 3, 4].map((k) => `${k}=${NOTES.filter((n) => n.class === k).length}`).join(' ')}`);
});

test('17. 出走台数：コースの grid はクラス別に 8/12/16/20、名簿は20台ぶんある', () => {
  const RIVALS = load('rivals.json');
  const want = { 1: 8, 2: 12, 3: 16, 4: 20, 5: 20 };
  for (const c of COURSES) {
    for (const cls of c.classes) assert.equal(c.grid[cls], want[cls], `${c.id} クラス${cls} の grid`);
    assert.deepEqual(Object.keys(c.grid).map(Number).sort(), [...c.classes].sort(), `${c.id} の grid は classes と対応`);
  }
  assert.ok(RIVALS.length >= 19, '最大20台（自車1＋19）ぶんの名簿');
  assert.equal(new Set(RIVALS.map((r) => r.number)).size, RIVALS.length, 'ゼッケンが重複');
  assert.equal(new Set(RIVALS.map((r) => r.name)).size, RIVALS.length, '名前が重複');
  const profiles = new Set(RIVALS.map((r) => r.profile)), strengths = new Set(RIVALS.map((r) => r.strength));
  assert.equal(profiles.size, 5, '性格は5種');
  assert.deepEqual([...strengths].sort(), ['fast', 'normal', 'slow']);
  console.log(`  名簿 ${RIVALS.length} 台：性格 ${[...profiles].join('/')} × 強さ ${[...strengths].join('/')}`);
});

test('16. パネル用の値：フェード閾値、摩耗の前後、燃料', () => {
  const perf = buildPerformance([part('tire_compound_02'), part('suspension_stabi_01')], haruka, sedan);
  assert.equal(brakeThreshold(perf.stats), 100);
  const split = tireWearSplit(perf, { wear: 0.4, lapsRun: 10 }, haruka);
  assert.ok(split.front > split.rear, 'アンダーの車は前を余計に削る');
  assert.ok(fuelLevel(perf.stats, 0, 10) === 1 && fuelLevel(perf.stats, 10, 10) > 0, '基準車は余裕を残して走り切る');
  const rng = () => 0;   // 必ず出す
  assert.equal(reactionFor({ type: 'straight', time: 10, best: 10 }, rng).sentiment, 'good');
  assert.equal(reactionFor({ type: 'slow_corner', time: 10.2, best: 10 }, rng).sentiment, 'bad');
  assert.equal(reactionFor({ type: 'slow_corner', time: 10, best: Infinity }, rng).sentiment, 'neutral');
  assert.equal(reactionFor({ type: 'straight', time: 10, best: 10 }, () => 0.99), null);
});

test('18. 予選：アタックラップがベストで、アウト／インは流す。空気圧を上げると一発は速い', () => {
  const p = buildPerformance([part('tire_compound_02')], haruka, sedan);
  const q = simulateQualifying(p, course(BALANCED), haruka, { noise: false });
  assert.equal(q.laps.length, QUALI.laps);
  assert.deepEqual(q.laps.map((l) => l.kind), ['out', 'attack', 'in']);
  assert.equal(q.best, q.attack.time, 'ベストはアタックラップ');
  assert.ok(q.laps[0].time > q.attack.time && q.laps[2].time > q.attack.time, 'アウト／インはアタックより遅い');

  // 予選用に空気圧を上げる（温まりが早い）と、決勝の10周平均では損でも一発は得
  const high = buildPerformance([part('tire_compound_02')], haruka, sedan, { tire_pressure: 2.4 });
  const qHigh = simulateQualifying(high, course(BALANCED), haruka, { noise: false });
  const r = simulateRace(p, course(BALANCED), 10, haruka, OPTIONS);
  const rHigh = simulateRace(high, course(BALANCED), 10, haruka, OPTIONS);
  console.log(`  一発: 基準 ${formatTime(q.best)} / 圧高め ${formatTime(qHigh.best)}（${(qHigh.best - q.best).toFixed(3)} 秒）`
    + ` ｜ 10周平均: 基準 ${formatTime(r.average)} / 圧高め ${formatTime(rHigh.average)}（${(rHigh.average - r.average).toFixed(3)} 秒/周）`);
  assert.ok(qHigh.best < q.best, '一発なら圧高めが速いはず');
  assert.ok(rHigh.average > r.average, '10周なら圧高めは損のはず（予選と決勝で別セッティングを持つ理由）');

  // 予選タブでは高い空気圧は文句ではなく「一発なら高めでいい」
  const ctx = { parts: [part('tire_compound_02')], settings: { tire_pressure: 2.5 } };
  assert.equal(pitComment(high, haruka, ctx), 'pressure_high');
  assert.equal(pitComment(high, haruka, { ...ctx, session: 'quali' }), 'quali_pressure_ok');
});

test('19. スタート直後の混雑：前車が近いほど遅く、離れていれば影響なし', () => {
  assert.equal(gridBlockFactor(START.gapSec), 1);
  assert.equal(gridBlockFactor(5), 1);
  assert.ok(Math.abs(gridBlockFactor(0) - (1 - START.maxLoss)) < 1e-9, '差 0 で最大ペナルティ');
  assert.ok(gridBlockFactor(0.5) > gridBlockFactor(0) && gridBlockFactor(0.5) < 1, '単調');
  console.log(`  差 0秒 ×${gridBlockFactor(0).toFixed(2)} / 0.5秒 ×${gridBlockFactor(0.5).toFixed(2)} / ${START.gapSec}秒 ×1.00、グリッド1列 ${START.slotDelay} 秒遅れ`);
});

test('20. 予選のデータ：ノートの予選欄、無線の予選台詞、実況の予選トリガー', () => {
  for (const n of NOTES) {
    assert.ok(n.quali?.note && !n.quali.note.includes('ハルノート'), `${n.course}/${n.class} に予選の書き込みが無い`);
    assert.ok(n.quali.settings.tire_pressure > n.settings.tire_pressure, `${n.course}/${n.class} の予選は空気圧を上げているはず`);
  }
  for (const key of ['out', 'attack_start', 'attack_good', 'attack_bad', 'traffic', 'in', 'done']) {
    assert.ok(RADIO_DATA.quali[key]?.length >= 3, `radio.quali.${key}`);
  }
  assert.ok(RADIO_DATA.chat.quali.length >= 3 && RADIO_DATA.pit.quali_pressure_ok, '予選の雑談とピットの一言');
  for (const id of ['quali_start', 'provisional_top', 'pole', 'quali_end']) {
    const t = COMMENTARY.triggers[id];
    assert.ok(t?.announcer.length >= 5 && t?.analyst.length >= 5, `commentary ${id}`);
  }
  const texts = collectEntries(COMMENTARY).map((e) => e.text);
  assert.equal(new Set(texts).size, texts.length, '予選の台詞を足しても重複なし');
});

test('21. slots.json: キーが実在のスロットで、解説は2〜3文。パーツ名と数値を書かない', () => {
  const SLOT_DESC = load('slots.json');
  const all = Object.values(SLOTS).flat();
  const names = PARTS.map((p) => p.name);
  for (const [slot, def] of Object.entries(SLOT_DESC)) {
    assert.ok(all.includes(slot), `slots.json の "${slot}" は SLOTS に無いスロット`);
    const text = def.slot_description;
    assert.ok(typeof text === 'string' && text.length > 0, `${slot}: slot_description が無い`);
    // 「仕組み → 得るもの → 失うもの」を書くと2〜3文になる（data/README.md）
    const sentences = text.split('。').filter(Boolean).length;
    assert.ok(sentences >= 2 && sentences <= 3, `${slot}: ${sentences}文。2〜3文で書く`);
    // 個別のパーツ名も解禁クラスも書かない（パーツが増減しても直さずに済むように）
    for (const name of names) assert.ok(!text.includes(name), `${slot}: パーツ名「${name}」を書かない`);
    assert.ok(!/クラス\d/.test(text), `${slot}: 解禁クラスは候補リストが出すので書かない`);
    assert.ok(!text.includes('ハルノート'), `${slot}: 呼称ルール（docs/シナリオ/キャラクター.md）`);
  }
  // 現時点では engine の5スロットだけ。書けたところから足していく
  for (const slot of SLOTS.engine) {
    assert.ok(SLOT_DESC[slot], `engine の ${slot} の解説がない`);
  }
  console.log(`  解説 ${Object.keys(SLOT_DESC).length} / 全 ${all.length} スロット`);
});
