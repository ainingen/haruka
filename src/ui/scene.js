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
 *   { …, when: { key: 値 } }        分岐。flags と合う手だけ出す（選択の答え・順位）
 *
 * `do` は build-scenes.mjs が【 】と［ ］から拾ったもの：
 *
 *   cue     演出のイベントを投げる（`cue` に名前。音はまだ無い）
 *   beat    【間】。押さずに少し待つ
 *   note    ノートを開く／めくる
 *   write   ノートに字が書かれる
 *   fade    暗転
 *   caption 画面いっぱいの文字（【テキスト：「7年後」】）
 *   section 見出し（［操作1］タイヤ空気圧）
 *   choose  プレイヤーが選ぶ。答えは flags[key] に残り、あとの when で効く
 *   input   プレイヤーがテキストを書く（`onInput` が受ける）
 *   name    プレイヤー名を入れる（`onName` が受ける）
 *   race    点走行を流す（`onRace` が受ける。返した順位が flags.pos に入る）
 *   title   タイトルロゴ（`onTitle` が受ける）
 *   credits スタッフロール（`onCredits` が受ける）
 *
 * ## 差し込み
 *
 *   ｛名前｝  プレイヤー名   ｛一行｝  プロローグでハルカが書いた一行
 *
 * ## 使い方
 *
 *   await playScene(scene, host, { vars, flags, speakerLabel, cue, onInput, onRace, … });
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
export const SCENE = { beatMs: 700, fadeMs: 600, writeMs: 900, turnMs: 500, captionMs: 1400 };

/**
 * 場面を流す。最後まで送ると解決する。
 *
 * @param {object} scene  scenes.json の1場面
 * @param {HTMLElement} host  描く場所（中身は作り直す）
 * @param {object} opts
 *   vars          ｛ ｝ の差し込み（{ 名前, 一行 }）
 *   flags         分岐の答え（{ pressure:'high', pos:1 } など）。**選んだ結果をここに書く**
 *   speakerLabel  話者名の表示（'主人公' をプレイヤー名にするなど）
 *   cue           演出イベント（name, detail）
 *   onInput       { do:'input' } のときに呼ぶ。書いた文字を返す（Promise 可）
 *   onName        { do:'name' } のときに呼ぶ（プレイヤー名の入力）
 *   onRace        { do:'race' } のときに呼ぶ。{ pos } を返すと flags.pos に入る
 *   onTitle       { do:'title' } のときに呼ぶ（タイトルロゴ）
 *   onCredits     { do:'credits' } のときに呼ぶ
 *   onStage       演出ごとに呼ぶ（背景の切り替えなど）
 */
export async function playScene(scene, host, opts = {}) {
  const {
    vars = {}, flags = {}, speakerLabel = (s) => s, cue = () => {},
    onInput = null, onName = null, onRace = null, onTitle = null,
    onCredits = null, onStage = null,
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

  /**
   * 選択。**選ぶまで進まない。** 選んだものは flags に残り、あとの台詞の when で効く。
   * `say` を持つ選択肢は、選んだ文言がその人の台詞になる（第4場の A/B/C）。
   * 持たない選択肢は操作なので、選んだ札だけを残す（第1場の空気圧など）。
   */
  const choose = (step) => new Promise((done) => {
    const box = document.createElement('div');
    box.className = 'scene-choice';
    for (const opt of step.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt.label;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        flags[step.key] = opt.id;
        box.remove();
        cue('scene.choose', { scene: scene.id, key: step.key, id: opt.id });
        if (step.say) {
          add('scene-say', `<span class="who">${esc(speakerLabel(step.say))}</span><span class="line">${esc(opt.label)}</span>`);
        } else {
          add('scene-picked', esc(opt.label));
        }
        done();
      });
      box.appendChild(b);
    }
    box.addEventListener('click', (ev) => ev.stopPropagation());
    log.appendChild(box);
    box.scrollIntoView({ block: 'end', behavior: 'smooth' });
  });

  /** その手を出すか。when の中身がぜんぶ flags と合えば出す。 */
  const shows = (step) => !step.when || Object.entries(step.when).every(([k, v]) => flags[k] === v);

  try {
    for (const step of scene.steps) {
      if (!shows(step)) continue;
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
        case 'name': if (onName) await onName(step, { log, add, esc }); break;
        case 'credits': if (onCredits) await onCredits(step, { log, add, esc }); break;
        case 'section': add('scene-section', esc(step.text)); break;
        case 'caption': {
          const row = add('scene-caption', esc(step.text));
          cue('scene.caption', { scene: scene.id, text: step.text });
          await wait(SCENE.captionMs);
          row.classList.add('done');
          break;
        }
        case 'choose': await choose(step); break;
        case 'race': {
          const out = onRace ? await onRace(step, { log, add, esc }) : null;
          if (out?.pos) flags.pos = out.pos;
          break;
        }
        case 'title': if (onTitle) await onTitle(step, { log, add, esc }); break;
        default: break;
      }
    }
  } finally {
    host.removeEventListener('click', advance);
    document.removeEventListener('keydown', advance);
    hint.hidden = true;
  }
}
