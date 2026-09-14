# タイトルの絵

`haruka.png` をここに置く。**index.html の canvas（`src/ui/title.js`）が敷く。**

- 置かなくても壊れない。絵が無ければ地色（`--ink`）＋題だけで出る
- 論理サイズ 1200×900 に `object-fit: cover` と同じ切り取りで敷く。
  切り取りの中心は `TITLE.focus`（既定 x 0.5 / y 0.18 ＝ 上寄り。顔を残すため）
- **題は左半分に置く**ので、人物は右寄り・左は工具棚などのボケが空いている絵が合う
- 左だけ暗くする幕（`TITLE.veil`）を重ねてから題を描く。左端が明るくても読める
- 大きさの目安：長辺 1600px 前後の PNG。PLiCy に上げる ZIP に丸ごと入るので、
  重すぎるものは避ける（`node tools/pack-plicy.mjs` で一式の大きさが出る）

構図を変えたいときは `src/ui/title.js` の `TITLE`（band / pad / focus / veil）だけ触る。
