import {checkPackagedFonts} from './packaged-fonts.mjs';
// Post-build assertion for the actual file:// deliverable. This is intentionally
// a developer/build check only; end users still open dashboard.html directly.

import { createHash } from 'node:crypto'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCurrentSnapshotEnvelope } from './snapshot-envelope.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dashboardRoot = resolve(here, '..')
const repositoryRoot = resolve(dashboardRoot, '..')
const dist = resolve(dashboardRoot, 'dist')
const indexPath = resolve(dist, 'index.html')
const manifestPath = resolve(dist, 'fonts', 'font-manifest.json')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

const html = await readFile(indexPath, 'utf8')
assert(html.includes('data-ai-carry-inline'), 'Offline index is missing the inlined application marker.')
assert(await exists(resolve(dist, 'snapshot.js')), 'Offline dashboard is missing its local snapshot.js.')

const snapshotSource = await readFile(resolve(dist, 'snapshot.js'), 'utf8')
const snapshot = parseCurrentSnapshotEnvelope(snapshotSource, 'offline formal snapshot')
assert(snapshot?.meta?.schema_version === '1.1', 'Formal dashboard snapshot is not Schema 1.1.')
assert(snapshot?.meta?.state === 'template' && snapshot?.overview?.state === 'template', 'Formal dashboard snapshot is not a template.')
assert(snapshot?.meta?.identity_ref === 'template', 'Formal template snapshot has the wrong dashboard identity ref.')
assert(snapshot?.profile?.guidance_mode === 'unselected', 'Formal template snapshot must leave guidance mode unselected.')
assert(snapshot?.profile?.learning_policy === 'unselected', 'Formal template snapshot must leave learning policy unselected.')
for (const key of ['memories', 'sops', 'capabilities', 'experiences', 'evolution', 'todo', 'governance']) {
  assert(Array.isArray(snapshot[key]) && snapshot[key].length === 0, `Formal template snapshot contains ${key} data.`)
}

const htmlShell = html
  .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
  .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2')
const resourceTags = htmlShell.match(/<(?:script|link|img|source|video|audio)\b[^>]*>/gi) ?? []
for (const tag of resourceTags) {
  for (const match of tag.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
    const reference = match[1]
    assert(!/^https?:\/\//i.test(reference) && !reference.startsWith('//'), `External runtime resource found: ${reference}`)
  }
}

for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
  for (const match of style[1].matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const reference = match[1]
    assert(!/^https?:\/\//i.test(reference) && !reference.startsWith('//'), `External CSS resource found: ${reference}`)
  }
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
await checkPackagedFonts(resolve(dist, 'fonts'), manifest, html)

const legacyFonts = ['InterVariable.woff2', 'JetBrainsMono-Regular.woff2', 'JetBrainsMono-Medium.woff2', 'JetBrainsMono-Bold.woff2']
const distributedFonts = await readdir(resolve(dist, 'fonts'))
for (const filename of legacyFonts) {
  assert(!distributedFonts.includes(filename), `Unused legacy font is still distributed: ${filename}`)
}

const productionInventory = resolve(dist, 'licenses', 'dashboard-production-dependencies.json')
const productionNotices = resolve(dist, 'licenses', 'dashboard-production-dependencies.txt')
const sourceComponentInventory = resolve(dist, 'licenses', 'source-code', 'source-components.json')
assert(await exists(productionInventory), 'Production dependency inventory is missing from the offline bundle.')
assert(await exists(productionNotices), 'Production dependency license texts are missing from the offline bundle.')
assert(await exists(sourceComponentInventory), 'Adapted source-component inventory is missing from the offline bundle.')

const inventory = JSON.parse(await readFile(productionInventory, 'utf8'))
assert(Array.isArray(inventory.packages) && inventory.packages.length > 0, 'Production dependency inventory is empty.')
const directPackages = new Set(inventory.packages.filter((entry) => entry.direct).map((entry) => entry.name))
const packageManifest = JSON.parse(await readFile(resolve(dashboardRoot, 'package.json'), 'utf8'))
for (const required of Object.keys(packageManifest.dependencies ?? {})) {
  assert(directPackages.has(required), `Direct runtime dependency is absent from notices: ${required}`)
}

const sourceComponents = JSON.parse(await readFile(sourceComponentInventory, 'utf8'))
assert(Array.isArray(sourceComponents.components) && sourceComponents.components.length > 0, 'Adapted source-component inventory is empty.')
for (const component of sourceComponents.components) {
  const componentLicensePath = resolve(dist, ...component.licenseFile.split('/'))
  const componentLicense = (await readFile(componentLicensePath, 'utf8')).replace(/\r\n/g, '\n').trim()
  assert(sha256(Buffer.from(componentLicense)) === component.licenseSha256, `Adapted source license checksum mismatch: ${component.name}`)
  assert(componentLicense.includes(component.copyright), `Adapted source copyright is missing: ${component.name}`)
}

const rootEntry = await readFile(resolve(repositoryRoot, 'dashboard.html'), 'utf8')
assert(rootEntry.includes('dashboard/dist/index.html'), 'Repository dashboard entry no longer targets the offline build.')
assert(rootEntry.includes('dashboard/dist/snapshot.js'), 'Repository dashboard entry does not read the local snapshot identity.')
for (const key of ['ac_kind', 'ac_ref', 'ac_version']) {
  assert(rootEntry.includes(key), `Repository dashboard entry is missing ${key}.`)
  assert(html.includes(key), `Compiled offline dashboard is missing ${key}.`)
}
assert(html.includes('这个入口和实际加载的助手不一致'), 'Compiled offline dashboard lacks the entry mismatch warning.')
assert(html.includes('已暂停复制执行指令'), 'Compiled offline dashboard lacks the mismatch copy gate.')

console.log(
  `Offline asset check passed: Snapshot 1.1 empty template with identity capsule, ${manifest.fonts.length} font faces, ` +
    `${inventory.packages.length} production packages, ${sourceComponents.components.length} adapted source component set, no remote resources.`,
)
