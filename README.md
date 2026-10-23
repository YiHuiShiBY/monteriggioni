# Monteriggioni · 照片重建小镇

从三张航拍照片重建的托斯卡纳中世纪小镇：以照片测量为起点，在 Blender 中逐块还原 Monteriggioni 的城墙轮廓、十四座方塔与两座城门；城内沿街红瓦民居围着中央广场展开，Santa Maria Assunta 教堂立在最高处，城墙外是连绵起伏的托斯卡纳丘陵与田园。本仓库是它的网页实时渲染版。

**在线演示**：[仪绘士 · 画境长廊](https://yihuishi.com) —— 作品 02「Monteriggioni · 照片重建小镇」。

## 运行方式

纯静态、零构建、零外部依赖：Three.js 已内置在 `vendor/`，模型内置在根目录与 `assets/`，启动后不需要联网。页面使用 ES Module，请通过任意静态服务器打开（直接双击 `index.html` 会受浏览器 file:// 限制）：

```bash
python -m http.server 4173
```

然后访问 `http://127.0.0.1:4173/`。模型约 28 MB，首次载入请稍候。

## 操作

| 操作 | 说明 |
|---|---|
| 拖动 / 滚轮 / 右键 | 旋转 / 缩放 / 平移 |
| `1` – `4` | 切换机位 |
| `Q` / `W` / `E` / `R` | 晴 / 夜 / 雨 / 雪 |
| `F` | 进入行走模式（`WASD` 移动） |

## 场景构成

- `Monteriggioni.glb`：Blender 照片重建工程导出的主体场景（城墙、十四座方塔、两座城门、教堂与民居）
- `assets/character.glb`：行走模式的角色模型
- `scene_manifest.json`：场景装配清单
- 269 株橄榄树与橡树、36 张实时程序化贴图；共约 28 MB

## 技术栈

Three.js（本地内置副本，许可见 `vendor/LICENSE.three.txt`，MIT）+ glTF。无构建流程、无框架、无运行时外部请求。

## 声明与许可

- 基于照片测量的艺术复原，不宣称精确测绘。
- 第三方组件：[Three.js](https://github.com/mrdoob/three.js)（MIT，全文见 `vendor/LICENSE.three.txt`）。
- 除上述第三方组件外，本仓库的代码与内容**保留所有权利**。
