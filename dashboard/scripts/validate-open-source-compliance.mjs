import {checkPackagedFonts} from './packaged-fonts.mjs';
// Repository-level open-source compliance gate.
// It keeps copied source templates, packaged fonts, npm dependency licenses
// and tracked binary assets from silently escaping the documented inventory.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dashboardRoot = resolve(here, '..')
const repositoryRoot = resolve(dashboardRoot, '..')
const publicRoot = resolve(dashboardRoot, 'public')
const distributionManifestRelative = 'dashboard/public/licenses/public-distribution-files.json'
const distributionManifestPath = resolve(repositoryRoot, ...distributionManifestRelative.split('/'))
const maxDistributionManifestBytes = 256 * 1024
const supportedArguments = new Set([
  '--allow-local-dependencies',
  '--self-test',
  '--strict-source-archive',
  '--write-distribution-manifest',
])
const argumentsGiven = process.argv.slice(2)
for (const argument of argumentsGiven) assert(supportedArguments.has(argument), `Unknown compliance option: ${argument}`)
const allowLocalDependencies = argumentsGiven.includes('--allow-local-dependencies')
const strictSourceArchive = argumentsGiven.includes('--strict-source-archive')
const writeDistributionManifestRequested = argumentsGiven.includes('--write-distribution-manifest')
assert(!(allowLocalDependencies && strictSourceArchive), 'Strict source-archive mode cannot allow local dependencies.')
assert(
  !(writeDistributionManifestRequested && (allowLocalDependencies || strictSourceArchive)),
  'Writing the distribution manifest cannot be combined with archive validation modes.',
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedText(value) {
  return value.replace(/\r\n/g, '\n').trim()
}

const archiveLocalPlaceholders = new Set([
  '.assistant-local/.gitkeep',
  '.assistant-local/dashboard/.gitkeep',
  '.assistant-local/indexes/.gitkeep',
  '.assistant-local/skills/.gitkeep',
  '.assistant-local/task-handoffs/.gitkeep',
  '.assistant-local/upgrade-inbox/.gitkeep',
  '.assistant-private/.gitkeep',
  '.assistant-private/assets/.gitkeep',
  '.assistant-private/inbox/.gitkeep',
])
const archivePrivateDirectoryPrefixes = [
  '.git/',
  '.agents/',
  '.claude/',
  '.planning/',
  'maintainer-private/',
  'workspace/',
  'dashboard/test-fixtures/',
]
const archivePrivateExactPaths = new Set([
  'AGENTS.override.md',
  'skills-lock.json',
  ...archivePrivateDirectoryPrefixes.map((prefix) => prefix.slice(0, -1)),
])
const archiveLocalPlaceholderDirectories = new Set()
for (const placeholder of archiveLocalPlaceholders) {
  const segments = placeholder.split('/')
  for (let length = 1; length < segments.length; length += 1) {
    archiveLocalPlaceholderDirectories.add(segments.slice(0, length).join('/'))
  }
}

function normalizedRelativePath(root, path) {
  return relative(root, path).split(sep).join('/')
}

function isSamePath(left, right) {
  const resolvedLeft = resolve(left)
  const resolvedRight = resolve(right)
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight
}

function archivePathIsPublic(relativePath) {
  if (archivePrivateExactPaths.has(relativePath)) return false
  if (archivePrivateDirectoryPrefixes.some((prefix) => relativePath.startsWith(prefix))) return false
  if (relativePath === '.assistant-local' || relativePath === '.assistant-private') return false
  if (relativePath.startsWith('.assistant-local/') || relativePath.startsWith('.assistant-private/')) {
    return archiveLocalPlaceholders.has(relativePath)
  }
  return true
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function validateDistributionPath(relativePath) {
  assert(typeof relativePath === 'string' && relativePath.length > 0, 'Distribution manifest contains an empty or non-string path.')
  assert(relativePath === relativePath.normalize('NFC'), `Distribution path is not NFC-normalized: ${relativePath}`)
  assert(!relativePath.includes('\\') && !relativePath.startsWith('/') && !/^[A-Za-z]:/.test(relativePath), `Distribution path is not POSIX-relative: ${relativePath}`)
  assert(!/[\u0000-\u001f\u007f]/u.test(relativePath), `Distribution path contains a control character: ${relativePath}`)
  const segments = relativePath.split('/')
  assert(segments.every((segment) => segment && segment !== '.' && segment !== '..'), `Distribution path contains an unsafe segment: ${relativePath}`)
  assert(archivePathIsPublic(relativePath), `Distribution manifest contains a private or local-only path: ${relativePath}`)
}

function archiveDirectoryIsPrivate(relativePath) {
  const prefix = `${relativePath}/`
  return archivePrivateExactPaths.has(relativePath) || archivePrivateDirectoryPrefixes.some((privatePrefix) => prefix.startsWith(privatePrefix))
}

function classifySourceArchiveEntry(entry, relativePath) {
  if (entry.isSymbolicLink()) throw new Error(`Source archive contains a symbolic link: ${relativePath}`)
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  throw new Error(`Source archive contains a non-regular filesystem entry: ${relativePath}`)
}

async function listSourceArchiveFiles(root, { allowDependencies = false } = {}) {
  const files = []
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name)
      const relativePath = normalizedRelativePath(root, absolute)
      const kind = classifySourceArchiveEntry(entry, relativePath)
      if (kind === 'directory') {
        if (allowDependencies && relativePath === 'dashboard/node_modules') continue
        if (relativePath.split('/').includes('node_modules')) {
          throw new Error(`Source archive contains a dependency directory outside the explicit local-install allowance: ${relativePath}`)
        }
        if (archiveDirectoryIsPrivate(relativePath)) {
          throw new Error(`Source archive contains a private or local-only directory: ${relativePath}`)
        }
        if (
          (relativePath === '.assistant-local' || relativePath.startsWith('.assistant-local/') ||
            relativePath === '.assistant-private' || relativePath.startsWith('.assistant-private/')) &&
          !archiveLocalPlaceholderDirectories.has(relativePath)
        ) {
          throw new Error(`Source archive contains an unapproved assistant-local directory: ${relativePath}`)
        }
        await walk(absolute)
      } else if (kind === 'file') {
        if (!archivePathIsPublic(relativePath)) {
          throw new Error(`Source archive contains a private or local-only file: ${relativePath}`)
        }
        if (archiveLocalPlaceholders.has(relativePath)) {
          const metadata = await lstat(absolute)
          assert(metadata.size === 0, `Source archive assistant-local placeholder is not empty: ${relativePath}`)
        }
        files.push(relativePath)
      }
    }
  }
  await walk(root)
  return files.sort(compareOrdinal)
}

async function assertGitWorktreeDependencyBoundary(root, { allowDashboardDependencies = false } = {}) {
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name)
      const relativePath = normalizedRelativePath(root, absolute)
      if (relativePath.split('/').includes('node_modules')) {
        const approvedDashboardDependencyRoot =
          allowDashboardDependencies &&
          relativePath === 'dashboard/node_modules' &&
          entry.isDirectory() &&
          !entry.isSymbolicLink()
        if (approvedDashboardDependencyRoot) continue
        throw new Error(`Git worktree contains a dependency entry outside the explicit local-install allowance: ${relativePath}`)
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      if (archiveDirectoryIsPrivate(relativePath)) continue
      if (
        relativePath === '.assistant-local' || relativePath.startsWith('.assistant-local/') ||
        relativePath === '.assistant-private' || relativePath.startsWith('.assistant-private/')
      ) continue
      await walk(absolute)
    }
  }
  await walk(root)
}

async function runSourceArchiveInventorySelfTests() {
  const temporaryBase = await realpath(tmpdir())
  let passed = 0

  async function withFixture(label, callback) {
    const fixture = await mkdtemp(join(temporaryBase, 'ai-carry-archive-compliance-'))
    const fixtureRealPath = await realpath(fixture)
    try {
      const relativeToTemporaryBase = relative(temporaryBase, fixtureRealPath)
      const insideTemporaryBase = relativeToTemporaryBase.length > 0 &&
        relativeToTemporaryBase !== '..' &&
        !relativeToTemporaryBase.startsWith(`..${sep}`) &&
        !isAbsolute(relativeToTemporaryBase)
      assert(insideTemporaryBase, `Self-test fixture escaped the temporary directory: ${fixtureRealPath}`)
      await writeFile(resolve(fixture, 'README.md'), 'fixture\n', 'utf8')
      await callback(fixture)
      passed += 1
    } finally {
      await rm(fixture, { recursive: true, force: true, maxRetries: 3 })
    }
    return label
  }

  async function expectRejected(label, setup, expectedFragment, options = {}) {
    await withFixture(label, async (fixture) => {
      await setup(fixture)
      let failure = null
      try {
        const paths = await listSourceArchiveFiles(fixture, options)
        assertSamePathSet(paths, ['README.md'], label)
      } catch (error) {
        failure = error
      }
      assert(failure instanceof Error, `${label} unexpectedly passed.`)
      assert(failure.message.includes(expectedFragment), `${label} failed for the wrong reason: ${failure.message}`)
    })
  }

  async function expectGitDependencyRejected(label, setup, expectedFragment) {
    await withFixture(label, async (fixture) => {
      await setup(fixture)
      let failure = null
      try {
        await assertGitWorktreeDependencyBoundary(fixture, { allowDashboardDependencies: true })
      } catch (error) {
        failure = error
      }
      assert(failure instanceof Error, `${label} unexpectedly passed.`)
      assert(failure.message.includes(expectedFragment), `${label} failed for the wrong reason: ${failure.message}`)
    })
  }

  await expectRejected(
    'maintainer-private directory rejection',
    async (fixture) => {
      await mkdir(resolve(fixture, 'maintainer-private'), { recursive: true })
      await writeFile(resolve(fixture, 'maintainer-private', 'private.md'), 'private\n', 'utf8')
    },
    'private or local-only directory',
  )
  await expectRejected(
    'maintainer-private root file rejection',
    async (fixture) => {
      await writeFile(resolve(fixture, 'maintainer-private'), 'not a directory\n', 'utf8')
    },
    'private or local-only file',
  )
  await expectRejected(
    'assistant-private content rejection',
    async (fixture) => {
      await mkdir(resolve(fixture, '.assistant-private', 'assets'), { recursive: true })
      await writeFile(resolve(fixture, '.assistant-private', 'assets', 'private.txt'), 'private\n', 'utf8')
    },
    'private or local-only file',
  )
  await expectRejected(
    'non-empty assistant placeholder rejection',
    async (fixture) => {
      await mkdir(resolve(fixture, '.assistant-local'), { recursive: true })
      await writeFile(resolve(fixture, '.assistant-local', '.gitkeep'), 'not a placeholder\n', 'utf8')
    },
    'placeholder is not empty',
  )
  await expectRejected(
    'assistant root file rejection',
    async (fixture) => {
      await writeFile(resolve(fixture, '.assistant-private'), 'not a directory\n', 'utf8')
    },
    'private or local-only file',
  )
  await expectRejected(
    'root node_modules rejection',
    async (fixture) => {
      await mkdir(resolve(fixture, 'node_modules', 'package'), { recursive: true })
      await writeFile(resolve(fixture, 'node_modules', 'package', 'index.js'), 'export {}\n', 'utf8')
    },
    'dependency directory',
  )
  await expectRejected(
    'nested node_modules rejection',
    async (fixture) => {
      await mkdir(resolve(fixture, 'core', 'node_modules', 'package'), { recursive: true })
      await writeFile(resolve(fixture, 'core', 'node_modules', 'package', 'index.js'), 'export {}\n', 'utf8')
    },
    'dependency directory',
  )
  await expectRejected(
    'local mode root node_modules rejection',
    async (fixture) => {
      await mkdir(resolve(fixture, 'node_modules', 'package'), { recursive: true })
      await writeFile(resolve(fixture, 'node_modules', 'package', 'index.js'), 'export {}\n', 'utf8')
    },
    'dependency directory',
    { allowDependencies: true },
  )
  await expectRejected(
    'local mode nested node_modules rejection',
    async (fixture) => {
      await mkdir(resolve(fixture, 'core', 'node_modules', 'package'), { recursive: true })
      await writeFile(resolve(fixture, 'core', 'node_modules', 'package', 'index.js'), 'export {}\n', 'utf8')
    },
    'dependency directory',
    { allowDependencies: true },
  )
  await expectGitDependencyRejected(
    'Git local mode root node_modules rejection',
    async (fixture) => {
      await mkdir(resolve(fixture, 'node_modules', 'package'), { recursive: true })
    },
    'outside the explicit local-install allowance',
  )
  await expectGitDependencyRejected(
    'Git local mode nested node_modules rejection',
    async (fixture) => {
      await mkdir(resolve(fixture, 'core', 'node_modules', 'package'), { recursive: true })
    },
    'outside the explicit local-install allowance',
  )
  await expectRejected(
    'unlisted ordinary file rejection',
    async (fixture) => {
      await writeFile(resolve(fixture, 'unlisted.txt'), 'extra\n', 'utf8')
    },
    'differs from the public distribution manifest',
  )
  await expectRejected(
    'symbolic link rejection',
    async (fixture) => {
      await mkdir(resolve(fixture, 'real-directory'), { recursive: true })
      await symlink(resolve(fixture, 'real-directory'), resolve(fixture, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir')
    },
    'symbolic link',
  )
  await withFixture('approved dashboard dependency allowance', async (fixture) => {
    await mkdir(resolve(fixture, 'dashboard', 'node_modules', 'package'), { recursive: true })
    await writeFile(resolve(fixture, 'dashboard', 'node_modules', 'package', 'index.js'), 'export {}\n', 'utf8')
    const paths = await listSourceArchiveFiles(fixture, { allowDependencies: true })
    assertSamePathSet(paths, ['README.md'], 'Local-install dependency allowance')
  })
  await withFixture('Git approved dashboard dependency allowance', async (fixture) => {
    await mkdir(resolve(fixture, 'dashboard', 'node_modules', 'package'), { recursive: true })
    await assertGitWorktreeDependencyBoundary(fixture, { allowDashboardDependencies: true })
  })
  await withFixture('Git dependency guard prunes private roots', async (fixture) => {
    await mkdir(resolve(fixture, 'maintainer-private', 'node_modules', 'package'), { recursive: true })
    await mkdir(resolve(fixture, '.assistant-private', 'node_modules', 'package'), { recursive: true })
    await assertGitWorktreeDependencyBoundary(fixture, { allowDashboardDependencies: true })
  })
  await withFixture('assistant placeholder allowance', async (fixture) => {
    for (const placeholder of archiveLocalPlaceholders) {
      const absolute = resolve(fixture, ...placeholder.split('/'))
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, '', 'utf8')
    }
    const paths = await listSourceArchiveFiles(fixture)
    assertSamePathSet(paths, ['README.md', ...archiveLocalPlaceholders], 'Assistant placeholder allowance')
  })
  let nonRegularFailure = null
  try {
    classifySourceArchiveEntry(
      { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false },
      'synthetic-non-regular-entry',
    )
  } catch (error) {
    nonRegularFailure = error
  }
  assert(nonRegularFailure instanceof Error && nonRegularFailure.message.includes('non-regular filesystem entry'), 'Non-regular entry classification unexpectedly passed.')
  passed += 1
  console.log(`Source-archive inventory negative and allowance self-tests passed: ${passed}.`)
}

function assertSamePathSet(actual, expected, label) {
  const normalizedActual = [...new Set(actual)].sort(compareOrdinal)
  const normalizedExpected = [...new Set(expected)].sort(compareOrdinal)
  const same = normalizedActual.length === normalizedExpected.length && normalizedActual.every((path, index) => path === normalizedExpected[index])
  if (!same) {
    const actualSet = new Set(normalizedActual)
    const expectedSet = new Set(normalizedExpected)
    const missing = normalizedExpected.filter((path) => !actualSet.has(path)).slice(0, 20)
    const extra = normalizedActual.filter((path) => !expectedSet.has(path)).slice(0, 20)
    throw new Error(`${label} differs from the public distribution manifest; missing=${missing.join(', ') || 'none'}; extra=${extra.join(', ') || 'none'}`)
  }
}

async function assertManifestFileIsSafe(root, relativePath, rootRealPath) {
  let current = root
  for (const segment of relativePath.split('/')) {
    current = resolve(current, segment)
    const metadata = await lstat(current)
    assert(!metadata.isSymbolicLink(), `Distribution path traverses a symbolic link: ${relativePath}`)
  }
  const metadata = await lstat(current)
  assert(metadata.isFile(), `Distribution manifest path is not a regular file: ${relativePath}`)
  const actualRealPath = await realpath(current)
  const insidePrefix = `${rootRealPath}${sep}`
  const inside = isSamePath(actualRealPath, rootRealPath) || (process.platform === 'win32'
    ? actualRealPath.toLowerCase().startsWith(insidePrefix.toLowerCase())
    : actualRealPath.startsWith(insidePrefix))
  assert(inside, `Distribution path resolves outside the AI Carry root: ${relativePath}`)
}

async function readDistributionManifest(root) {
  const metadata = await stat(distributionManifestPath)
  assert(metadata.isFile() && metadata.size <= maxDistributionManifestBytes, 'Public distribution manifest is missing, not a file or too large.')
  const parsed = JSON.parse(await readFile(distributionManifestPath, 'utf8'))
  assert(parsed?.schemaVersion === 1 && parsed?.recordType === 'ai-carry-public-distribution-files', 'Unsupported public distribution manifest schema.')
  assert(Array.isArray(parsed.paths) && parsed.fileCount === parsed.paths.length, 'Public distribution manifest count is invalid.')
  const keys = Object.keys(parsed).sort(compareOrdinal)
  assert(JSON.stringify(keys) === JSON.stringify(['fileCount', 'paths', 'recordType', 'schemaVersion']), 'Public distribution manifest contains unknown fields.')
  parsed.paths.forEach(validateDistributionPath)
  assert(new Set(parsed.paths).size === parsed.paths.length, 'Public distribution manifest contains duplicate paths.')
  assert(parsed.paths.every((path, index) => index === 0 || compareOrdinal(parsed.paths[index - 1], path) < 0), 'Public distribution manifest paths are not strictly sorted.')
  assert(parsed.paths.includes(distributionManifestRelative), 'Public distribution manifest does not include itself.')
  const rootRealPath = await realpath(root)
  for (const relativePath of parsed.paths) await assertManifestFileIsSafe(root, relativePath, rootRealPath)
  return parsed
}

async function assertArchiveLocalPlaceholdersAreEmpty(root, distributionPaths) {
  const distributionSet = new Set(distributionPaths)
  for (const relativePath of archiveLocalPlaceholders) {
    assert(distributionSet.has(relativePath), `Public distribution manifest omits an assistant-local placeholder: ${relativePath}`)
    const metadata = await lstat(resolve(root, ...relativePath.split('/')))
    assert(metadata.isFile() && metadata.size === 0, `Assistant-local placeholder must be a zero-byte regular file: ${relativePath}`)
  }
}

function loadGitPublicFiles(root) {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString('utf8').trim()
  assert(isSamePath(gitRoot, root), 'Git metadata exists, but the AI Carry root is not the worktree root.')
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString('utf8').split('\0').filter(Boolean).filter(archivePathIsPublic).sort(compareOrdinal)
}

async function writeDistributionManifest(root) {
  assert(await exists(resolve(root, '.git')), 'Writing the public distribution manifest requires the AI Carry Git worktree.')
  const paths = loadGitPublicFiles(root).filter((path) => path !== distributionManifestRelative)
  paths.push(distributionManifestRelative)
  paths.sort(compareOrdinal)
  const manifest = { schemaVersion: 1, recordType: 'ai-carry-public-distribution-files', fileCount: paths.length, paths }
  await writeFile(distributionManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function loadRepositoryInventory(root, distributionPaths, { allowDependencies = false, requireSourceArchive = false } = {}) {
  const hasGitMetadata = await exists(resolve(root, '.git'))
  if (requireSourceArchive) {
    assert(!hasGitMetadata, 'Strict source-archive mode requires a Git-metadata-free AI Carry root.')
  }
  if (hasGitMetadata) {
    await assertGitWorktreeDependencyBoundary(root, { allowDashboardDependencies: allowDependencies })
    const paths = loadGitPublicFiles(root)
    assertSamePathSet(paths, distributionPaths, 'Git public file set')
    return { kind: 'git-public', paths }
  }
  const paths = await listSourceArchiveFiles(root, { allowDependencies })
  assertSamePathSet(paths, distributionPaths, 'Source-archive public file set')
  return { kind: allowDependencies ? 'source-archive-local-install' : 'source-archive-strict', paths: distributionPaths }
}

if (argumentsGiven.includes('--self-test')) await runSourceArchiveInventorySelfTests()
if (writeDistributionManifestRequested) {
  await assertGitWorktreeDependencyBoundary(repositoryRoot, { allowDashboardDependencies: true })
  await writeDistributionManifest(repositoryRoot)
}
const distributionManifest = await readDistributionManifest(repositoryRoot)
await assertArchiveLocalPlaceholdersAreEmpty(repositoryRoot, distributionManifest.paths)

function packageNameFromLockPath(packageKey) {
  const marker = 'node_modules/'
  const remainder = packageKey.slice(packageKey.lastIndexOf(marker) + marker.length)
  const parts = remainder.split('/')
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

const [rootLicense, thirdPartyNotices, licenseReadme, packageJson, packageLock, productionInventory, productionNotices, fontManifest, sourceComponents, projectAssets] =
  await Promise.all([
    readFile(resolve(repositoryRoot, 'LICENSE'), 'utf8'),
    readFile(resolve(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    readFile(resolve(publicRoot, 'licenses', 'README.txt'), 'utf8'),
    readFile(resolve(dashboardRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(dashboardRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(resolve(publicRoot, 'licenses', 'dashboard-production-dependencies.json'), 'utf8').then(JSON.parse),
    readFile(resolve(publicRoot, 'licenses', 'dashboard-production-dependencies.txt'), 'utf8'),
    readFile(resolve(publicRoot, 'fonts', 'font-manifest.json'), 'utf8').then(JSON.parse),
    readFile(resolve(publicRoot, 'licenses', 'source-code', 'source-components.json'), 'utf8').then(JSON.parse),
    readFile(resolve(repositoryRoot, 'docs', 'assets', 'project-assets.json'), 'utf8').then(JSON.parse),
  ])

for (const marker of ['Apache License', 'Version 2.0, January 2004', 'END OF TERMS AND CONDITIONS']) {
  assert(rootLicense.includes(marker), `Root Apache-2.0 license is incomplete: ${marker}`)
}
assert(packageJson.license === 'Apache-2.0', 'Dashboard package metadata must use SPDX Apache-2.0.')

const reviewedLockLicenses = new Set(['MIT', 'Apache-2.0', 'ISC', '0BSD', 'BSD-3-Clause', 'MPL-2.0'])
const reviewedRuntimeLicenses = new Set(['MIT', 'Apache-2.0', 'ISC', '0BSD', 'BSD-3-Clause'])
const lockEntries = Object.entries(packageLock.packages ?? {}).filter(([key]) => key.includes('node_modules/'))
const lockLicenseCounts = {}
for (const [key, metadata] of lockEntries) {
  const license = typeof metadata.license === 'string' ? metadata.license.trim() : ''
  assert(license, `Lock entry has no SPDX license metadata: ${key}`)
  assert(reviewedLockLicenses.has(license) || (/node_modules\/(?:gsap|@gsap\/react)$/.test(key) && /https:\/\/gsap\.com\/standard-license/.test(license)), `Unreviewed dependency license ${license}: ${key}`)
  const scope = metadata.dev === true ? 'build' : 'runtime'
  lockLicenseCounts[`${scope}:${license}`] = (lockLicenseCounts[`${scope}:${license}`] ?? 0) + 1
}

const expectedProductionKeys = new Set(
  lockEntries
    .filter(([, metadata]) => metadata.dev !== true)
    .map(([key, metadata]) => `${packageNameFromLockPath(key)}@${metadata.version}`),
)
const inventoriedProductionKeys = new Set(
  productionInventory.packages.map((entry) => `${entry.name}@${entry.version}`),
)
assert(
  expectedProductionKeys.size === inventoriedProductionKeys.size &&
    [...expectedProductionKeys].every((key) => inventoriedProductionKeys.has(key)),
  'Production dependency inventory does not match the non-dev lock-file closure.',
)
for (const entry of productionInventory.packages) {
  assert(reviewedRuntimeLicenses.has(entry.license) || (['gsap','@gsap/react'].includes(entry.name) && /https:\/\/gsap\.com\/standard-license/.test(entry.license)), `Unreviewed runtime license ${entry.license}: ${entry.name}@${entry.version}`)
  assert(entry.repository, `Production dependency has no upstream source: ${entry.name}@${entry.version}`)
  assert(Array.isArray(entry.licenseFiles) && entry.licenseFiles.length > 0, `Production dependency has no license text: ${entry.name}@${entry.version}`)
  assert(productionNotices.includes(`${entry.name}@${entry.version}`), `Production notice text omits ${entry.name}@${entry.version}`)
}

assert(sourceComponents.schemaVersion === 1, 'Unsupported source-component inventory schema.')
assert(Array.isArray(sourceComponents.components) && sourceComponents.components.length > 0, 'Source-component inventory is empty.')
for (const component of sourceComponents.components) {
  assert(component.name && component.license && component.copyright, 'Source-component identity is incomplete.')
  assert(/^[0-9a-f]{40}$/.test(component.upstreamCommit), `Source component is not pinned to a full commit: ${component.name}`)
  assert(component.upstreamLicense.includes(component.upstreamCommit), `License URL is not pinned to the reviewed commit: ${component.name}`)
  const licensePath = resolve(publicRoot, ...component.licenseFile.split('/'))
  const licenseText = normalizedText(await readFile(licensePath, 'utf8'))
  assert(sha256(licenseText) === component.licenseSha256, `Source-component license checksum mismatch: ${component.name}`)
  assert(licenseText.includes(component.copyright), `Source-component copyright is absent from its license: ${component.name}`)
  for (const mapping of component.adaptedFiles ?? []) {
    assert(await exists(resolve(repositoryRoot, ...mapping.local.split('/'))), `Attributed local source is missing: ${mapping.local}`)
    assert(mapping.upstream, `Attributed source has no upstream mapping: ${mapping.local}`)
  }
  for (const local of component.relatedScaffoldFiles ?? []) {
    assert(await exists(resolve(repositoryRoot, ...local.split('/'))), `Attributed scaffold is missing: ${local}`)
  }
  assert(thirdPartyNotices.includes(component.name), `THIRD_PARTY_NOTICES.md omits ${component.name}`)
}
assert(licenseReadme.includes('source-code/'), 'Offline license README does not explain copied source-component notices.')

const fontFiles = await checkPackagedFonts(resolve(publicRoot, 'fonts'), fontManifest)
const expectedFontAssets = new Set(fontFiles.flatMap(file => [`dashboard/public/fonts/${file}`, `dashboard/dist/fonts/${file}`]))

const repositoryInventory = await loadRepositoryInventory(repositoryRoot, distributionManifest.paths, {
  allowDependencies: allowLocalDependencies || writeDistributionManifestRequested,
  requireSourceArchive: strictSourceArchive,
})
const tracked = repositoryInventory.paths
const trackedSet = new Set(tracked)
// The public product and the maintainer-only workbench have independent
// attribution bundles. Public compliance must not mistake private offline
// build copies for public release assets; the private dashboard build checks
// its own fonts, packages and notices before it succeeds.
const publicTracked = tracked.filter((path) => !path.startsWith('maintainer-private/'))

assert(projectAssets.schemaVersion === 1, 'Unsupported project-asset inventory schema.')
assert(Array.isArray(projectAssets.assets), 'Project-asset inventory is invalid.')
const expectedProjectAssets = new Set()
for (const asset of projectAssets.assets) {
  assert(asset.path && asset.sha256 && asset.origin, 'Project asset provenance is incomplete.')
  assert(asset.license === 'Apache-2.0', `Project-generated asset must use the project license: ${asset.path}`)
  const assetBytes = await readFile(resolve(repositoryRoot, ...asset.path.split('/')))
  assert(sha256(assetBytes) === asset.sha256, `Project-asset checksum mismatch: ${asset.path}`)
  expectedProjectAssets.add(asset.path)
}
for (const required of [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'docs/open-source-compliance.md',
  'dashboard/public/fonts/font-manifest.json',
  'dashboard/public/licenses/source-code/source-components.json',
  'dashboard/public/licenses/source-code/shadcn-ui-MIT.txt',
  'dashboard/dist/licenses/source-code/source-components.json',
  'dashboard/dist/licenses/source-code/shadcn-ui-MIT.txt',
]) {
  assert(trackedSet.has(required), `Required compliance material is absent from the repository inventory: ${required}`)
}
const reviewableAssetPattern = /\.(?:woff2?|ttf|otf|ttc|otc|eot|svg|png|jpe?g|gif|webp|avif|ico|icns|pdf|zip|7z|tar|gz|mp3|wav|ogg|mp4|webm|mov|wasm|glb|gltf|obj|fbx|stl|ply|usdz|hdr|exr)$/i
const trackedReviewableAssets = publicTracked.filter((path) => reviewableAssetPattern.test(path))
const unregisteredAssets = trackedReviewableAssets.filter((path) => !expectedFontAssets.has(path) && !expectedProjectAssets.has(path))
assert(unregisteredAssets.length === 0, `Tracked assets need provenance review: ${unregisteredAssets.join(', ')}`)
assert(!tracked.some((path) => path.includes('/node_modules/')), 'node_modules must never be tracked or distributed.')

console.log(
  `Open-source compliance check passed using ${repositoryInventory.kind} inventory: ${tracked.length} files, ` +
    `${productionInventory.packages.length} runtime packages, ${lockEntries.length - productionInventory.packages.length} build-only lock entries, ` +
    `${fontManifest.fonts.length} font faces, ${sourceComponents.components.length} adapted source component set, ${projectAssets.assets.length} project-generated visual asset; ` +
    `reviewed licenses ${Object.keys(lockLicenseCounts).sort().join(', ')}.`,
)
