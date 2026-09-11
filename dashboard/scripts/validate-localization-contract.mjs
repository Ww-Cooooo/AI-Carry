import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import { parseSectionedToml } from './asset-route-contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '..', '..')

async function read(path) {
  return readFile(resolve(repositoryRoot, path), 'utf8')
}

function requireFragments(text, label, fragments) {
  for (const fragment of fragments) {
    if (!text.includes(fragment)) throw new Error(`${label} is missing localization contract fragment: ${fragment}`)
  }
}

// Editorial headings may change. Language, install and download destinations
// must still lead to the intended product, not an old version or missing page.
function requireReadmeEntries(text, label, { counterpart, guide, versionPrefix }, version, source) {
  const links = new Set([...text.matchAll(/\]\(<?([^\s)>]+)>?\)/gu)].map(match => match[1]))
  for (const target of [counterpart, source.releases, source.versioned_archive_template.replace('{tag}', `v${version}`)]) {
    if (!links.has(target)) throw new Error(`${label} is missing required destination: ${target}`)
  }
  if (!text.includes(`${source.repository}/blob/main/${guide}`)) {
    throw new Error(`${label} is missing the official ${guide} installation request`)
  }
  if (!new RegExp(`${versionPrefix}\\s*\`${version.replaceAll('.', '\\.')}\``, 'u').test(text)) {
    throw new Error(`${label} version differs from assistant.toml (${version})`)
  }
}

const [readmeZh, readmeEn, installEn, startEn, entryZh, entryEn, i18n, catalog, dashboard, shared, jsxRuntime, jsxDevRuntime, views, viteConfig, tsconfig, localization, territoryPolicy, workshop] = await Promise.all([
  read('README.md'),
  read('README.en.md'),
  read('INSTALL.en.md'),
  read('START-HERE.en.txt'),
  read('dashboard.html'),
  read('dashboard.en.html'),
  read('dashboard/src/lib/i18n.tsx'),
  read('dashboard/src/lib/i18n-catalog.ts'),
  read('dashboard/src/Dashboard.tsx'),
  read('dashboard/src/components/dashboard/Shared.tsx'),
  read('dashboard/src/lib/localized-jsx/jsx-runtime.ts'),
  read('dashboard/src/lib/localized-jsx/jsx-dev-runtime.ts'),
  read('dashboard/src/components/dashboard/Views.tsx'),
  read('dashboard/vite.config.ts'),
  read('dashboard/tsconfig.app.json'),
  read('docs/localization.md'),
  read('core/protocols/TERRITORY_TERMINOLOGY.md'),
  read('dashboard/src/components/dashboard/SkillWorkshop.tsx'),
])

const version = parseSectionedToml(await read('assistant.toml'), 'assistant.toml')[''].product_version
const officialSource = parseSectionedToml(await read('core/upgrade/official-source.toml'), 'official-source.toml')['']
assert.match(version, /^\d+\.\d+\.\d+$/u)
const zhEntry = { counterpart: 'README.en.md', guide: 'INSTALL.md', versionPrefix: '当前版本：' }
const enEntry = { counterpart: 'README.md', guide: 'INSTALL.en.md', versionPrefix: 'Current version:' }
requireReadmeEntries(readmeZh, 'Chinese README', zhEntry, version, officialSource)
requireReadmeEntries(readmeEn, 'English README', enEntry, version, officialSource)

// A rewrite without old headings is valid; broken entrypoints are not.
const archive = officialSource.versioned_archive_template.replace('{tag}', `v${version}`)
const sample = `# A new introduction\n[中文](${enEntry.counterpart}) [ZIP](${archive}) [Changes](${officialSource.releases})\n${officialSource.repository}/blob/main/INSTALL.en.md\nCurrent version: \`${version}\``
assert.doesNotThrow(() => requireReadmeEntries(sample, 'fixture', enEntry, version, officialSource))
for (const [before, after, error] of [
  [archive, archive.replace(`v${version}`, 'v0.0.0'), /required destination/u],
  ['(README.md)', '(missing-readme.md)', /required destination/u],
  ['blob/main/INSTALL.en.md', 'blob/main/wrong-install.md', /installation request/u],
  [`Current version: \`${version}\``, 'Current version: `0.0.0`', /version differs/u],
]) assert.throws(() => requireReadmeEntries(sample.replace(before, after), 'fixture', enEntry, version, officialSource), error)
requireFragments(installEn, 'English installer', [
  'dashboard.en.html',
  'first-use-execution-gates.md',
  'one easy question',
  'the core transaction writes only',
  'an auxiliary failure is reported for targeted retry',
  'create or write a GitHub repository',
])
requireFragments(startEn, 'English ZIP entry', ['INSTALL.en.md', 'dashboard.en.html', 'first-use-execution-gates.md'])
requireFragments(entryZh, 'Chinese dashboard entry', ['dashboard/dist/index.html', 'ac_kind', 'ac_ref', 'ac_version'])
requireFragments(entryEn, 'English dashboard entry', ['lang="en"', 'ac_lang', '"en"', 'dashboard/dist/index.html', 'ac_kind', 'ac_ref', 'ac_version'])
requireFragments(i18n, 'Dashboard locale runtime', [
  'storedLocale() ?? queryLocale() ?? "zh-Hans"',
  'document.documentElement.lang = locale',
  'localizeAgentRequest',
  'BEGIN CANONICAL AI CARRY REQUEST',
  'Secrets such as API keys',
  'ASSET_NOUN_EN',
  'ASSET_OPERATION_EN',
  '任务命中后按需(读取|执行|调用|参考)',
  '看板缺少足以确认这条(记忆|流程|能力|经验)可用的状态或授权信息',
])
requireFragments(catalog, 'Library status localization', [
  '"可按需使用": "Ready for on-demand use"',
  '"限定试用": "Limited trial"',
  '"复核完成前暂停使用": "Paused until review is complete"',
  '"查看已停止状态": "Check stopped status"',
  '"你始终可以改正或停止它": "You can always correct it or stop using it"',
])
requireFragments(catalog, 'English empty-to-do card localization', [
  '"今天没有待办": "No to-dos today"',
  '"现在没有需要继续的待办": "No to-dos to continue"',
  '"直接告诉 Agent 今天想做什么即可。需要用到的记忆、流程或能力，会在任务开始后再读取。"',
  '"不会一次读完所有内容": "It will not read everything at once"',
  '"当前任务需要什么，就读取什么": "It reads only what the current task needs"',
  '"查看随身资产": "View portable assets"',
])
requireFragments(dashboard, 'Dashboard language control', ['useDashboardLocale', 'locale-switch', 'localizeAgentRequest'])
requireFragments(shared, 'Source-text boundary', ['export function SourceText', 'data-ai-carry-source-text', 'aiCarrySourceText'])
requireFragments(jsxRuntime, 'Localized JSX runtime', ['aiCarrySourceText', 'sourceText ? props : localizeProps(props)'])
requireFragments(jsxDevRuntime, 'Localized JSX development runtime', [
  'react/jsx-dev-runtime',
  'reactJsxDEV',
  'isStaticChildren',
  'localizeJsxProps',
])
requireFragments(viteConfig, 'Localized JSX development cache boundary', [
  'react()',
  "exclude: ['ai-carry-jsx', 'ai-carry-jsx/jsx-runtime', 'ai-carry-jsx/jsx-dev-runtime']",
])
requireFragments(tsconfig, 'Localized JSX compiler source', [
  '"jsxImportSource": "ai-carry-jsx"',
  '"ai-carry-jsx/*": ["./src/lib/localized-jsx/*"]',
])
requireFragments(views, 'Source-text projections', [
  '<SourceText>{profile.displayName}</SourceText>',
  '<SourceText>{headline}</SourceText>',
  '<SourceText as="p">{intro}</SourceText>',
  '<SourceText className="content-card__title">{item.title}</SourceText>',
  '<SourceText className="growth-row__title">{item.title}</SourceText>',
])
requireFragments(workshop, 'Skill workshop localization and source boundary', [
  'Skill 工坊',
  'role="tablist"',
  'Agent 推荐整理的 Skill',
  '我的 Skill',
  '已安装 Skill',
  '接入 Skill',
  '<SourceText as="h3">{asset.item.title}</SourceText>',
  '<SourceText as="strong">{item.title}</SourceText>',
  '<SourceText as="p">{item.summary}</SourceText>',
  'title={label}',
  '查看详情',
  '这个 Skill 是做什么的',
  'buildSkillExportAction',
  '按钮只复制请求',
  'skill.install-shared',
  '点击按钮复制请求并发给 Agent',
  '先在本机检查用途、脚本、依赖、权限和冲突',
  '问题只隔离这一份 Skill',
  '复制检查请求',
])
requireFragments(catalog, 'Skill workshop source guidance localization', [
  '"Skill 工坊内容分类": "Skill Workshop sections"',
  '"Agent 推荐整理的 Skill": "Skills the Agent recommends creating"',
  '"我的 Skill": "My Skills"',
  '"接入 Skill": "Add a Skill"',
  '"点击“复制检查请求”，再把内容发给 Agent"',
  '"Agent 自动处理本地副本"',
  '"Agent 自动检查并生成载体"',
  '"尚未检查完成": "Review not complete"',
  '"查看详情": "View details"',
  '"这个 Skill 是做什么的": "What this Skill does"',
  '"接下来可以做什么": "What you can do next"',
  '"让 Agent 继续检查": "Ask the Agent to continue the review"',
  '"让 Agent 准备分享": "Ask the Agent to prepare sharing"',
  '"让 Agent 说明并处理问题": "Ask the Agent to explain and address the issue"',
  '"按钮只复制请求": "The button only copies a request"',
  '"你可以给 Agent 下面任意一种来源": "Give the Agent any one of these sources"',
  '"ZIP 文件": "ZIP file"',
  '"Skill 链接": "Skill link"',
  '"告诉 Agent 你现在拿到的文件、页面或描述，它会先帮你判断。"',
  '"复制检查请求": "Copy review request"',
  '"需要判断是否有流程": "Check whether it contains a workflow"',
  '"这份本地 Skill 已通过当前检查，可以进入分享预览。它不会自动发送或公开；你仍需指定接收方并授权。"',
])
requireFragments(localization, 'Localization policy', [
  'Simplified Chinese is the default',
  'Unknown strings and user-authored',
  'IP address or geographic location is never used',
  'Use “assistant,” never “companion.”',
  '中国台湾',
  'Taiwan, China',
])
requireFragments(territoryPolicy, 'Territory terminology policy', [
  '中国台湾',
  '中国香港',
  '中国澳门',
  'Taiwan, China',
  'Hong Kong SAR, China',
  'Macao SAR, China',
  '用户写入的记忆、能力、SOP、经验',
  '普通启动、普通任务和不涉及地域表达的只读操作不加载本文',
])

if (/https?:\/\//i.test(i18n) || /fetch\s*\(/.test(i18n)) {
  throw new Error('Dashboard locale runtime must not use a network translator or remote request.')
}
if (/searchParams\.set\(["']ac_lang["'],\s*["']en["']\)/.test(entryZh)) {
  throw new Error('Chinese dashboard entry must not force English.')
}

const keys = [...catalog.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((match) => match[1])
const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index)
if (duplicates.length) throw new Error(`Localization catalog contains duplicate keys: ${[...new Set(duplicates)].join(', ')}`)
if (keys.length < 300) throw new Error(`Localization catalog is unexpectedly small: ${keys.length} reviewed entries.`)

console.log(`Localization contract passed: Chinese default, English install entry, ${keys.length} reviewed dashboard strings, offline runtime, canonical-request preservation, and user-content non-translation policy aligned.`)
