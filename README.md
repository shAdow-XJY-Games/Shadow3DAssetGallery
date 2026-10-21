# Shadow3DAssetGallery

专门承载 Shadow 3D 素材浏览网页与统一目录入口。保留原有 THE COLLECTION / 探索素材布局、全库搜索和筛选、每页 24 件分页浏览、滚动自动加载、渲染图详情及按需 3D 预览。

## 三个仓库的职责

- `shAdow-XJY-Games/Shadow3DAssetGallery`：本网页、统一目录入口 `docs/catalog-v3.json`，以及后续发布的内容寻址目录图 `catalog/v3/<hash-prefix>/<sha256>.json`。
- `shAdow-XJY-Games/Shadow3DAssetLibrary`：冻结的第一资产卷，共 622 件。其既有资产、目录 JSON 和不可变提交继续保留。
- `shAdow-XJY-Games/Shadow3DAssetLibrary02`：接收未来新增资产。第二卷自己的空索引或局部目录不能替换本仓的全局目录。

网页仓不接收 `assets/`、模型、Blender 文件、图像、压缩包或资产生成脚本。预览与下载直接使用资产仓的固定 40 位提交；此仓没有复制任何资产文件。公开可见与可下载不等于开放使用授权；资产保留全部版权。

## 初次迁移的冻结入口

初次迁移逐字保留原 622 件目录入口，未重排资产、修改 sourceId、路径或 SHA-256，也未复制历史目录图：

- 第一卷冻结主线：`3bd5e2f0cb73b1810eaa483a3f42b7721921d094`
- 元数据来源：`shAdow-XJY-Games/Shadow3DAssetLibrary`，固定提交 `6fd0e581c17b06454c809c95e7b7f9e1d4971b90`
- 目录快照：`a8feb64c1743be59f689b6f653d2dcec885bef871254f698586efc5ae71b680f`

旧卷的 GitHub Pages 可以关闭，原提交上的 raw 文件仍是这个入口的来源。不能删除旧资产或旧目录 JSON。初始网页仅带 v3 入口；兼容解析器保留用于已有代码测试，未随迁移复制 v1/v2 历史目录。

## 未来发布

资产 allowlist 与元数据 allowlist 分离：

- 资产：第一卷与第二卷，均须固定提交；Gallery 不能充当资产源。
- 元数据：Gallery 与第一卷，均须固定提交；第二卷不能充当统一目录源。

新增资产发布到第二卷后，在现有 622 件全局 expanded 目录上追加。使用本仓 `gallery/catalog-v3.mjs` 的现有确定性构图接口准备完整统一目录，将新图提交到 Gallery 的 `catalog/v3/`，核验图提交后再更新本仓 `docs/catalog-v3.json`。`pinPagedCatalog` 默认指向 Gallery。旧记录、来源 ID、固定资产提交、路径和哈希必须保持原值。

构图工具不执行网络请求或 Git 写入，也未引入 append-delta 实验。新目录图只保存 JSON 元数据，不携带资产。入口更新前必须对完整图运行 audit，并核对旧记录没有改变。

## 本地检查

需要 Node.js 22+；不需要安装 npm 依赖。

```sh
npm test
npm run check
node gallery/build.mjs /tmp/shadow-gallery-pages-fresh
npm run serve
```

本地页面：`http://localhost:4173/`。运行环境需允许读取 GitHub raw 固定提交。3D 模块通过 HTML import map 固定引用 Three.js 0.180.0 的 jsDelivr 文件。实际浏览器、跨域网络与 WebGL 检查应在有浏览器的环境另行完成；Node DOM/state 测试不冒充浏览器截图验证。

`repository-files.json` 是源码树明确白名单。`npm run check` 拒绝意外文件、资产后缀、二进制内容和符号链接；后续仅额外允许内容与路径 SHA-256 相符的 `catalog/v3/` JSON 节点。`docs/` 发布白名单固定为 9 个文本文件，整个 Pages 包上限 256 KiB。生成的构建包须在本仓之外，避免把产物混入源码树。

GitHub Pages 使用本仓 `main` 分支的 `/docs`。预期地址为 `https://shadow-xjy-games.github.io/Shadow3DAssetGallery/`；仓库内容不自行开启或更改 Pages 设置。
