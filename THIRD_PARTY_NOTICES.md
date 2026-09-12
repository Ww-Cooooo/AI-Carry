# 第三方组件与字体声明

AI Carry 的离线网页和 Electron 客户端共用同一套界面。React、GSAP、Lenis、Radix UI、Lucide 和实际引用的依赖编译进页面；图片、MiSans、快照和许可证从本地读取，不加载 CDN。完整锁文件中保留的旧页面依赖也列入许可证清单，不表示每个依赖都会进入当前首页。

## 经修改并纳入源码的组件模板

`dashboard/src/components/ui/button.tsx`、`badge.tsx`、`dialog.tsx` 与 `dashboard/src/lib/utils.ts` 由 [shadcn/ui](https://github.com/shadcn-ui/ui) 的 New York v4 模板改写而来，`dashboard/src/index.css` 也沿用了其 Tailwind v4 主题脚手架结构后进行了大幅重写。项目修改了尺寸、视觉、中文无障碍文案、设计令牌和应用集成；上游部分仍适用 MIT 许可证及 `Copyright (c) 2023 shadcn` 声明。

固定上游提交、逐文件映射、修改关系和许可证摘要位于 `dashboard/public/licenses/source-code/source-components.json`，准确 MIT 文本位于同目录的 `shadcn-ui-MIT.txt`；两者都会复制到最终离线产物。shadcn/ui 不是本项目的 npm 运行依赖，因此必须在生产依赖自动清单之外单独保留这份声明。

## 随看板分发的字体

界面使用 Xiaomi MiSans Regular、Medium、Semibold。三份 WOFF2 与小米官方发布包原文件一致，没有裁剪或修改字形。它们适用小米 MiSans 字体许可，不是 Apache-2.0 或 OFL；允许随本应用使用的范围以随包 `dashboard/public/fonts/MiSans-License.pdf` 为准，不将字体单独售卖或作为字体分发服务。

官方来源、原包条目和摘要记录在 `dashboard/public/fonts/font-manifest.json`。构建后的相同文件位于 `dashboard/dist/fonts/`。旧版 Noto 和 Space Grotesk 字体不再随本次看板分发，历史源码声明仍按其实际来源保留。

## 看板直接运行依赖

准确版本以 `dashboard/package-lock.json` 为准。当前构建基线的直接运行依赖如下：

| 包 | 版本 | 许可 |
| --- | --- | --- |
| GSAP / @gsap/react | 3.15.0 / 2.1.2 | GSAP Standard License（非 OSI 许可证） |
| React / React DOM | 19.2.8 | MIT |
| Three.js | 0.185.1 | MIT |
| Motion | 12.43.0 | MIT |
| React Flow (`@xyflow/react`) | 12.11.3 | MIT |
| Lenis | 1.3.26 | MIT |
| Radix UI | 1.6.7 | MIT |
| Tailwind CSS | 4.3.3 | MIT |
| Lucide React | 1.31.0 | ISC |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| clsx | 2.1.1 | MIT |
| tailwind-merge | 3.6.0 | MIT |

直接与传递生产依赖的机器可读清单和准确许可证全文分别位于：

- `dashboard/public/licenses/dashboard-production-dependencies.json`
- `dashboard/public/licenses/dashboard-production-dependencies.txt`

它们由 `npm run licenses:generate` 从锁文件中已安装的非 dev 依赖生成；正式构建会先验证其与当前锁文件和包元数据一致，再把它们复制到离线产物。

## 仅用于源码构建的工具

Vite 8.2.1、TypeScript 6.0.3、`@vitejs/plugin-react` 6.0.5、`@tailwindcss/vite` 4.3.3 以及 `@types/*` 只用于维护者从源码构建；最终用户双击看板时不会加载这些工具。它们的准确解析版本仍由锁文件固定，许可证随各 npm 包发布。

当前锁文件中的构建专用直接与传递条目只包含 MIT、Apache-2.0、ISC、0BSD、BSD-3-Clause 与 MPL-2.0。`rollup-plugin-visualizer` 只在维护者主动运行包体分析时生成本地报告，不进入页面或最终安装包；MPL-2.0 条目来自 Lightning CSS 的平台构建包。这些工具及 `node_modules` 不进入仓库候选、离线看板或安装压缩包。构建产物继续按其实际包含的运行依赖和改写源码分别携带声明。

## 桌面运行时与项目图像

正式桌面包使用 Electron 44.3.0。Electron 的 LICENSE 与 LICENSES.chromium.html 随运行时原样保留；Chromium、Node.js 及其第三方组件适用各自声明，不改成项目许可证。macOS 包未签名，跨平台构建不代表实机验收。

蓝色小电视是维护者授权公开的品牌派生，线稿收纳包与 README 图示由本项目制作。图片、应用图标及空模板截图登记在 `docs/assets/project-assets.json`；没有导入个人实例正文或私密开发截图。品牌授权不意味着其他个人 IP 资料被公开。界面图标来自 Lucide。文档中的其他 Agent 名称只用于说明使用场景，不表示从属或背书。

GSAP 许可证准确正文保存在 `dashboard/license-overrides/GSAP-standard-license.txt` 并纳入生产依赖声明；它与 MiSans 都不是项目 Apache-2.0 授权的一部分。

AI Carry 自身的原创代码、配置、模板和文档采用根目录 `LICENSE` 中的 Apache License 2.0。本文件只记录第三方材料；这些材料继续适用各自的许可证，不因 AI Carry 的项目许可证而改变。完整合规边界与贡献检查见 `docs/open-source-compliance.md`。正式公开发布前仍须按最终候选文件集合复核许可证文件、第三方声明、版权署名和隐私边界。
