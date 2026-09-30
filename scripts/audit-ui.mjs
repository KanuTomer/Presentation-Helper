import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, extname, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_')
const output = resolve(process.argv[2] ?? join(process.env.USERPROFILE, 'Downloads', 'PresenterAI-Audit', `${stamp}_quiet-glass`))
await mkdir(join(output, 'screenshots'), { recursive: true })
const buildDir = resolve('artifacts/audit-ui')
await build({ configFile: false, root: resolve('tests/audit'), plugins: [react(), tailwindcss()], build: { outDir: buildDir, emptyOutDir: true, target: 'es2022' }, logLevel: 'warn' })
const server = createServer(async (req, res) => {
  try {
    const path = resolve(buildDir, '.' + new URL(req.url, 'http://localhost').pathname)
    if (relative(buildDir, path).startsWith('..')) { res.writeHead(403).end(); return }
    const file = extname(path) ? path : join(path, 'index.html')
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[extname(file)] ?? 'application/octet-stream')
    res.end(await readFile(file))
  } catch { res.writeHead(404).end() }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true, channel: process.env.PRESENTERAI_AUDIT_BROWSER ?? 'chrome' })
const page = await browser.newPage({ viewport: { width: 1100, height: 720 }, reducedMotion: 'reduce' })
page.setDefaultTimeout(7000)
const results = [], screenshots = [], errors = [], blockedNetwork = []
page.on('pageerror', (error) => errors.push(error.message))
await page.route('**/*', (route) => { const url = route.request().url(); if (url.startsWith(origin + '/') || url.startsWith('data:')) return route.continue(); blockedNetwork.push(url); return route.abort() })
const check = async (id, action) => { try { await action(); results.push({ id, outcome: 'Pass', source: 'synthetic UI fixture' }) } catch (error) { results.push({ id, outcome: 'Fail', detail: error.message, source: 'synthetic UI fixture' }) } }
const require = (condition, message) => { if (!condition) throw new Error(message) }
const capture = async (name) => { const file = `${name}.png`; await page.screenshot({ path: join(output, 'screenshots', file) }); screenshots.push(file) }
const tab = async (name) => { if (name === 'capture') await page.getByTitle('Capture protection status').click(); else await page.getByRole('button', { name, exact: true }).click() }
const submit = async (scenario) => {
  await page.evaluate((name) => window.__audit.scenario(name), scenario)
  await tab('copilot'); await page.locator('.question-box textarea').fill('Synthetic question for renderer audit only.')
  await page.getByRole('button', { name: /Generate code/ }).click()
  await page.locator('.response-card').waitFor()
}
const backgrounds = {
  light: 'background:#fff', dark: 'background:#030409',
  'light-text': 'background:#fff;color:#111', checkerboard: 'background:repeating-conic-gradient(#eee 0% 25%,#333 0% 50%) 0 0/32px 32px',
  'dark-text': 'background:#030409;color:#fff'
}
try {
  await page.goto(origin)
  await page.locator('.appearance-settings').count() // startup is asynchronous
  await page.getByRole('button', { name: 'Generate code', exact: false }).waitFor()
  await page.addStyleTag({ content: '#audit-background{position:fixed;inset:0;z-index:0;overflow:hidden;font:16px/1.25 monospace;}#root{position:relative;z-index:1;}.audit-watermark{position:fixed;bottom:2px;right:12px;z-index:1000;background:#080d1b;color:#fff;padding:3px 7px;font:10px system-ui;pointer-events:none;}' })
  await page.evaluate(() => { const label = document.createElement('div'); label.className = 'audit-watermark'; label.textContent = 'SYNTHETIC UI STATE · no API or native desktop capture'; document.body.append(label) })
  for (const [width, height] of [[1100, 720], [680, 420]]) {
    await page.setViewportSize({ width, height })
    for (const [background, style] of Object.entries(backgrounds)) {
      await page.evaluate(({ style, name }) => { const back = document.getElementById('audit-background'); back.style.cssText = style; back.textContent = name.endsWith('text') ? 'Synthetic desktop content behind the application. '.repeat(450) : '' }, { style, name: background })
      for (const intensity of [0, .65, 1]) {
        await tab('settings'); const slider = page.getByRole('slider', { name: 'Accent intensity' }); await slider.fill(String(intensity))
        await page.waitForFunction((n) => window.__audit.settings().neonIntensity === n && Number(getComputedStyle(document.querySelector('.shell')).getPropertyValue('--neon-intensity')) === n, intensity)
        await submit('presenter')
        const reading = await page.locator('.response-card').evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color, opacity: getComputedStyle(element).opacity }))
        require(reading.background === 'rgba(9, 14, 26, 0.97)' && reading.opacity === '1', 'Reading surface changed with intensity.')
        require(await page.locator('.quick-controls').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'Command bar overflows with multiple monitor controls.')
        await capture(`READ-001_copilot_${background}_${width}x${height}_css100pct_accent${Math.round(intensity * 100)}`)
      }
      await tab('settings'); await page.getByRole('slider', { name: 'Accent intensity' }).fill('0.65')
      await page.waitForFunction(() => window.__audit.settings().neonIntensity === .65)
      for (const view of ['documents', 'settings', 'privacy', 'capture']) {
        await tab(view); await page.locator('.content').evaluate((el) => { el.scrollTop = 0 })
        await capture(`READ-002_${view}_${background}_${width}x${height}_css100pct_accent65`)
      }
    }
  }
  results.push({ id: 'READ-001/READ-002/VIS-001-comparison', outcome: 'Pass', configurations: 30, source: 'synthetic UI fixture' })
  await page.setViewportSize({ width: 1100, height: 720 })
  for (const scenario of ['code', 'math', 'warning', 'clarification']) await check(`response-${scenario}`, async () => {
    await submit(scenario); await page.locator('.response-card').scrollIntoViewIfNeeded(); await capture(`fixture_${scenario}`)
    if (scenario === 'code') {
      const code = page.locator('.code-scroll').first(); await code.evaluate((el) => { el.scrollTop = 100; el.scrollLeft = 100 })
      require(await code.evaluate((el) => el.scrollTop > 0 && el.scrollLeft > 0), 'Nested code did not scroll both axes.')
      const copy = page.getByRole('button', { name: /^Copy / }).first(); await copy.click(); require(await copy.textContent() === 'Copied', 'Copy feedback missing.')
    }
    if (scenario === 'math') require(await page.locator('math').count() >= 2, 'Math/matrix rendering missing.')
  })
  for (const view of ['documents', 'settings', 'privacy', 'capture']) await check(`view-${view}`, async () => {
    await tab(view); await page.locator('.content').evaluate((el) => { el.scrollTop = 0 }); await capture(`fixture_${view}_top`)
    if (view === 'documents') {
      await page.getByRole('button', { name: 'Add files' }).click(); await capture('fixture_import_outcomes')
      await page.getByLabel('Search indexed content').fill('synthetic'); await page.getByRole('button', { name: 'Search locally', exact: true }).click(); await capture('fixture_search_results')
      await page.getByLabel('Search indexed content').fill('missing'); await page.getByRole('button', { name: 'Search locally', exact: true }).click(); await capture('fixture_search_empty')
      await page.locator('.document-main').first().click(); await capture('fixture_inspection_page1')
      await page.getByRole('button', { name: 'Next', exact: true }).click(); await capture('fixture_inspection_page2')
    }
    const scroller = page.locator('.content'); await scroller.focus(); await page.keyboard.press('PageDown')
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight }); await capture(`fixture_${view}_bottom`)
    await page.keyboard.press('Home'); require(await scroller.evaluate((el) => el.scrollTop) === 0, `${view} Home did not return to top.`)
  })
  await check('shortcut-retry-and-confirmation', async () => {
    await tab('settings'); await page.getByRole('button', { name: 'Retry shortcuts' }).click()
    await tab('copilot'); await page.getByRole('button', { name: 'Enable click-through', exact: true }).click(); await page.getByRole('alertdialog').waitFor(); await capture('fixture_clickthrough_confirmation')
    await page.keyboard.press('Escape'); require(await page.getByRole('alertdialog').count() === 0, 'Confirmation did not close with Escape.')
  })
  await check('SNAP-001-keyless-preview', async () => {
    await page.evaluate(() => window.__audit.scenario('keyless')); await tab('settings'); await page.getByRole('slider', { name: 'Accent intensity' }).fill('0.65'); await tab('copilot')
    // Reload refreshes API status without acquiring any credential.
    await page.reload(); await page.evaluate(() => window.__audit.scenario('keyless')); await tab('privacy'); await page.getByRole('button', { name: 'New Session' }).click(); await tab('copilot')
    await page.getByRole('button', { name: 'Snapshot', exact: true }).click(); await page.getByRole('dialog', { name: 'Snapshot preview' }).waitFor(); await capture('fixture_keyless_snapshot')
    require(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), 'Keyless Send was enabled.')
    await page.getByRole('button', { name: 'Retake' }).click(); await page.getByRole('dialog', { name: 'Snapshot preview' }).waitFor(); await page.keyboard.press('Escape')
    require(await page.getByRole('dialog').count() === 0, 'Snapshot Escape did not clear preview.')
  })
  for (const stage of ['starting_capture', 'finalizing', 'transcribing', 'generating', 'cancelling']) await check(`stage-${stage}`, async () => { await page.evaluate((value) => window.__audit.stage(value), stage); await capture(`fixture_stage_${stage}`) })
  await page.evaluate(() => window.__audit.stage('idle'))
  await tab('copilot')
  await page.locator('.question-box textarea').fill('Existing composer content.')
  await page.evaluate(() => window.__audit.draft()); await capture('fixture_transcript_conflict')
  for (const code of ['invalid_key', 'rate_limit', 'output_limit', 'malformed_response', 'helper_unavailable', 'cancelled']) await check(`error-${code}`, async () => { await page.evaluate((value) => window.__audit.error(value), code); await capture(`fixture_error_${code}`) })
  await check('transmission-preview', async () => { await page.evaluate(() => window.__audit.preview()); await capture('fixture_transmission_preview') })
  await check('accessibility-media-fallbacks', async () => {
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
    require(await page.locator('.quiet-glass-layer').evaluate((el) => getComputedStyle(el).display) === 'none', 'Forced-colors accent fallback did not activate.')
    await capture('fixture_forced_colors_simulated')
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
    require(await page.locator('.quiet-glass-layer').evaluate((el) => getComputedStyle(el).display) === 'none', 'Reduced-transparency fallback did not activate.')
    await capture('fixture_reduced_transparency_simulated')
    await cdp.send('Emulation.setEmulatedMedia', { features: [] }); await cdp.detach()
  })
  await check('contrast-tokens', async () => {
    const luminance = (rgb) => rgb.map((n) => { const v = n / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0)
    const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
    const measured = []
    for (const bg of [[255,255,255],[3,4,9],[238,238,238],[17,17,17]]) {
      const shell = bg.map((v, i) => .12 * [11,16,32][i] + .88 * v)
      const panel = shell.map((v, i) => .94 * [11,16,32][i] + .06 * v)
      const normal = ratio([188,198,219], panel), focus = ratio([165,180,252], panel), control = ratio([104,117,143], panel)
      require(normal >= 4.5 && focus >= 3 && control >= 3, 'Composited contrast threshold failed.')
      measured.push({ desktopRgb: bg, panelRgb: panel, secondaryTextRatio: normal, focusRatio: focus, controlBorderRatio: control })
    }
    results.push({ id: 'composited-token-measurements', outcome: 'Pass', measured, note: 'Known CSS tokens over controlled solid background samples; not blanket WCAG certification.' })
  })
  require(errors.length === 0, `Renderer errors: ${errors.join('; ')}`)
  require(blockedNetwork.length === 0, 'Unexpected external network attempt.')
} catch (error) { results.push({ id: 'campaign', outcome: 'Fail', detail: error.message }) }
finally { await browser.close(); await new Promise((done) => server.close(done)) }
const pending = ['Native desktop passthrough/corners over contrasting backgrounds', 'Ten real shortcut/tray hide-show cycles', 'Windows DPI 100/125/150/175/200%', 'Physical shortcut conflicts and single-instance recovery', 'Hardware/audio/live model gates']
await writeFile(join(output, 'observations.json'), JSON.stringify({ results, screenshots, errors, blockedNetwork, pending }, null, 2))
await writeFile(join(output, 'environment.json'), JSON.stringify({ version: '0.2.0-beta.6', commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirtyWorktree: true, evidenceType: 'synthetic renderer-only browser harness', dpi: 'CSS viewport 100%; not Windows scaling', noCredentials: true, noProviderDispatch: true, originalAudit: 'C:/Users/kanut/Downloads/PresenterAI-Audit/2026-09-30_15-26-22' }, null, 2))
await writeFile(join(output, 'report.md'), `# Quiet-glass repair evidence\n\nSynthetic UI fixtures only. No API, credentials, native screenshot, or global shortcuts.\n\nOriginal findings: READ-001/READ-002/VIS-001 → comparison screenshots; NAV-001 → retry fixture; SNAP-001 → keyless preview; CORNER-001 remains pending native verification.\n\n## Checks\n\n${results.map((r) => `- ${r.outcome}: ${r.id}${r.detail ? ' — ' + r.detail : ''}`).join('\n')}\n\n## Pending desktop/user checks\n\n${pending.map((p) => '- ' + p).join('\n')}\n\n## Screenshot gallery\n\n${screenshots.map((file) => `- [${file}](screenshots/${file})`).join('\n')}\n`)
console.log(JSON.stringify({ output, screenshots: screenshots.length, failed: results.filter((r) => r.outcome === 'Fail').map((r) => r.id), pending }, null, 2))
if (results.some((r) => r.outcome === 'Fail')) process.exitCode = 1
