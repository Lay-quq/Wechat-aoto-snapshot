'use strict'
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process'), assert = require('node:assert/strict')
const { RUNTIME_DEPENDENCIES, digest, dependencyInventory } = require('./standard-release-policy.cjs')
function prepareDependencies(stage, names, { root = path.resolve(__dirname, '..'), rejectPackages = null } = {}) {
  root = path.resolve(root)
  const base = path.resolve(root, 'node_modules'), target = path.resolve(stage, 'node_modules')
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw Error('STANDARD_DEPENDENCY_STAGE_MUST_BE_EMPTY')
  const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  if (!fs.existsSync(npm)) throw Error('NPM_CLI_NOT_FOUND: ' + npm)
  const query = spawnSync(process.execPath, [npm, 'ls', '--omit=dev', '--all', '--long', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120000 })
  if (query.error) throw query.error
  let tree; try { tree = JSON.parse(query.stdout) } catch { throw Error('Cannot inspect installed production dependency graph') }
  const selected = new Map(), graph = new Map(), realBase = fs.realpathSync(base)
  const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const within = (parent, file) => { const relative = path.relative(parent, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
  // npm's repeated/deduplicated nodes may contain no child edges. Index every
  // occurrence by installed path, then close over each package's own runtime
  // declarations instead of trusting whichever occurrence is visited first.
  function index(node) {
    if (!node) return
    if (node.path && node.version && !node.extraneous) graph.set(key(node.path), node)
    for (const child of Object.values(node.dependencies || {})) index(child)
  }
  index(tree)
  function resolveInstalled(name, from) {
    assert.ok(typeof name === 'string' && /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) && !name.split('/').some(part => part === '.' || part === '..'), 'INVALID_DEPENDENCY_NAME')
    // This is Node's ancestor node_modules search, bounded at this project.
    // Read package metadata directly: CSS-only/exports-restricted packages do
    // not have to export package.json (or a JavaScript entry point).
    for (let cursor = from; cursor === root || within(root, cursor); cursor = path.dirname(cursor)) {
      if (path.basename(cursor) === 'node_modules') continue
      const candidate = path.join(cursor, 'node_modules', name)
      const manifest = path.join(candidate, 'package.json')
      if (!fs.existsSync(manifest)) continue
      assert.ok(within(base, candidate) && within(realBase, fs.realpathSync(candidate)) && within(realBase, fs.realpathSync(manifest)), 'DEPENDENCY_OUTSIDE_NODE_MODULES')
      return candidate
    }
  }
  function select(node, expectedName) {
    if (!node || !node.path || !node.version) throw Error('Incomplete installed dependency: ' + expectedName)
    const source = path.resolve(node.path), relative = path.relative(base, source)
    assert.ok(within(base, source) && within(realBase, fs.realpathSync(source)), 'DEPENDENCY_OUTSIDE_NODE_MODULES')
    if (selected.has(key(source))) return
    const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
    assert.ok(!rejectPackages || !rejectPackages.test(metadata.name), 'PRIVATE_DEPENDENCY_IN_PUBLIC_GRAPH')
    assert.equal(metadata.version, node.version, 'INSTALLED_DEPENDENCY_VERSION_CHANGED: ' + expectedName)
    selected.set(key(source), { source, relative, name: metadata.name, version: metadata.version })
    // Match electron-builder's shipped production graph: declarations in
    // dependencies/optionalDependencies. Peer-only branches (including entire
    // renderer/tooling ecosystems) are not implicitly shipped. Required peers
    // must already be explicit runtime roots or ordinary dependencies, and the
    // compiled Node/native load checks verify those actual runtime imports.
    const runtime = { ...metadata.dependencies, ...metadata.optionalDependencies }
    for (const name of Object.keys(runtime)) {
      const optional = Object.hasOwn(metadata.optionalDependencies || {}, name)
      const installed = resolveInstalled(name, source), found = installed && graph.get(key(installed))
      if (!found && optional) continue
      if (!found) throw Error('Missing production dependency: ' + metadata.name + ' -> ' + name)
      select(found, name)
    }
  }
  for (const name of names) {
    const installed = resolveInstalled(name, root)
    select(installed && graph.get(key(installed)), name)
  }
  fs.mkdirSync(target, { recursive: true })
  const records = [...selected.values()].sort((a, b) => a.relative.length - b.relative.length)
  for (const record of records) {
    const destination = path.join(target, record.relative)
    assert.ok(destination.startsWith(target + path.sep))
    fs.cpSync(record.source, destination, { recursive: true, dereference: true, filter: source => path.basename(source) !== 'node_modules' })
  }
  const dependencies = records.map(({ relative, name, version }) => {
    const files = dependencyInventory(path.join(target, relative))
    return { path: relative.replace(/\\/g, '/'), name, version, sourcePackageSha256: digest(path.join(target, relative, 'package.json')), packageSha256: files.find(file => file.path === 'package.json').sha256, files }
  })
  fs.writeFileSync(path.join(stage, 'standard-dependency-manifest.json'), JSON.stringify({ version: 2, dependencies }, null, 2), 'utf8')
  return { packages: dependencies.length, dependencies }
}
function prepareStandardDependencies(stage, { root = path.resolve(__dirname, '..') } = {}) {
  return prepareDependencies(stage, RUNTIME_DEPENDENCIES, { root, rejectPackages: /(?:^@ai-sdk\/|^ai$|bla-agents|sherpa-onnx)/ })
}
module.exports = { prepareStandardDependencies, prepareDependencies }
if (require.main === module) { try { const report = prepareStandardDependencies(path.resolve(process.argv[2])); console.log(JSON.stringify({ packages: report.packages })) } catch (error) { console.error(error); process.exitCode = 1 } }
