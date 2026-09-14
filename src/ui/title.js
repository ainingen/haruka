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

/** 既定のゴシック。書体は同梱しない（PLiCy に上げるものを軽くしておく）。 */
const FONT = 'system-ui, "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", sans-serif';

/**
 * 題を描く。画像があってもなくても、同じ位置に同じ大きさで出る。
 * **絵の下三分の一に横組み二段、左右中央揃え。** 白い字に薄い影と細い縁。
 */
function drawText(ctx, colors) {
  const inner = TITLE.w * TITLE.band - TITLE.pad * 2;
  const x = Math.round(TITLE.w / 2);

  const bottomSize = fitFont(ctx, TITLE.bottom, inner, Math.round(TITLE.h * 0.1));
  const topSize = Math.round(bottomSize * TITLE.topScale);
  const gap = Math.round(bottomSize * 0.24);
  const blockH = topSize + gap + bottomSize;
  const y = Math.round(TITLE.h * (1 - TITLE.baseline) - blockH);

  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0, 0, 0, .75)';
  ctx.shadowBlur = Math.round(bottomSize * 0.22);
  ctx.shadowOffsetY = Math.round(bottomSize * 0.04);
  ctx.lineJoin = 'round';

  const line = (text, size, ly) => {
    ctx.font = `700 ${size}px ${FONT}`;
    ctx.lineWidth = Math.max(2, size * 0.045);
    ctx.strokeStyle = 'rgba(0, 0, 0, .55)';
    ctx.strokeText(text, x, ly);
    ctx.fillStyle = colors.text;
    ctx.fillText(text, x, ly);
  };
  ctx.letterSpacing = `${Math.round(topSize * 0.14)}px`;
  line(TITLE.top, topSize, y);
  ctx.letterSpacing = `${Math.round(bottomSize * 0.05)}px`;
  line(TITLE.bottom, bottomSize, y + topSize + gap);
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

  paint(null);   // 画像を待たずに、まず題まで描く

  const src = opts.src ?? TITLE.image;
  if (!src) return false;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    paint(img);
    return true;
  } catch {
    // 画像が無い・壊れている。**地色と題だけで成立する**ので、そのままにする
    return false;
  }
}
