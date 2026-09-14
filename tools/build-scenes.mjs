/**
 * 台本（docs/シナリオ/*.md）から data/scenes.json を作る（開発用。配布物に含めない）。
 *
 *   node tools/build-scenes.mjs [--write]
 *
 * **台詞は一字も変えない。** 手で写すと必ずずれるので、台本から機械的に抜く。
 * テスト（race.test.js の 28）が、同じ抜き方で台本と scenes.json を突き合わせる。
 *
 * 台本の表記（docs/シナリオ/クラス5台本.md の「表記」）：
 *   【 】        画面演出・システム → stage（**画面には出さない。実装の指示**）
 *   話者：台詞    → say
 *   　「…」      行頭が全角空白の鉤括弧 → note（ノートや実況に出る文字。画面に出す）
 *   ｛名前｝      → プレイヤー名、｛一行｝ → プロローグで書いた一行（scene.js が差し替える）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 場面の見出し → 場面 id。ここに無い見出しは読み飛ばす。 */
export const SCENE_IDS = {
  '第5場': 'promote5',
  '第6場': 'win',
  '第7場': 'ending',
  '第8場': 'blank',
};

/**
 * 【 】の中身から、実装がすることを決める。**本文は変えない。**
 * ここに当たらない【 】は、場面を進めるだけ（画面には出さない）。
 */
function actionFor(stage) {
  const cue = stage.match(/cue: *([\w.]+)/);
  if (cue) return { do: 'cue', cue: cue[1] };
  if (/^間$/.test(stage)) return { do: 'beat' };
  if (/テキスト入力/.test(stage)) return { do: 'input' };
  if (/スタッフロール/.test(stage)) return { do: 'credits' };
  if (/フェードアウト|暗転/.test(stage)) return { do: 'fade' };
  if (/書き足す|書かれる演出/.test(stage)) return { do: 'write' };
  if (/ノートが開く|ページが映る|ページがめくられ|白紙。そこに/.test(stage)) return { do: 'note' };
  return null;
}

/** 台本1本を場面の配列にする。 */
export function parseScript(md) {
  const scenes = [];
  let scene = null;
  let radio = null;
  const radios = {};
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();

    // 場面の見出し
    const head = line.match(/^## +(第\d場)　(.+)$/);
    if (head) {
      const id = SCENE_IDS[head[1]];
      scene = id ? { id, title: `${head[1]}　${head[2]}`, steps: [] } : null;
      radio = null;
      if (scene) scenes.push(scene);
      continue;
    }
    // 本編差し込みの小見出し（無線）
    if (/^## /.test(line)) { scene = null; radio = null; continue; }
    const sub = line.match(/^### +(.+)$/);
    if (sub) { radio = { when: sub[1], lines: [] }; radios[sub[1]] = radio; scene = null; continue; }
    if (!scene && !radio) continue;

    // 【 】＝演出。画面には出さない
    const stage = line.match(/^【(.+)】$/);
    if (stage && scene) {
      scene.steps.push({ stage: stage[1], ...(actionFor(stage[1]) ?? {}) });
      continue;
    }
    if (stage) continue;

    // 　「…」＝ノートや実況に出る文字。画面に出す
    const note = raw.match(/^　+「(.+)」$/) ?? raw.match(/^　+「(.+)$/);
    if (note) {
      const text = note[1].replace(/」$/, '');
      if (scene) scene.steps.push({ note: text });
      else radio.lines.push({ note: text });
      continue;
    }

    // 話者：台詞
    const say = line.match(/^([^：:【\-#]+)：(.*)$/);
    if (say) {
      const step = { say: say[1], text: say[2] };
      if (scene) scene.steps.push(step);
      else radio.lines.push(step);
    }
  }
  return { scenes, radios };
}

/**
 * 本編差し込みの小見出し → radio.json のトリガー。
 * `once` は一度だけ、`where` は出す画面（setup＝セッティング画面 / race＝決勝のあと）。
 */
export const RADIO_TRIGGERS = [
  { id: 'class5_first_works', once: true, where: 'setup', match: /ワークス部品を初めて装着/ },
  { id: 'class5_first_reinforce', once: true, where: 'setup', match: /補強部品を初めて見た/ },
  { id: 'class5_works_retire', once: false, where: 'race', match: /リタイアしたとき/ },
  { id: 'class5_braced_finish', once: true, where: 'race', match: /完走したとき/ },
];
/** クラス5のシーズン末の一行（season_note.class5）。 */
const SEASON_NOTE = /シーズン終了時のノートの一行/;

/** 話者名 → radio.json の speakers のキー。 */
const SPEAKER = { ハルカ: 'haruka', 主人公: 'player' };

const md = readFileSync(join(ROOT, 'docs', 'シナリオ', 'クラス5台本.md'), 'utf8');
const { scenes, radios } = parseScript(md);

/** 台本の差し込みを radio.json の形にする。 */
function buildRadio() {
  const class5 = {
    _comment: 'tools/build-scenes.mjs が docs/シナリオ/クラス5台本.md から作る。**手で直さない。**',
  };
  for (const t of RADIO_TRIGGERS) {
    const found = Object.entries(radios).find(([when]) => t.match.test(when));
    if (!found) throw new Error(`台本に見出しが無い: ${t.id}`);
    class5[t.id] = {
      when: found[0],
      once: t.once,
      where: t.where,
      lines: found[1].lines.map((l) => ({ speaker: SPEAKER[l.say] ?? l.say, text: l.text, sound_cue: '' })),
    };
  }
  const note = Object.entries(radios).find(([when]) => SEASON_NOTE.test(when));
  return { class5, seasonNote: note[1].lines.map((l) => ({ text: l.note, sound_cue: '' })) };
}
const { class5, seasonNote } = buildRadio();
const out = `${JSON.stringify({
  _comment: 'tools/build-scenes.mjs が docs/シナリオ/クラス5台本.md から作る。**手で直さない。** 台本を直してから作り直す。',
  scenes,
}, null, 2)}\n`;

if (process.argv.includes('--write')) {
  writeFileSync(join(ROOT, 'data', 'scenes.json'), out);
  // radio.json は手書きのものが大半なので、**クラス5のぶんだけ差し替える**
  const radioPath = join(ROOT, 'data', 'radio.json');
  const radio = JSON.parse(readFileSync(radioPath, 'utf8'));
  radio.class5 = class5;
  radio.season_note.class5 = seasonNote;
  writeFileSync(radioPath, `${JSON.stringify(radio, null, 2)}\n`);
  console.log(`data/radio.json を更新：class5 ${RADIO_TRIGGERS.length} トリガー、season_note.class5 ${seasonNote.length} 本`);
  console.log(`data/scenes.json を書き出した：${scenes.length} 場面`);
  for (const s of scenes) {
    const says = s.steps.filter((x) => x.say).length;
    console.log(`  ${s.id.padEnd(9)} ${s.title}　台詞 ${says} / 全 ${s.steps.length} 手`);
  }
  console.log(`無線の差し込み ${Object.keys(radios).length} 種：`);
  for (const [when, r] of Object.entries(radios)) console.log(`  ${r.lines.length} 本 — ${when}`);
} else {
  process.stdout.write(out);
}
