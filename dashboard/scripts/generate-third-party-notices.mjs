// Generates the license bundle that travels with the offline dashboard.
// It uses npm's installed production dependency tree rather than a hand-kept
// package list, so transitive runtime dependencies cannot silently disappear
// from the notices when the lock file changes.

import { createHash } from 'node:crypto'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dashboardRoot = resolve(here, '..')
const packagePath = resolve(dashboardRoot, 'package.json')
const lockPath = resolve(dashboardRoot, 'package-lock.json')
const outputDirectory = resolve(dashboardRoot, 'public', 'licenses')
const inventoryPath = resolve(outputDirectory, 'dashboard-production-dependencies.json')
const noticesPath = resolve(outputDirectory, 'dashboard-production-dependencies.txt')
const checkOnly = process.argv.includes('--check')
const licenseOverrides = new Map([
  ['gsap@3.15.0', [{filename: 'GSAP Standard License (official website)', path: resolve(dashboardRoot, 'license-overrides', 'GSAP-standard-license.txt')}]],
  ['@gsap/react@2.1.2', [{filename: 'GSAP Standard License (official website)', path: resolve(dashboardRoot, 'license-overrides', 'GSAP-standard-license.txt')}]],
  [
    'react-remove-scroll-bar@2.3.8',
    [
      {
        filename: 'LICENSE (upstream repository)',
        path: resolve(dashboardRoot, 'license-overrides', 'react-remove-scroll-bar-2.3.8-LICENSE.txt'),
      },
    ],
  ],
])

const rootPackage = JSON.parse(await readFile(packagePath, 'utf8'))
const packageLock = JSON.parse(await readFile(lockPath, 'utf8'))
const directDependencies = new Set(Object.keys(rootPackage.dependencies ?? {}))

function packageNameFromLockPath(packageKey) {
  const marker = 'node_modules/'
  const remainder = packageKey.slice(packageKey.lastIndexOf(marker) + marker.length)
  const parts = remainder.split('/')
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

const discovered = Object.entries(packageLock.packages ?? {})
  .filter(([packageKey, metadata]) => packageKey.includes('node_modules/') && metadata.dev !== true)
  .map(([packageKey, dependency]) => ({
    name: packageNameFromLockPath(packageKey),
    dependency,
    directory: resolve(dashboardRoot, ...packageKey.split('/')),
  }))

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function repositoryUrl(repository) {
  const value = typeof repository === 'string' ? repository : repository?.url
  if (!value) return null
  return value
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
}

function licenseIdentifier(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    return value.map((entry) => entry?.type).filter(Boolean).join(' OR ')
  }
  if (value?.type) return String(value.type)
  return null
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function loadDependency(name, dependency, directory) {
  const metadataPath = resolve(directory, 'package.json')
  if (!(await exists(metadataPath))) {
    throw new Error(`Cannot locate installed metadata for ${name}. This maintainer-only license check needs the lockfile dependencies in an isolated development or release copy (npm ci --ignore-scripts); an installed AI Carry instance does not need to run it.`)
  }

  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  const version = dependency.version || metadata.version
  const license = licenseIdentifier(dependency.license) || licenseIdentifier(metadata.license) || licenseIdentifier(metadata.licenses)
  if (!version || !license) {
    throw new Error(`Incomplete version or license metadata for ${name}.`)
  }

  const filenames = await readdir(directory)
  const bundledLicenseFiles = filenames
    .filter((filename) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(filename))
    .sort((left, right) => left.localeCompare(right, 'en'))

  const licenseSources = bundledLicenseFiles.length > 0
    ? bundledLicenseFiles.map((filename) => ({ filename, path: resolve(directory, filename) }))
    : licenseOverrides.get(`${name}@${version}`) ?? []
  if (licenseSources.length === 0) throw new Error(`No license or notice file found for ${name}@${version}.`)

  const texts = []
  for (const source of licenseSources) {
    const text = (await readFile(source.path, 'utf8')).replace(/\r\n/g, '\n').trim()
    if (text) texts.push({ filename: source.filename, text, sha256: sha256(text) })
  }
  if (texts.length === 0) throw new Error(`License files for ${name}@${version} are empty.`)

  return {
    name,
    version,
    license,
    direct: directDependencies.has(name),
    repository: repositoryUrl(metadata.repository) ?? metadata.homepage ?? null,
    licenseFiles: texts,
  }
}

const dependenciesByKey = new Map()
for (const item of discovered) {
  const record = await loadDependency(item.name, item.dependency, item.directory)
  dependenciesByKey.set(`${record.name}@${record.version}`, record)
}

const dependencies = [...dependenciesByKey.values()].sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en'),
)

const inventory = {
  schemaVersion: 1,
  source: 'Installed package-lock.json entries whose dev flag is not true',
  lockFile: 'dashboard/package-lock.json',
  scope: 'Conservative production dependency closure used to build the offline dashboard; explicitly dev-only entries are excluded.',
  packages: dependencies.map((dependency) => ({
    name: dependency.name,
    version: dependency.version,
    license: dependency.license,
    direct: dependency.direct,
    repository: dependency.repository,
    licenseFiles: dependency.licenseFiles.map(({ filename, sha256: hash }) => ({ filename, sha256: hash })),
  })),
}

const divider = '='.repeat(78)
const notices = [
  'AI Carry Dashboard - Production Dependency Notices',
  '',
  'This file travels with the offline dashboard. It is generated from installed',
  'non-dev entries in package-lock.json. Exact dependency resolution is recorded in',
  'dashboard/package-lock.json. Build-only development tools are not part of the',
  'browser runtime bundle and are documented separately in THIRD_PARTY_NOTICES.md.',
  '',
  ...dependencies.flatMap((dependency) => [
    divider,
    `${dependency.name}@${dependency.version}`,
    `License: ${dependency.license}`,
    `Relationship: ${dependency.direct ? 'direct runtime dependency' : 'transitive runtime dependency'}`,
    ...(dependency.repository ? [`Source: ${dependency.repository}`] : []),
    '',
    ...dependency.licenseFiles.flatMap(({ filename, text }) => [
      `--- ${filename} ---`,
      text,
      '',
    ]),
  ]),
  divider,
  '',
].join('\n')

const inventoryText = `${JSON.stringify(inventory, null, 2)}\n`

if (checkOnly) {
  const [currentInventory, currentNotices] = await Promise.all([
    readFile(inventoryPath, 'utf8').catch(() => ''),
    readFile(noticesPath, 'utf8').catch(() => ''),
  ])
  if (
    currentInventory.replace(/\r\n/g, '\n') !== inventoryText
    || currentNotices.replace(/\r\n/g, '\n') !== notices
  ) {
    throw new Error('Dashboard dependency notices are stale. Run npm run licenses:generate and review the result.')
  }
  console.log(`Dependency license bundle is current (${dependencies.length} production packages).`)
} else {
  await Promise.all([
    writeFile(inventoryPath, inventoryText, 'utf8'),
    writeFile(noticesPath, notices, 'utf8'),
  ])
  console.log(`Wrote notices for ${dependencies.length} production packages.`)
}
