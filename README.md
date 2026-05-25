# openEarth3D — 3D City Viewer

ブラウザで動作する 3D 都市ビューア。国土地理院の標高 API と航空写真タイル、OpenStreetMap の建物データを組み合わせて、インタラクティブな 3D 地形・建物モデルを生成します。

## 機能

- **リアルタイム地形生成** — 国土地理院 DEM API を使って 32×32 グリッドの精密な地形メッシュを生成
- **航空写真テクスチャ** — 国土地理院シームレス写真タイル (zoom 17) を地形に貼り付け
- **3D 建物モデル** — OpenStreetMap の建物フットプリントを取得し、階数・高さに応じた押し出し (ExtrudeGeometry) を生成
- **インタラクティブ操作** — マウスドラッグ/スクロールで視点を自由に変更 (Three.js OrbitControls)
- **地図クリックで場所選択** — Leaflet ミニマップ上をクリックするだけで座標設定

## 使い方

1. このリポジトリをクローンまたはダウンロード
2. `index.html` をブラウザで開く（ローカルファイルとして直接開いて OK）
3. 緯度・経度を入力するか、地図をクリックして場所を選択
4. 「3D表示を生成」ボタンをクリックして待つ
5. マウスで視点を操作

> **注意**: 外部 API へのリクエストが必要なため、インターネット接続が必要です。

### `plateau.html` を使う場合

PLATEAU ビューアは Cesium を利用しており、Web Worker の都合で `file://` から直接開くと動作しません（`Tracking Prevention blocked access to storage` / `importScripts ... failed to load` エラーになります）。簡易 HTTP サーバ経由で開いてください:

```bash
# プロジェクトフォルダで実行
python -m http.server 8000
# ブラウザで http://localhost:8000/plateau.html を開く
```

## 操作方法

| 操作 | 動作 |
|------|------|
| 左ドラッグ | 視点回転 |
| 右ドラッグ / 中ドラッグ | 平行移動 |
| スクロール | ズームイン/アウト |
| 地図クリック | 中心座標を設定 |

## 技術スタック

| ライブラリ | 用途 |
|-----------|------|
| [Three.js r0.128](https://threejs.org/) | 3D レンダリング |
| [Leaflet 1.9](https://leafletjs.com/) | ミニマップ |
| [国土地理院 DEM API](https://maps.gsi.go.jp/development/elevation.html) | 標高データ |
| [国土地理院シームレス写真](https://maps.gsi.go.jp/development/ichiran.html) | 航空写真タイル |
| [Overpass API](https://overpass-api.de/) | OSM 建物データ |

## データの出典

- 地形・航空写真: [国土地理院](https://www.gsi.go.jp/) (日本全国対応)
- 建物データ: [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright)

## ライセンス

MIT License
