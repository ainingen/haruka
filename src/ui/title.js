/**
 * タイトルの絵（canvas）。**PLiCy はページの最初の canvas からサムネイルを撮る**ので、
 * これが index.html の body の最初の要素になる。ここには絵と題だけを描き、
 * ボタンは canvas の外に HTML で置く。
 *
 * - 論理サイズは固定（TITLE.w × TITLE.h）。表示は CSS で伸縮させ、
 *   描画は devicePixelRatio ぶん上げる（サムネイルが潰れない）
 * - **画像が無くても成立する。** 地色と題だけ先に描き、画像が読めたら描き直す
 *   （PLiCy が早く撮っても真っ白にならない）
 * - 色は theme.css の変数から取る。canvas は変数を解釈しないので、読んで文字列にする
 * - 日本語の書体は同梱していないので、既定のゴシックに任せる
 */

/** 絵の大きさと、文字の置き方。**サムネイルの構図はここだけで決まる。** */
export const TITLE = {
  /** 写真が縦長（3:4）なので、絵も縦長の 4:5。**顔と足元の両方が入る形。** */
  w: 1200,
  h: 1500,
  /** 題の幅の上限（幅に対する割合）。左右中央揃えで、この幅に収める。 */
  band: 0.82,
  /** 左右の余白（論理 px）。 */
  pad: 44,
  /** 上段と下段。下段は上段の約2倍の字。 */
  top: 'ハルカの',
  bottom: 'セッティングノート',
  topScale: 0.5,
  /**
   * 題の上に置く小さなラテン。**同梱している等幅（画面の層の書体）で組む。**
   * 字間を大きく開け、両側に細い罫を伸ばす。
   */
  kicker: { text: 'SETTING NOTE', scale: 0.2, tracking: 0.42, rule: 0.42 },
  /** 題の下の帯（レーシングスーツの白赤）。幅は題に対する割合。 */
  stripe: { width: 0.3, red: 7, white: 3, gap: 5 },
  /** 題の下端を、絵の下からどれだけ上に置くか（高さに対する割合）。**下三分の一**。 */
  baseline: 0.1,
  /**
   * 絵の切り取り位置（0＝左/上、1＝右/下）。**下寄せ**。
   * 題は足元のコンクリートの上に置くので、下を切らない。余るぶんは上（天井）から切る。
   */
  focus: { x: 0.5, y: 0.9 },
  /** 下を暗くする幕。from から下が濃くなる（足元のコンクリートの上で白文字を読ませる）。 */
  veil: { alpha: 0.66, from: 0.5 },
  /** 画像のパス（index.html からの相対）。 */
  image: 'assets/title/haruka.png',
};

/** theme.css の変数を読む。無ければ控えの色（canvas は var() を解釈しない）。 */
function readColors(root = document.documentElement) {
  const css = getComputedStyle(root);
  const pick = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
  return {
    ground: pick('--ink', '#23211c'),      // 画像が無いときの地
    text: pick('--paper', '#f2efe6'),      // 題の色（紙の白）
    accent: pick('--car', '#c62828'),      // 自車の赤。題の下の帯に一本だけ
    shade: pick('--ink-2', '#6b665c'),
  };
}

/** 帯に収まる字の大きさを探す。**はみ出させない。** */
function fitFont(ctx, text, maxWidth, start) {
  let size = start;
  for (let i = 0; i < 40 && size > 8; i += 1) {
    ctx.font = `700 ${size}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= Math.max(1, Math.round(size * 0.04));
  }
  return size;
}

/** 日本語は既定のゴシック。書体は同梱しない（PLiCy に上げるものを軽くしておく）。 */
const FONT = 'system-ui, "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", sans-serif';
/** ラテンだけは同梱の等幅（画面の層の書体）。assets/fonts/jetbrains-mono-latin.woff2 */
const MONO = '"JetBrains Mono", ui-monospace, Consolas, monospace';

/**
 * 題を描く。画像があってもなくても、同じ位置に同じ大きさで出る。
 * **絵の下三分の一に横組み、左右中央揃え。** 上から順に：
 *
 *   ── SETTING NOTE ──   同梱の等幅。字間を開けて、両側に細い罫
 *      ハルカの           小さい段
 *   セッティングノート      大きい段（白から淡い紙色への縦のグラデーション）
 *        ▬▬               白と赤の帯（スーツの配色）
 *
 * 白い字に黒の細い縁と影を付けるので、下が明るくても読める。
 */
function drawText(ctx, colors) {
  const inner = TITLE.w * TITLE.band - TITLE.pad * 2;
  const x = Math.round(TITLE.w / 2);

  const bottomSize = fitFont(ctx, TITLE.bottom, inner, Math.round(TITLE.h * 0.1));
  const topSize = Math.round(bottomSize * TITLE.topScale);
  const kickSize = Math.round(bottomSize * TITLE.kicker.scale);
  const gap = Math.round(bottomSize * 0.2);
  const kickGap = Math.round(bottomSize * 0.34);
  const stripeH = TITLE.stripe.red + TITLE.stripe.gap + TITLE.stripe.white;
  const blockH = kickSize + kickGap + topSize + gap + bottomSize
    + Math.round(bottomSize * 0.34) + stripeH;
  const y = Math.round(TITLE.h * (1 - TITLE.baseline) - blockH);

  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  const shadow = (size) => {
    ctx.shadowColor = 'rgba(0, 0, 0, .8)';
    ctx.shadowBlur = Math.round(size * 0.28);
    ctx.shadowOffsetY = Math.round(size * 0.05);
  };

  /**
   * 1行引く。**字間を開けると canvas は右端にも同じ幅を足す**ので、
   * 中央揃えのときは半分だけ左に戻して、見た目の中心を合わせる。
   */
  const line = (text, size, ly, { font = FONT, weight = 700, track = 0, fill = null } = {}) => {
    const spacing = Math.round(size * track);
    ctx.letterSpacing = `${spacing}px`;
    ctx.font = `${weight} ${size}px ${font}`;
    const cx = x - spacing / 2;
    shadow(size);
    ctx.lineWidth = Math.max(2, size * 0.05);
    ctx.strokeStyle = 'rgba(0, 0, 0, .6)';
    ctx.strokeText(text, cx, ly);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = fill ?? colors.text;
    ctx.fillText(text, cx, ly);
    return ctx.measureText(text).width - spacing;
  };

  // ── SETTING NOTE ──
  const kickW = line(TITLE.kicker.text, kickSize, y,
    { font: MONO, weight: 400, track: TITLE.kicker.tracking });
  const ruleY = Math.round(y + kickSize * 0.55);
  const ruleLen = Math.round(kickW * TITLE.kicker.rule);
  const ruleGap = Math.round(kickSize * 1.2);
  ctx.save();
  shadow(kickSize);
  ctx.strokeStyle = 'rgba(255, 255, 255, .7)';
  ctx.lineWidth = 2;
  for (const dir of [-1, 1]) {
    const from = x + dir * (kickW / 2 + ruleGap);
    ctx.beginPath();
    ctx.moveTo(from, ruleY);
    ctx.lineTo(from + dir * ruleLen, ruleY);
    ctx.stroke();
  }
  ctx.restore();

  // ハルカの ／ セッティングノート
  const topY = y + kickSize + kickGap;
  line(TITLE.top, topSize, topY, { track: 0.18 });
  const bottomY = topY + topSize + gap;
  const grad = ctx.createLinearGradient(0, bottomY, 0, bottomY + bottomSize);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, colors.text);
  line(TITLE.bottom, bottomSize, bottomY, { track: 0.05, fill: grad });

  // 白と赤の帯
  const stripeY = Math.round(bottomY + bottomSize + bottomSize * 0.34);
  const stripeW = Math.round(inner * TITLE.stripe.width);
  ctx.save();
  shadow(kickSize);
  ctx.fillStyle = colors.accent;
  ctx.fillRect(x - stripeW / 2, stripeY, stripeW, TITLE.stripe.red);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = colors.text;
  ctx.fillRect(x - stripeW / 2, stripeY + TITLE.stripe.red + TITLE.stripe.gap,
    stripeW, TITLE.stripe.white);
  ctx.restore();
  ctx.restore();
}

/** 下を暗くする幕。足元のコンクリートが明るくても題が読める。 */
function drawVeil(ctx) {
  const g = ctx.createLinearGradient(0, TITLE.h * TITLE.veil.from, 0, TITLE.h);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(0.55, `rgba(0, 0, 0, ${TITLE.veil.alpha * 0.55})`);
  g.addColorStop(1, `rgba(0, 0, 0, ${TITLE.veil.alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, TITLE.h * TITLE.veil.from, TITLE.w, TITLE.h * (1 - TITLE.veil.from));
}

/** 絵を切り取って敷く（object-fit: cover と同じ。focus の点を残す）。 */
function drawImage(ctx, img) {
  const scale = Math.max(TITLE.w / img.naturalWidth, TITLE.h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const dx = (TITLE.w - dw) * TITLE.focus.x;
  const dy = (TITLE.h - dh) * TITLE.focus.y;
  ctx.drawImage(img, dx, dy, dw, dh);
}

/**
 * canvas にタイトルを描く。**すぐに地色と題を描き**、画像が読めたら描き直す。
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts { src } 画像のパス（省略時は TITLE.image）
 * @returns {Promise<boolean>} 画像まで描けたか
 */
export async function mountTitle(canvas, opts = {}) {
  const colors = readColors();
  const scale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  canvas.width = Math.round(TITLE.w * scale);
  canvas.height = Math.round(TITLE.h * scale);
  const ctx = canvas.getContext('2d');

  const paint = (img) => {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, TITLE.w, TITLE.h);
    ctx.fillStyle = colors.ground;
    ctx.fillRect(0, 0, TITLE.w, TITLE.h);
    if (img) { drawImage(ctx, img); drawVeil(ctx); }
    drawText(ctx, colors);
  };

  paint(null);   // 画像も書体も待たずに、まず題まで描く

  // 同梱の等幅は、canvas からは読み込みが始まらない。**先に呼んでおく**
  // （間に合わなければ既定の等幅で出る。位置も大きさも変わらない）
  const font = document.fonts?.load(`400 ${Math.round(TITLE.h * 0.02)}px "JetBrains Mono"`)
    ?.catch(() => null) ?? Promise.resolve(null);

  const src = opts.src ?? TITLE.image;
  let img = null;
  try {
    if (src) {
      img = new Image();
      img.src = src;
      await img.decode();
    }
  } catch {
    // 画像が無い・壊れている。**地色と題だけで成立する**ので、絵なしで描き直す
    img = null;
  }
  await font;
  paint(img);
  return !!img;
}
