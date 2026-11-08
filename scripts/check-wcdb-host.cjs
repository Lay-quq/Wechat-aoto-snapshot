'use strict'

// Exercise the shipped native component in the shipped executable. No application
// entry point, account, profile, database, monitor or WeChat process is opened.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const marker = 'WCDB_HOST_PROBE '
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function isolatedEnvironment(environment, profile) {
  const env = { ...environment }
  for (const key of Object.keys(env)) {
    if (/^(?:WEFLOW_|WCDB_|WCA_|COMMERCIAL_|ELECTRON_|NODE_|HOME$|HOMEDRIVE$|HOMEPATH$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|TEMP$|TMP$|XDG_)/i.test(key)) delete env[key]
  }
  const drive = path.parse(profile).root.replace(/[\\/]+$/, '')
  return Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    HOME: profile, USERPROFILE: profile, HOMEDRIVE: drive,
    HOMEPATH: profile.slice(drive.length),
    APPDATA: path.join(profile, 'roaming'), LOCALAPPDATA: path.join(profile, 'local'),
    TEMP: path.join(profile, 'temp'), TMP: path.join(profile, 'temp'),
    XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_CACHE_HOME: path.join(profile, 'cache'),
    XDG_DATA_HOME: path.join(profile, 'data'),
  })
}

function probeWcdb(request, loader = require, runtime = process) {
  if (path.resolve(runtime.execPath).toLowerCase() !== request.executable.toLowerCase()) throw new Error('Unexpected probe executable')
  if (!runtime.versions.electron || runtime.env.ELECTRON_RUN_AS_NODE !== '1') throw new Error('The packaged Electron Node runtime is required')
  const koffi = loader(request.addon)
  koffi.load(request.coreDll)
  koffi.load(request.sdlDll)
  const lib = koffi.load(request.apiDll)
  const init = lib.func('int32 wcdb_init()')
  const shutdown = lib.func('int32 wcdb_shutdown()')
  const initCode = init()
  const shutdownCode = initCode === 0 ? shutdown() : null
  return { nonce: request.nonce, executable: runtime.execPath, electronVersion: runtime.versions.electron,
    initCode, shutdownCode, databaseOpened: false, accountOpened: false }
}

function readProbe(stdout, nonce) {
  const records = String(stdout || '').split(/\r?\n/).filter(line => line.startsWith(marker))
  if (records.length !== 1) throw new Error('Expected exactly one native initialization result')
  const result = JSON.parse(records[0].slice(marker.length))
  if (result.nonce !== nonce) throw new Error('Native probe result did not match this invocation')
  return result
}

function checkWcdbHost({ packaged, executableName = 'WeFlow.exe', evidenceRoot = path.join(root, '.acceptance', 'wcdb-host') }, dependencies = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WCDB host acceptance requires Windows x64')
  if (path.basename(executableName) !== executableName || !executableName.endsWith('.exe')) throw new Error('Expected one executable basename')
  const directory = path.resolve(packaged)
  const evidenceBase = path.resolve(evidenceRoot)
  fs.mkdirSync(evidenceBase, { recursive: true })
  const evidence = fs.mkdtempSync(path.join(evidenceBase, 'wcdb-host-'))
  const profile = path.join(evidence, 'profile')
  const env = isolatedEnvironment(process.env, profile)
  for (const name of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) fs.mkdirSync(env[name], { recursive: true })
  const nativeDirectory = path.join(directory, 'resources', 'resources', 'wcdb', 'win32', 'x64')
  const request = {
    nonce: crypto.randomBytes(24).toString('hex'),
    executable: path.join(directory, executableName),
    addon: path.join(directory, 'resources', 'app.asar.unpacked', 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'),
    coreDll: path.join(nativeDirectory, 'WCDB.dll'), sdlDll: path.join(nativeDirectory, 'SDL2.dll'),
    apiDll: path.join(nativeDirectory, 'wcdb_api.dll'),
  }
  const files = Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'nonce'))
  const result = { success: false, executable: request.executable, evidence, databaseOpened: false,
    accountOpened: false, applicationStarted: false, isolatedProfile: profile, files: {}, initCode: null, shutdownCode: null }
  try {
    for (const [key, file] of Object.entries(files)) {
      if (!fs.statSync(file).isFile()) throw new Error('Missing packaged native dependency: ' + key)
      result.files[key] = { path: file, sha256: digest(file) }
    }
    const requestPath = path.join(evidence, 'request.json')
    fs.writeFileSync(requestPath, JSON.stringify(request, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    const run = dependencies.spawnSync || spawnSync
    const child = run(request.executable, [__filename, '--probe', requestPath], {
      cwd: profile, env, windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    fs.writeFileSync(path.join(evidence, 'stdout.log'), child.stdout || '', 'utf8')
    fs.writeFileSync(path.join(evidence, 'stderr.log'), child.stderr || '', 'utf8')
    if (child.error) throw new Error('Native probe process failed: ' + child.error.message)
    if (child.status !== 0) throw new Error('Native probe process exited with status ' + child.status)
    const probe = readProbe(child.stdout, request.nonce)
    if (path.resolve(probe.executable).toLowerCase() !== request.executable.toLowerCase()
      || !probe.electronVersion || probe.databaseOpened !== false || probe.accountOpened !== false) throw new Error('Invalid packaged probe identity')
    result.initCode = probe.initCode
    result.shutdownCode = probe.shutdownCode
    result.electronVersion = probe.electronVersion
    for (const [key, file] of Object.entries(files)) if (digest(file) !== result.files[key].sha256) throw new Error('Packaged file changed during native acceptance: ' + key)
    result.filesUnchanged = true
    if (probe.initCode !== 0 || probe.shutdownCode !== 0) throw new Error('Packaged WCDB lifecycle failed: init=' + probe.initCode + ', shutdown=' + probe.shutdownCode)
    result.success = true
  } catch (error) { result.error = String(error.message || error) }
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  return result
}

if (require.main === module) {
  if (process.argv[2] === '--probe') {
    try {
      const request = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
      console.log(marker + JSON.stringify(probeWcdb(request)))
    } catch (error) { console.error(String(error.message || error)); process.exitCode = 1 }
  } else {
    if (!process.argv[2]) throw new Error('Usage: node scripts/check-wcdb-host.cjs <win-unpacked directory> [executable basename]')
    const result = checkWcdbHost({ packaged: process.argv[2], executableName: process.argv[3] || 'WeFlow.exe' })
    console.log(JSON.stringify(result, null, 2))
    if (!result.success) process.exitCode = 1
  }
}

module.exports = { checkWcdbHost, isolatedEnvironment, probeWcdb, readProbe }
