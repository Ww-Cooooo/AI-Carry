// Build-time portability adapter.
// It inlines Vite's generated module and stylesheet so dashboard/dist/index.html
// works under file:// on Windows, macOS and Linux without a local server.
// snapshot.js remains external because AI Carry replaces that small derivative.

import { readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, '..', 'dist')
const indexPath = resolve(dist, 'index.html')
let html = await readFile(indexPath, 'utf8')

const styleMatch = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/)
const scriptMatch = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)

if (!styleMatch || !scriptMatch) {
  throw new Error('Offline build could not find the generated stylesheet and module entry.')
}

const assetPath = (relative) => resolve(dist, relative.replace(/^\.\//, ''))
const stylePath = assetPath(styleMatch[1])
const scriptPath = assetPath(scriptMatch[1])
const css = (await readFile(stylePath, 'utf8'))
  // The generated stylesheet originally lives in dist/assets. Once inlined
  // into dist/index.html, bundled fonts are one level nearer.
  .replaceAll('url(../fonts/', 'url(./fonts/')
const js = await readFile(scriptPath, 'utf8')
// Imported pictures are relative to the emitted module, not the HTML page.
// Preserve that base when moving the module inline (file:// and Electron alike).
const moduleBase = `new URL(${JSON.stringify(scriptMatch[1])},document.baseURI).href`
const safeInlineJs = js.replaceAll('import.meta.url', moduleBase).replaceAll('</script', '<\\/script')

html = html
  // Function replacements are required: generated CSS/JS can contain `$&`,
  // which String.replace would otherwise expand back into the matched tag.
  .replace(styleMatch[0], () => `<style data-ai-carry-inline>\n${css}\n</style>`)
  .replace(scriptMatch[0], () => `<script type="module" data-ai-carry-inline>\n${safeInlineJs}\n</script>`)

// Vite preserves the checkout's shell line endings while generated assets use
// LF. Normalize the final single-file artifact so Windows builds do not create
// mixed-line-ending diffs or make carriage returns look like trailing spaces.
html = html.replace(/\r\n?/g, '\n')

await writeFile(indexPath, html, 'utf8')

// The two generated files are now fully embedded. Removing only those exact
// inputs avoids shipping duplicate payloads while preserving any future
// non-inlined assets that the bundle may still reference.
await Promise.all([unlink(stylePath), unlink(scriptPath)])
