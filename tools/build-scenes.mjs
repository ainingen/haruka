/**
 * 台本（docs/シナリオ/*.md）から data/scenes.json を作る（開発用。配布物に含めない）。
 *
 *   node tools/build-scenes.mjs [--write]
 *
 * **台詞は一字も変えない。** 手で写すと必ずずれるので、台本から機械的に抜く。
 * テスト（season.test.js の S11）が、同じ抜き方で台本と生成物を突き合わせる。
 *
 * 台本の表記（各台本の「表記」）：
 *   【 】        画面演出・システム → stage（**画面には出さない。実装の指示**）
 *   ［ ］        プレイヤー操作 → choose（その場の選択）
 *   話者：台詞    → say
 *   　「…」      行頭が全角空白の鉤括弧 → note（ノートや実況に出る文字。画面に出す）
 *   （高）話者：… 直前の選択の答えで出し分ける台詞 → say + when
 *   ｛名前｝      → プレイヤー名、｛一行｝ → プロローグで書いた一行（scene.js が差し替える）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 場面の見出し → 場面 id。ここに無い見出しは読み飛ばす。 */
export const SCENE_IDS = {
  '第5場': 'promote5',
  '第6場': 'win',
  '第7場': 'ending',
  '第8場': 'blank',
};

/** プロローグの見出し → 場面 id。 */
export const PROLOGUE_IDS = {
  '第1場': 'p1',
  '第2場': 'p2',
  '第3場': 'p3',
  '第4場': 'p4',
};

/** 読む台本。radio＝本編差し込みを持つ、prologue＝［ ］の操作と分岐を持つ。 */
export const SCRIPTS = [
  { file: 'クラス5台本.md', ids: SCENE_IDS, radio: true },
  { file: 'プロローグ台本.md', ids: PROLOGUE_IDS, prologue: true },
];

/**
 * ［ ］の操作 → 選択。**選択肢の文言は UI のもので、台詞ではない**（台詞は台本から抜く）。
 * key は state の `prologue` の枠（src/engine/save.js の PROLOGUE_CHOICES）に合わせる。
 * label は台本の【画面】と［ ］に書かれている語をそのまま使う。
 */
export const CHOICES = [
  {
    match: /空気圧を選ぶ/,
    key: 'pressure',
    options: [
      { id: 'low', label: '低' },
      { id: 'mid', label: '標準' },
      { id: 'high', label: '高' },
    ],
  },
  {
    match: /スプロケットを選ぶ/,
    key: 'sprocket',
    options: [
      { id: 'accel', label: '加速寄り' },
      { id: 'mid', label: '中間' },
      { id: 'top', label: '最高速寄り' },
    ],
  },
  {
    match: /サイドバーを着脱/,
    key: 'sidebar',
    options: [
      { id: 'on', label: '付ける' },
      { id: 'off', label: '外す' },
    ],
  },
];

/**
 * 【 】の中身から、実装がすることを決める。**本文は変えない。**
 * ここに当たらない【 】は、場面を進めるだけ（画面には出さない）。
 */
function actionFor(stage) {
  const cue = stage.match(/cue: *([\w.]+)/);
  if (cue) return { do: 'cue', cue: cue[1] };
  const caption = stage.match(/^テキスト：「(.+)」$/);
  if (caption) return { do: 'caption', text: caption[1] };
  if (/^間$/.test(stage)) return { do: 'beat' };
  if (/^タイトルロゴ$/.test(stage)) return { do: 'title' };
  if (/赤い点（ハルカ）/.test(stage)) return { do: 'race' };
  if (/テキスト入力/.test(stage)) return { do: 'input' };
  if (/スタッフロール/.test(stage)) return { do: 'credits' };
  if (/フェードアウト|暗転/.test(stage)) return { do: 'fade' };
  if (/書き足す|書かれる演出|追記される演出/.test(stage)) return { do: 'write' };
  if (/ノートが開く|ページが映る|ページがめくられ|白紙。そこに|1ページが開く/.test(stage)) return { do: 'note' };
  return null;
}

/** 第8場の自由設定で出す無線（まだ画面が無い。**入れておくだけ**）。 */
const FREE_RADIO = /自由設定での無線/;
/** クラス5のシーズン末の一行（season_note.class5）。 */
const SEASON_NOTE = /シーズン終了時のノートの一行/;
/** 第2場の実況テキスト。走行に添える文字で、送る手にはしない。 */
const LIVE_TEXT = /実況テキスト/;

/**
 * 台本1本を場面の配列にする。
 * @param {string} md 台本
 * @param {object} opts { ids, radio, prologue }
 */
export function parseScript(md, opts = {}) {
  const ids = opts.ids ?? SCENE_IDS;
  const scenes = [];
  const radios = {};
  let scene = null;
  let radio = null;
  let inQuote = false;
  let when = null;      // 直前の（N位）（A）などの分岐。stage や見出しで切れる
  let live = null;      // 実況テキストを溜める走行の手
  let picking = null;   // 選択肢を集めている最中の choose の手

  const push = (step) => {
    if (scene) scene.steps.push(step);
    else if (radio) radio.lines.push(step);
  };
  /** ラベル（高 / A / 1位）→ 分岐の条件。直前の選択の選択肢から引く。 */
  const whenFor = (label) => {
    const pos = label.match(/^(\d)位$/);
    if (pos) return { pos: Number(pos[1]) };
    for (let i = (scene?.steps.length ?? 0) - 1; i >= 0; i -= 1) {
      const step = scene.steps[i];
      if (step.do !== 'choose') continue;
      const opt = step.options.find((o) => o.label === label || o.id === label);
      if (opt) return { [step.key]: opt.id };
    }
    return null;
  };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();

    // 場面の見出し
    const head = line.match(/^## +(第\d場)　(.+)$/);
    if (head) {
      const id = ids[head[1]];
      scene = id ? { id, title: `${head[1]}　${head[2]}`, steps: [] } : null;
      radio = null; when = null; live = null; picking = null;
      if (scene) scenes.push(scene);
      continue;
    }
    if (/^## /.test(line)) { scene = null; radio = null; when = null; continue; }
    if (/^---$/.test(line)) { when = null; live = null; picking = null; continue; }

    // 小見出し。本編差し込み（無線）か、プロローグの［操作N］
    const sub = line.match(/^### +(.+)$/);
    if (sub) {
      when = null; live = null; picking = null;
      if (opts.prologue) { push({ do: 'section', text: sub[1] }); continue; }
      radio = { when: sub[1], lines: [] };
      radios[sub[1]] = radio;
      scene = null;
      continue;
    }
    if (!scene && !radio) continue;

    // 【 】＝演出。画面には出さない
    const stage = line.match(/^【(.+)】$/);
    if (stage) {
      when = null; picking = null;
      // 第8場の【自由設定での無線】は、ここから下が無線。場面の台詞ではない
      if (FREE_RADIO.test(stage[1])) {
        radio = { when: stage[1], lines: [] };
        radios[stage[1]] = radio;
        scene = null;
        continue;
      }
      // 【実況テキスト】の下の文字は、直前の走行に添える（走行が無ければただの演出）
      live = LIVE_TEXT.test(stage[1]) && scene
        ? ([...scene.steps].reverse().find((s) => s.do === 'race') ?? null)
        : null;
      if (live) { live.captions = []; continue; }
      if (scene) scene.steps.push({ stage: stage[1], ...(actionFor(stage[1]) ?? {}) });
      continue;
    }

    // ［ ］＝プレイヤー操作。その場の選択にする
    const op = line.match(/^［(.+)］$/);
    if (op && scene) {
      const def = CHOICES.find((c) => c.match.test(op[1]));
      if (def) scene.steps.push({ stage: op[1], do: 'choose', key: def.key, options: def.options });
      when = null; picking = null;
      continue;
    }

    // 行頭が全角空白＝ノートや実況に出る文字。画面に出す
    if (/^　/.test(raw) && line) {
      // 選択肢を集めている最中（　A「隣、いい？」）
      const opt = picking && line.match(/^([A-Z])「(.+)」$/);
      if (opt) { picking.options.push({ id: opt[1], label: opt[2] }); continue; }
      // 既定文は直前の【テキスト入力】に付ける。画面に出す文字ではなく、入力欄の初期値
      const preset = line.match(/^既定文[^：]*：「(.+)」$/);
      if (preset) {
        const target = [...(scene?.steps ?? [])].reverse().find((s) => s.do === 'input');
        if (target) target.default = preset[1];
        inQuote = false;
        continue;
      }
      const into = scene ? scene.steps : radio.lines;
      const text = line.replace(/^ノート追記：/, '');
      // **閉じていない「 は、閉じるまでを1つにまとめる**（複数行で1つの引用になっている）
      if (inQuote) {
        if (live) live.captions[live.captions.length - 1] += `\n${line.replace(/」$/, '')}`;
        else into[into.length - 1].note += `\n${line.replace(/」$/, '')}`;
        if (/」$/.test(line)) inQuote = false;
        continue;
      }
      const body = text.replace(/^「/, '').replace(/」$/, '');
      if (live) live.captions.push(body);
      else into.push({ note: body });
      inQuote = /^「/.test(text) && !/」$/.test(text);
      continue;
    }
    inQuote = false;

    // （高）ハルカ：… ／（1位）大河：… ＝ 直前の選択や順位で出し分ける台詞
    const branch = line.match(/^（(.+?)）([^：:]+)：(.*)$/);
    if (branch && scene) {
      const cond = whenFor(branch[1]);
      if (cond) { scene.steps.push({ say: branch[2], text: branch[3], when: cond }); continue; }
    }
    // （1位）だけの行。ここから下の台詞にかかる
    const mark = line.match(/^（(.+?)）$/);
    if (mark && scene) {
      const cond = whenFor(mark[1]);
      if (cond) { when = cond; continue; }
    }

    // 話者：台詞
    const say = line.match(/^([^：:【\-#]+)：(.*)$/);
    if (say) {
      // 主人公：（選択肢）＝ここから下の　A「…」が選択肢
      if (/^（選択肢）$/.test(say[2]) && scene) {
        // say を持つ選択肢＝選んだものがその人の台詞になる（操作の選択は say を持たない）
        picking = { stage: `${say[1]}の選択肢`, do: 'choose', key: 'greet', say: say[1], options: [] };
        scene.steps.push(picking);
        continue;
      }
      push({ say: say[1], text: say[2], ...(when ? { when } : {}) });
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

/** 話者名 → radio.json の speakers のキー。 */
const SPEAKER = { ハルカ: 'haruka', 主人公: 'player' };

/** 台本を読む。 */
export const readScript = (file) => readFileSync(join(ROOT, 'docs', 'シナリオ', file), 'utf8');

/** 台本の差し込みを radio.json の形にする。 */
function buildRadio(radios) {
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
  // 第8場の自由設定。画面はまだ無いので where だけ決めて置いておく
  const free = Object.entries(radios).find(([when]) => FREE_RADIO.test(when));
  if (!free) throw new Error('台本に自由設定の無線が無い');
  class5.free_setup = {
    when: free[0],
    once: false,
    where: 'free',
    lines: free[1].lines.map((l) => ({ speaker: SPEAKER[l.say] ?? l.say, text: l.text, sound_cue: '' })),
  };
  const note = Object.entries(radios).find(([when]) => SEASON_NOTE.test(when));
  return { class5, seasonNote: note[1].lines.map((l) => ({ text: l.note, sound_cue: '' })) };
}

/**
 * 台本に無い手を足す。**台詞ではない。システムの手だけ。**
 * 主人公の名前はプレイヤーが入れるが、プロローグの台本には入力の指示が無い。
 * 第4場の「7年後」の直後＝再会の前に置く（名前はここから先の画面で使う）。
 * 既定は src/engine/save.js の DEFAULT_NAME と同じ。
 */
function addSystemSteps(scenes) {
  const p4 = scenes.find((s) => s.id === 'p4');
  if (!p4) return;
  const at = p4.steps.findIndex((s) => s.do === 'caption');
  if (at < 0) throw new Error('第4場に「7年後」のテキストが無い');
  p4.steps.splice(at + 1, 0, { stage: '主人公の名前を入れる', do: 'name', default: '主人公' });
}

/** 台本 → 出力の一式。台本が無ければ投げる。 */
export function build(texts = null) {
  const scenes = [];
  let radios = {};
  for (const script of SCRIPTS) {
    const md = texts?.[script.file] ?? readScript(script.file);
    const out = parseScript(md, script);
    scenes.push(...out.scenes);
    radios = { ...radios, ...out.radios };
  }
  addSystemSteps(scenes);
  const { class5, seasonNote } = buildRadio(radios);
  return { scenes, radios, class5, seasonNote };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();

function main() {
  const { scenes, radios, class5, seasonNote } = build();
  const out = `${JSON.stringify({
    _comment: 'tools/build-scenes.mjs が docs/シナリオ の台本から作る。**手で直さない。** 台本を直してから作り直す。',
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
}
