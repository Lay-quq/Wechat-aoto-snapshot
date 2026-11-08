'use strict'
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process')
const policy = require('./standard-release-policy.cjs')
async function compileStandard(stage, options = {}) {
  const root = options.root || path.resolve(__dirname, '..'), output = path.resolve(stage), version = options.version || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  policy.resourceFiles(root)
  const typecheck = require('./standard-typecheck.cjs').typecheckStandard(root)
  fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(path.join(output, 'dist-electron'), { recursive: true })
  for (const dir of ['dist', 'dist-electron']) if (fs.existsSync(path.join(output, dir)) && fs.readdirSync(path.join(output, dir)).length) throw Error('STANDARD_STAGE_MUST_BE_EMPTY')
  const log = fs.openSync(path.join(output, 'vite.log'), 'w')
  const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js')
  const rendered = spawnSync(process.execPath, [vite, 'build', '--config', path.join(root, 'vite.standard.config.ts'), '--outDir', path.join(output, 'dist')], { cwd: root, windowsHide: true, stdio: ['ignore', log, log] })
  fs.closeSync(log)
  if (rendered.status !== 0) throw Error('Standard renderer build failed: ' + fs.readFileSync(path.join(output, 'vite.log'), 'utf8').slice(-2500))
  const esbuild = require('esbuild'), metafiles = []
  for (const [input, name, worker] of [['electron/standardMain.ts', 'standardMain.js', false], ['electron/standardPreload.ts', 'standardPreload.js', false], ['electron/exportWorker.ts', 'standardExportWorker.js', true], ['electron/imageDecryptWorker.ts', 'imageDecryptWorker.js', true], ['electron/standard/helloWorker.ts', 'standardHelloWorker.js', true]]) {
    const result = await esbuild.build({ entryPoints: [path.join(root, input)], outfile: path.join(output, 'dist-electron', name), bundle: true, platform: 'node', format: 'cjs', packages: 'external', sourcemap: false, metafile: true, plugins: [policy.aliasPlugin(root, worker)] })
    metafiles.push(result.metafile)
  }
  const sources = policy.assertInputGraph(root, metafiles)
  const files = ['dist', 'dist-electron'].flatMap(dir => policy.walk(path.join(output, dir))).map(file => ({ path: path.relative(output, file).replace(/\\/g, '/'), sha256: policy.digest(file) }))
  fs.writeFileSync(path.join(output, 'standard-compiled-manifest.json'), JSON.stringify({ edition: 'standard', version, files, sources }, null, 2), 'utf8')
  const manifest = policy.packageManifest(root, version)
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  fs.writeFileSync(path.join(output, 'hardening.json'), '[]\n', 'utf8')
  return { stage: output, package: manifest, ...policy.verifyCompiled(output), typecheck, sources }
}
module.exports = { compileStandard }
if (require.main === module) compileStandard(process.argv[2] || '.standard-build').then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1 })
