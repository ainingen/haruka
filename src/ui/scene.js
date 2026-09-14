/**
 * 場面（台本）を1行ずつ送る。紙の層（docs/設計/画面設計.md）。
 *
 * **台詞は持たない。** `data/scenes.json`（tools/build-scenes.mjs が台本から作る）を受け取って流すだけ。
 * プロローグにもそのまま使う前提で、画面に依らない形にしてある。
 *
 * ## 台本の形（scenes.json の steps）
 *
 *   { say: '話者', text: '台詞' }   話者名＋台詞を1行。**クリック／タップで次へ**
 *   { note: '文字' }                ノートや実況に出る文字。台詞と別の見た目で出す
 *   { stage: '…', do: '…' }        台本の【 】。**画面には出さない。実装の指示**
 *
 * `do` は build-scenes.mjs が【 】から拾ったもの：
 *
 *   cue    演出のイベントを投げる（`cue` に名前。音はまだ無い）
 *   beat   【間】。押さずに少し待つ
 *   note   ノートを開く／めくる
 *   write  ノートに字が書かれる
 *   input  プレイヤーがテキストを書く（`onInput` が受ける）
 *   credits スタッフロール（`onCredits` が受ける）
 *   fade   暗転
 *
 * ## 差し込み
 *
 *   ｛名前｝  プレイヤー名   ｛一行｝  プロローグでハルカが書いた一行
 *
 * ## 使い方
 *
 *   await playScene(scene, host, { vars, speakerLabel, cue, onInput, onCredits });
 *
 * host は場面を描く空の要素。終わると中身を空にして戻る。
 */

/** 差し込みの書き方。台本の ｛ ｝ はこの2つだけ。 */
export const VARS = ['名前', '一行'];

/** ｛ ｝ を置き換える。知らない名前はそのまま残す（台本の間違いに気づけるように）。 */
export function fill(text, vars = {}) {
  return String(text ?? '').replace(/｛(.+?)｝/g, (m, k) => vars[k] ?? m);
}

/** 台詞だけを抜く（テストと、長さの見積もりに使う）。 */
export const linesOf = (scene) => scene.steps.filter((s) => s.say).map((s) => `${s.say}：${s.text}`);

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** 【間】の長さと、字が出る速さ。 */
export const SCENE = { beatMs: 700, fadeMs: 600, writeMs: 900, turnMs: 500 };

/**
 * 場面を流す。最後まで送ると解決する。
 *
 * @param {object} scene  scenes.json の1場面
 * @param {HTMLElement} host  描く場所（中身は作り直す）
 * @param {object} opts
 *   vars          ｛ ｝ の差し込み（{ 名前, 一行 }）
 *   speakerLabel  話者名の表示（'主人公' をプレイヤー名にするなど）
 *   cue           演出イベント（name, detail）
 *   onInput       { do:'input' } のときに呼ぶ。書いた文字を返す（Promise 可）
 *   onCredits     { do:'credits' } のときに呼ぶ
 *   onStage       演出ごとに呼ぶ（背景の切り替えなど）
 */
export async function playScene(scene, host, opts = {}) {
  const {
    vars = {}, speakerLabel = (s) => s, cue = () => {},
    onInput = null, onCredits = null, onStage = null,
  } = opts;

  host.textContent = '';
  host.classList.add('scene');
  const log = document.createElement('div');
  log.className = 'scene-log';
  host.appendChild(log);
  const hint = document.createElement('div');
  hint.className = 'scene-hint';
  hint.textContent = '▸ クリックで次へ';
  host.appendChild(hint);

  /** 次に進むまで待つ。クリック・タップ・Enter・Space。 */
  let go = null;
  const advance = (ev) => { if (!ev.key || ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault?.(); go?.(); } };
  host.addEventListener('click', advance);
  document.addEventListener('keydown', advance);
  const nextClick = () => new Promise((done) => { go = done; });

  const add = (cls, html) => {
    const row = document.createElement('div');
    row.className = cls;
    row.innerHTML = html;
    log.appendChild(row);
    row.scrollIntoView({ block: 'end', behavior: 'smooth' });
    return row;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  try {
    for (const step of scene.steps) {
      if (step.say) {
        const who = speakerLabel(step.say);
        add('scene-say', `<span class="who">${esc(who)}</span><span class="line">${esc(fill(step.text, vars))}</span>`);
        hint.hidden = false;
        await nextClick();
        continue;
      }
      if (step.note) {
        add('scene-note', esc(fill(step.note, vars)));
        hint.hidden = false;
        await nextClick();
        continue;
      }
      // 【 】は画面に出さない。することだけする
      onStage?.(step);
      hint.hidden = true;
      switch (step.do) {
        case 'cue': cue(step.cue, { scene: scene.id }); await wait(SCENE.turnMs); break;
        case 'beat': await wait(SCENE.beatMs); break;
        case 'note': cue('note.turn', { scene: scene.id }); await wait(SCENE.turnMs); break;
        case 'write': cue('note.write', { scene: scene.id }); await wait(SCENE.writeMs); break;
        case 'fade': cue('scene.fade', { scene: scene.id }); await wait(SCENE.fadeMs); break;
        case 'input': if (onInput) await onInput(step, { log, add, esc }); break;
        case 'credits': if (onCredits) await onCredits(step, { log, add, esc }); break;
        default: break;
      }
    }
  } finally {
    host.removeEventListener('click', advance);
    document.removeEventListener('keydown', advance);
    hint.hidden = true;
  }
}
