# 开源合规与第三方来源

本文说明 AI Carry 怎样区分项目原创内容、npm 依赖、改写源码、字体、构建工具和仅供参考的外部资料。它面向维护者和贡献者，不进入普通助手启动上下文，也不代替任何许可证正文或法律意见。

## 1. 许可边界

- AI Carry 原创代码、配置、模板和文档按根目录 `LICENSE` 中的 Apache License 2.0 提供。
- 第三方内容不因进入 AI Carry 而改用 Apache-2.0；其原许可证、版权、NOTICE、修改要求和其他条件继续有效。
- 贡献者只能提交自己有权按项目许可证提供的内容，或明确登记并遵守上游许可证的第三方内容。
- 未确认公开版权主体名称时，不猜写维护者个人身份；Git 历史、贡献记录与将来经维护者确认的公开署名分别处理。

正式第三方声明真源是根目录 `THIRD_PARTY_NOTICES.md`。随离线看板分发的机器清单和许可证正文位于 `dashboard/public/licenses/`，构建后原样复制到 `dashboard/dist/licenses/`。

## 2. 当前资产分类

### 项目原创或程序化生成

本项目的 Markdown/TOML 架构、业务代码、界面、蓝色小电视品牌派生和线稿收纳包用于当前产品；旧行星代码只是历史实现，不代表当前画面。图片、图标和无个人资料的中英文空模板截图登记在 `docs/assets/project-assets.json`。MiSans 字体与许可 PDF 单独在字体清单登记。Electron 运行时只进入正式应用包，不进入源仓库，其原始版权声明随包保留。

### npm 运行依赖

准确生产依赖闭包来自 `dashboard/package-lock.json` 中非开发条目。当前生产包主要使用 MIT、Apache-2.0、ISC、0BSD 或 BSD-3-Clause；GSAP 与 @gsap/react 另用已审查的 GSAP Standard License，不标成 Apache 或 OSI 开源；其中 BSD-3-Clause 来自 React Flow 关系布局所需的 `d3-ease`，许可证正文随离线产物保留。准确数量由机器清单给出。机器清单与完整许可证／NOTICE 文本分别是：

- `dashboard/public/licenses/dashboard-production-dependencies.json`
- `dashboard/public/licenses/dashboard-production-dependencies.txt`

`dashboard/scripts/generate-third-party-notices.mjs` 从已安装的锁定版本重新生成它们；正式构建先检查清单没有漂移。上游 npm 包漏装许可证时，只能在 `dashboard/license-overrides/` 保存来自固定官方提交的准确副本并说明原因，不能根据 SPDX 名称自行编造版权文字。

### 改写后留在仓库中的第三方源码

按钮、徽章、对话框和 `cn` 工具函数来自 shadcn/ui 的 New York v4 模板并经过项目修改，部分 Tailwind v4 主题脚手架结构也用于 `dashboard/src/index.css`。这类代码不是 npm 依赖，必须单独登记：

- 来源映射：`dashboard/public/licenses/source-code/source-components.json`
- MIT 正文：`dashboard/public/licenses/source-code/shadcn-ui-MIT.txt`

来源映射固定到完整上游提交，列出本地文件、上游文件、修改关系、版权与许可证摘要。以后复制新的组件、代码片段或模板时必须新增映射，不能只因为代码“可以复制”就省略许可证。

### 字体

当前分发官方 MiSans Regular、Medium、Semibold WOFF2，保持上游字节不变，适用随包小米许可。来源、原包条目与摘要见 `dashboard/public/fonts/font-manifest.json`，许可正文是同目录 MiSans-License.pdf。允许随本应用分发不等于允许单独再分发或售卖字体。

### 构建工具

Vite、TypeScript、Tailwind 构建插件、类型包及其传递依赖只用于生成离线看板，不随最终安装包分发，`node_modules` 也绝不进入候选。当前锁文件内构建条目的许可证集合为 MIT、Apache-2.0、ISC、0BSD、BSD-3-Clause 与 MPL-2.0；MPL-2.0 条目是 Lightning CSS 的平台构建包，不是浏览器运行代码。

锁文件仍保留准确版本和 SPDX 元数据。若构建工具代码、二进制或 NOTICE 将来被直接复制进分发包，就必须改按“随包第三方内容”登记，不能继续只视为本地工具。

### 外部资料和产品名称

架构文档会引用 Anthropic、CloudEvents、Kubernetes、Microsoft、RFC、Three.js、Motion、Radix、Astro、Lenis 等官方资料来解释设计依据。这些链接是参考来源，不表示其网页正文或示例代码已复制进项目。需要复制内容时必须重新判断许可证、引用范围与声明义务。

Codex、Claude Code、DeepSeek、QoderWork 等名称只用于兼容示例。项目不随包提供其 Logo、模型、客户端或商标素材，也不暗示从属、授权或背书关系。

## 3. 自动门禁

看板目录提供三层检查：

1. `npm run check:licenses`：生产依赖清单、版本、许可证文本和 NOTICE 与锁文件保持一致。它是维护者开发／发布检查，需要在隔离开发或候选副本中按锁文件准备依赖；普通安装实例和没有 `node_modules` 的干净源码包不需要运行，也不能把缺少开发依赖误判成实例损坏。
2. `npm run check:compliance`：检查项目许可证、已审核 SPDX 集合、shadcn/ui 来源映射、字体来源与转换证据、许可证摘要，以及未登记二进制文件和误提交的 `node_modules`。普通本地构建只允许忽略安装工具实际放在 `dashboard/node_modules/` 的依赖，根目录或其他位置的同名目录仍会失败。

该检查支持两种明确入口：在 Git 工作区中使用 Git 的公开文件集合；在 GitHub 自动生成、没有 `.git` 元数据的源码 ZIP 中，使用 `dashboard/public/licenses/public-distribution-files.json` 这份严格排序的公开分发清单。普通本地构建使用显式的本地依赖模式，只忽略安装工具实际放在 `dashboard/node_modules/` 的依赖；正式候选与源码归档发布门使用严格归档模式，遍历整棵目录，并拒绝维护者私密目录、非占位的 `.assistant-*` 内容、被写入正文的非空 `.gitkeep`、任意位置的 `node_modules`、未登记普通文件、符号链接和其他非常规文件，不能先忽略再宣称整包干净。公开文件发生变化时，维护者先运行 `npm run compliance:manifest` 更新清单，再运行正式构建；清单缺失、损坏、重复、乱序、含危险路径或与候选不一致都会失败关闭。
3. `npm run build`：运行少量产品生命线并生成离线看板，确认最终 `dist` 没有远程资源。它不再把全部专项检查和历史发布证明塞进每次开发构建。
4. `npm run check:release`：只在准备公开候选时运行当前版本身份、私密边界、许可证、合规和正式空模板检查。历史版本正文不因普通开发改动反复参加构建。

README 等文档中的项目截图也属于受管资产。门禁会根据 `docs/assets/project-assets.json` 核对路径、SHA-256、生成来源和 Apache-2.0 声明，避免个人实例截图或来源不明的视觉素材被顺手提交。

公开内容扫描只接收已审核并在该清单登记的项目图像、图标和空模板截图，且图片必须与登记字节相符；其他未知二进制仍被拒绝。素材清单也属于固定发布来源的一部分，不能临时补写允许项绕过检查。图片新增或内容改变时仍须人工查看：登记和摘要不能证明画面没有私密信息，也不能代替许可证审查。

门禁只证明候选符合已经编码的规则，不代替人工来源判断。新增第三方内容时应先审查再登记，不能先把未知内容加入允许集合以消除报错。

## 4. 新增内容检查

贡献者加入代码、字体、图标、图片、模型、动画、模板、数据集或文档摘录前，至少回答：

1. 谁创建了它，来源能否固定到官方页面、版本、提交或文件摘要？
2. 许可证是否允许复制、修改、商业使用和开源再分发？
3. 是否含 NC、ND、仅限个人使用、仅限某平台、不可再分发或来源不明条款？这些内容默认不能进入公开候选。
4. 是否必须保留版权、许可证、NOTICE、作者名单、修改说明、同许可源码或 Reserved Font Name？
5. 它是实际随包内容、改写源码、运行依赖、构建工具，还是只在文档中引用？声明位置必须与真实关系一致。
6. 最终离线包是否仍能找到许可证和来源说明？

无法确认时先停止纳入候选，保留本地研究记录并向维护者说明不确定性；不能把“网上能下载”“免费”“AI 生成”或“别的开源项目也用了”当作开源授权。

## 5. 公开候选复核

每次公开候选仍需以最终文件集合重新检查，而不是沿用旧报告：

- 根 `LICENSE`、`THIRD_PARTY_NOTICES.md` 与本文件存在；
- npm 许可证清单与准确锁文件一致；
- 字体、改写源码及所有新增二进制素材都有固定来源、摘要和随包许可证；
- 没有维护者私密流程、本地工具链、`node_modules`、缓存、日志、秘密凭据或个人实例数据；
- 候选 ZIP 解压后仍能离线打开，并能从最终目录访问许可证材料。

完成合规检查只表示候选内容通过这一项门禁，不等于已经获得创建仓库、远程写入、打标签或发布 Release 的授权。
