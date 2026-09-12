# assets/svg

車体シルエット。すべて **ノーズが左、リアウイングが右** で統一、同一縮尺。

| ファイル | クラス |
|---|---|
| `car-hatchback.svg` | クラス1 |
| `car-sedan.svg` | クラス2 |
| `car-gt.svg` | クラス3〜4 |
| `car-formula.svg` | クラス5 |

## 使い方

線色は `currentColor`。親要素の `color` で自車＝赤、AI車＝青を切り替える。

```html
<div style="color: #d32f2f"><!-- 自車 -->
  <object data="assets/svg/car-gt.svg"></object>
</div>
```

インラインで埋め込む場合は `stroke="currentColor"` がそのまま効くので、
CSS 変数や class での色分けも可能。

車高調整で屋根を下げる場合は、上面のパスの y 座標をスクリプトで補正する
（将来的には車高をパラメータ化したテンプレート生成に置き換える）。
