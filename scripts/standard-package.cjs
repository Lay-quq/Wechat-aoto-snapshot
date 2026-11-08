'use strict'
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { compileStandard } = require('./standard-build.cjs'), { prepareStandardDependencies } = require('./standard-dependencies.cjs'), policy = require('./standard-release-policy.cjs')
// Electron 43 exposes install-electron instead of an npm postinstall hook.
// A clean public checkout must prepare its own runtime before electron-builder
// uses electronDist; it must never fall back to the private workspace's runtime.
function ensureElectronRuntime(electronDirectory, run = spawnSync) {
  const version = JSON.parse(fs.readFileSync(path.join(electronDirectory, 'package.json'), 'utf8')).version
  const distribution = path.join(electronDirectory, 'dist'), executable = path.join(distribution, 'electron.exe')
  const ready = () => fs.existsSync(executable) && fs.statSync(executable).isFile()
    && fs.existsSync(path.join(distribution, 'version')) && fs.readFileSync(path.join(distribution, 'version'), 'utf8').trim().replace(/^v/, '') === version
  if (!ready()) {
    // Keep download/cache renames on the checkout volume. Windows profiles may
    // redirect TEMP or AppData to a different volume via junctions.
    const cache = path.join(electronDirectory, '.download', 'cache'), temporary = path.join(electronDirectory, '.download', 'tmp')
    fs.mkdirSync(cache, { recursive: true }); fs.mkdirSync(temporary, { recursive: true })
    const result = run(process.execPath, [path.join(electronDirectory, 'install.js')], { cwd: electronDirectory, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, electron_config_cache: cache, TEMP: temporary, TMP: temporary, ELECTRON_INSTALL_PLATFORM: 'win32', ELECTRON_INSTALL_ARCH: 'x64' } })
    assert.equal(result.status, 0, 'STANDARD_ELECTRON_INSTALL_FAILED: ' + (result.error?.message || result.signal || result.status))
  }
  assert.ok(ready(), 'STANDARD_ELECTRON_RUNTIME_UNAVAILABLE_OR_VERSION_MISMATCH')
  return distribution
}
async function packageStandard(options = {}) {
  const root = options.root || path.resolve(__dirname, '..'), version = options.version || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const stage = options.stage || path.join(root, '.standard-release-stage-' + Date.now()), output = options.output || path.join(root, 'release-standard-' + version + '-' + Date.now())
  const compiled = await compileStandard(stage, { root, version }); prepareStandardDependencies(stage, { root })
  const builder = require('electron-builder'), electronPackage = require.resolve('electron/package.json'), electronDirectory = path.dirname(electronPackage)
  const electronDist = ensureElectronRuntime(electronDirectory)
  let verification, native
  const artifacts = await builder.build({ projectDir: stage, targets: builder.Platform.WINDOWS.createTarget(['nsis'], builder.Arch.x64), config: {
    extends: null, appId: 'com.wechatauto.app', productName: 'WeChatAuto', artifactName: `WeChatAuto-standard-${version}-Setup.\${ext}`, publish: null,
    electronDist, electronVersion: JSON.parse(fs.readFileSync(electronPackage, 'utf8')).version,
    directories: { output }, npmRebuild: false,
    files: ['dist/**/*', 'dist-electron/**/*', 'package.json', '!**/*.map'],
    win: { target: ['nsis'], executableName: 'WeFlow', icon: path.join(root, 'public/icon.ico'), extraFiles: fs.readdirSync(path.join(root, 'resources/runtime/win32')).filter(name => name.endsWith('.dll')).map(name => ({ from: path.join(root, 'resources/runtime/win32', name), to: name })) },
    extraResources: [...policy.RESOURCE_DIRECTORIES.map(directory => ({ from: path.join(root, directory), to: directory })), { from: path.join(root, 'public/icon.ico'), to: 'icon.ico' },
      { from: path.join(root, 'LICENSE'), to: 'LICENSE.txt' }, { from: path.join(root, 'NOTICE'), to: 'NOTICE.txt' }],
    asarUnpack: ['node_modules/silk-wasm/**/*', 'node_modules/ffmpeg-static/**/*'],
    nsis: { oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, shortcutName: 'WeChatAuto - 普通版', deleteAppDataOnUninstall: false, include: path.join(root, 'installer-commercial.nsh') },
    afterPack: context => { verification = policy.verifyPackaged(root, stage, context.appOutDir) },
    afterSign: context => { native = require('./check-wcdb-host.cjs').checkWcdbHost({ packaged: context.appOutDir, evidenceRoot: stage }); assert.ok(native.success, native.error) },
  } })
  assert.ok(verification?.success && native?.success, 'Standard release checks must run')
  const report = { version, packaged: path.join(output, 'win-unpacked'), artifacts: artifacts.filter(file => file.endsWith('.exe')).map(file => ({ file, bytes: fs.statSync(file).size, sha256: policy.digest(file) })), verified: true, hardening: [], sourceFiles: compiled.sources.length }
  fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(report, null, 2), 'utf8')
  return report
}
module.exports = { packageStandard, ensureElectronRuntime }
if (require.main === module) packageStandard().then(report => console.log(JSON.stringify(report))).catch(error => { console.error(error); process.exitCode = 1 })
