'use strict'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const RUNTIME_DEPENDENCIES = ['exceljs', 'ffmpeg-static', 'fzstd', 'koffi', 'silk-wasm', 'wechat-emojis', 'react', 'react-dom']
const DEVELOPMENT_DEPENDENCIES = ['@vitejs/plugin-react', '@types/react', '@types/react-dom', 'electron', 'electron-builder', 'esbuild', 'lucide-react', 'sass', 'typescript', 'vite']
const SOURCE_DIRECTORIES = ['electron/standard', 'electron/services/export', 'src/standard', 'tools/wechat-connection-helper']
const PUBLIC_FILES = require('./standard-public-files.json'), SOURCE_FILES = Object.freeze([...PUBLIC_FILES.sourceFiles])
const RESOURCE_DIRECTORIES = ['resources/wcdb/win32/x64', 'resources/key/win32/x64', 'resources/wedecrypt/win32/x64', 'resources/welive/win32/x64', 'resources/wechat-connection/win32-x64', 'resources/runtime/win32']
const forbidden = /(?:ReplyAssistantService|AutomaticReplyPipeline|AgentHubService|REPLY_NATIVE_QUOTE|agentRunWorker|replyInsightsWorker|replyTextWorker|commercial-device\.v1|commercial:login|@ai-sdk\/|bla-agents)/
const slash = file => file.replace(/\\/g, '/')
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const bytesDigest = value => crypto.createHash('sha256').update(value).digest('hex')
// electron-builder 26.15.3's documented package transformer removes only build
// metadata. Keep the exact resulting bytes in our pre-build manifest; changing
// an entry point, dependency, version or arbitrary field still changes the hash.
function packagedDependencyJson(bytes) {
  const data = JSON.parse(bytes.toString('utf8')), ignored = new Set(['dist', 'gitHead', 'build', 'jspm', 'ava', 'xo', 'nyc', 'eslintConfig', 'contributors', 'bundleDependencies', 'tags', 'scripts', 'keywords', 'bugs'])
  const removeBabel = data.dependencies && typeof data.dependencies === 'object' && !Object.keys(data.dependencies).some(name => name.startsWith('babel'))
  let changed = false
  for (const key of Object.keys(data)) if (key.startsWith('_') || ignored.has(key) || removeBabel && key === 'babel') { delete data[key]; changed = true }
  return changed ? Buffer.from(JSON.stringify(data, null, 2), 'utf8') : bytes
}
function dependencyInventory(directory) {
  function visit(base) { return fs.readdirSync(base, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(base, entry.name)
    assert.ok(!entry.isSymbolicLink(), 'STANDARD_DEPENDENCY_SYMLINK')
    return entry.isDirectory() ? entry.name === 'node_modules' ? [] : visit(file) : [file]
  }) }
  return visit(directory).map(file => ({ path: slash(path.relative(directory, file)), sha256: path.basename(file) === 'package.json' ? bytesDigest(packagedDependencyJson(fs.readFileSync(file))) : digest(file) })).sort((a, b) => a.path.localeCompare(b.path))
}
function verifyDependencyFiles(dependencies, files, read) {
  const identity = value => `${value.name}@${value.version}:${value.packageSha256}`, expected = new Map()
  for (const dependency of dependencies) {
    assert.ok(Array.isArray(dependency.files) && dependency.files.length, 'STANDARD_DEPENDENCY_CONTENT_MANIFEST_REQUIRED')
    const key = identity(dependency), allowed = expected.get(key) || new Map()
    for (const file of dependency.files) { assert.ok(!allowed.has(file.path) || allowed.get(file.path) === file.sha256, 'STANDARD_DEPENDENCY_CONTENT_COLLISION'); allowed.set(file.path, file.sha256) }
    assert.equal(allowed.get('package.json'), dependency.packageSha256, 'STANDARD_DEPENDENCY_MANIFEST_INCONSISTENT')
    expected.set(key, allowed)
  }
  const packageFiles = files.filter(value => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(value)), actual = new Map()
  for (const file of packageFiles) {
    const bytes = read(file), value = JSON.parse(bytes.toString('utf8')), key = identity({ name: value.name, version: value.version, packageSha256: bytesDigest(bytes) })
    assert.ok(expected.has(key), 'STANDARD_UNKNOWN_RUNTIME_PACKAGE: ' + file)
    actual.set(file.slice(0, -'/package.json'.length), key)
  }
  assert.deepEqual([...new Set(actual.values())].sort(), [...expected.keys()].sort(), 'STANDARD_MISSING_RUNTIME_PACKAGE_VERSION')
  const roots = [...actual.keys()].sort((a, b) => b.length - a.length)
  for (const file of files) {
    const directory = roots.find(root => file.startsWith(root + '/'))
    assert.ok(directory, 'STANDARD_UNOWNED_DEPENDENCY_FILE: ' + file)
    const relative = file.slice(directory.length + 1), expectedHash = expected.get(actual.get(directory)).get(relative)
    assert.ok(expectedHash, 'STANDARD_UNKNOWN_DEPENDENCY_FILE: ' + file)
    assert.equal(bytesDigest(read(file)), expectedHash, 'STANDARD_DEPENDENCY_FILE_CHANGED: ' + file)
  }
  return { runtimePackagesVerified: actual.size, runtimePackageVersionsVerified: expected.size, runtimeFilesVerified: files.length }
}
function assertArchiveNamespace(files) {
  for (const file of files) assert.ok(file === 'package.json' || /^(?:dist|dist-electron|node_modules)(?:\/|$)/.test(file), 'STANDARD_UNKNOWN_ARCHIVE_ROOT: ' + file)
}
function verifyPackagedDependencies(stage, archive) {
  const asar = require('@electron/asar'), dependencies = JSON.parse(fs.readFileSync(path.join(stage, 'standard-dependency-manifest.json'), 'utf8')).dependencies
  const listed = asar.listPackage(archive).map(value => value.replace(/^[/\\]+/, '').replace(/\\/g, '/'))
  const dependencyFiles = listed.filter(value => value.startsWith('node_modules/') && !asar.statFile(archive, path.normalize(value)).files)
  return verifyDependencyFiles(dependencies, dependencyFiles, item => asar.extractFile(archive, path.normalize(item)))
}
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw Error('STANDARD_SYMLINK_FORBIDDEN: ' + file)
    if (entry.isDirectory()) return ['node_modules', 'bin', 'obj', '.git'].includes(entry.name) ? [] : walk(file)
    return [file]
  })
}
function sourceFiles(root) {
  const allowed = new Set(SOURCE_FILES)
  for (const directory of SOURCE_DIRECTORIES) for (const file of walk(path.join(root, directory))) {
    const relative = slash(path.relative(root, file)); assert.ok(allowed.has(relative), 'STANDARD_UNREVIEWED_SOURCE: ' + relative)
  }
  for (const file of allowed) {
    assert.ok(file && !file.startsWith('.') && !file.split('/').includes('..') && !path.isAbsolute(file), 'STANDARD_INVALID_PUBLIC_PATH')
    const stat = fs.lstatSync(path.join(root, file)); assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'STANDARD_PUBLIC_SOURCE_UNAVAILABLE: ' + file)
  }
  return [...allowed].sort()
}
function resourceFiles(root) {
  const files = RESOURCE_DIRECTORIES.flatMap(directory => walk(path.join(root, directory)).map(file => slash(path.relative(root, file)))).sort()
  assert.deepEqual(files, PUBLIC_FILES.resources.map(file => file.path).sort(), 'STANDARD_UNREVIEWED_OR_MISSING_RESOURCE')
  for (const file of PUBLIC_FILES.resources) assert.equal(digest(path.join(root, file.path)), file.sha256, 'STANDARD_NATIVE_RESOURCE_CHANGED: ' + file.path)
  return files
}
function packageManifest(root, version) {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const installedVersion = name => { const file = path.join(root, 'node_modules', name, 'package.json'); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).version : source.dependencies?.[name] || source.devDependencies?.[name] }
  return { name: 'wechat-aoto-snapshot', version, description: 'Local-first WeChat history: browse, decode and export.', main: 'dist-electron/standardMain.js', author: { name: 'Lay-quq' },
    repository: { type: 'git', url: 'https://github.com/Lay-quq/Wechat-aoto-snapshot.git' }, homepage: 'https://github.com/Lay-quq/Wechat-aoto-snapshot#readme',
    bugs: { url: 'https://github.com/Lay-quq/Wechat-aoto-snapshot/issues' }, license: 'Apache-2.0', private: true,
    scripts: { 'build': 'node scripts/standard-package.cjs', 'build:compile': 'node scripts/standard-build.cjs .standard-build', 'typecheck': 'node scripts/standard-typecheck.cjs', 'test:source': 'node scripts/standard-release-policy.cjs', 'verify:source': 'node scripts/standard-source-export.cjs --verify', 'export:source': 'node scripts/standard-source-export.cjs' },
    dependencies: Object.fromEntries(RUNTIME_DEPENDENCIES.map(name => [name, installedVersion(name)])),
    devDependencies: { ...Object.fromEntries(DEVELOPMENT_DEPENDENCIES.map(name => [name, installedVersion(name)])), '@types/node': installedVersion('@types/node') || '^24.0.0' } }
}
function aliases(root) {
  return { config: path.join(root, 'electron/standard/config.ts'), chatService: path.join(root, 'electron/standard/chat.ts'), wcdbService: path.join(root, 'electron/standard/wcdb.ts'),
    nativeComponents: path.join(root, 'electron/standard/nativeComponents.ts'), voiceTranscribeService: path.join(root, 'electron/standard/noTranscript.ts') }
}
function aliasPlugin(root, worker = false) {
  const replacements = aliases(root)
  return { name: 'standard-public-only', setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (worker && args.path === 'electron') return { path: path.join(root, 'electron/standard/workerElectron.ts') }
      const name = path.basename(args.path).replace(/\.ts$/, '')
      if (args.path.startsWith('.') && replacements[name]) return { path: replacements[name] }
    })
  } }
}
function assertInputGraph(root, metafiles) {
  const allowed = new Set(sourceFiles(root)), inputs = [...new Set(metafiles.flatMap(meta => Object.keys(meta.inputs)).map(file => slash(path.relative(root, path.resolve(root, file)))))]
  for (const file of inputs) {
    if (file.startsWith('node_modules/')) {
      assert.ok(!/@ai-sdk|bla-agents|sherpa-onnx|agent/i.test(file), 'STANDARD_PRIVATE_DEPENDENCY: ' + file)
    } else assert.ok(allowed.has(file), 'STANDARD_PRIVATE_SOURCE: ' + file)
  }
  return inputs.sort()
}
function verifyCompiled(stage) {
  const inventory = JSON.parse(fs.readFileSync(path.join(stage, 'standard-compiled-manifest.json'), 'utf8'))
  const files = ['dist', 'dist-electron'].flatMap(dir => walk(path.join(stage, dir)).map(file => slash(path.relative(stage, file)))).sort()
  assert.deepEqual(files, inventory.files.map(item => item.path).sort(), 'STANDARD_EXTRA_OR_MISSING_COMPILED_FILE')
  for (const file of inventory.files) {
    assert.equal(digest(path.join(stage, file.path)), file.sha256, 'STANDARD_COMPILED_HASH_MISMATCH: ' + file.path)
    if (/\.(js|css|html)$/.test(file.path)) assert.ok(!forbidden.test(fs.readFileSync(path.join(stage, file.path), 'utf8')), 'STANDARD_PRIVATE_CODE: ' + file.path)
  }
  return { success: true, filesVerified: files.length, privateCodeAbsent: true }
}
function verifyPackaged(root, stage, packaged) {
  const result = verifyCompiled(stage), asar = require('@electron/asar'), file = path.join(packaged, 'resources/app.asar')
  const inventory = JSON.parse(fs.readFileSync(path.join(stage, 'standard-compiled-manifest.json'), 'utf8'))
  const listed = asar.listPackage(file).map(value => value.replace(/^[/\\]+/, '').replace(/\\/g, '/'))
  assertArchiveNamespace(listed)
  const actual = listed.filter(value => /^(?:dist|dist-electron)\//.test(value) && !asar.statFile(file, path.normalize(value)).files).sort()
  assert.deepEqual(actual, inventory.files.map(item => item.path).sort(), 'STANDARD_EXTRA_ARCHIVE_FILE')
  for (const entry of inventory.files) assert.equal(crypto.createHash('sha256').update(asar.extractFile(file, path.normalize(entry.path))).digest('hex'), entry.sha256)
  assert.ok(!listed.some(value => /(?:@ai-sdk|bla-agents|agentRunWorker|replyInsightsWorker|replyTextWorker|sherpa-onnx)/.test(value)), 'STANDARD_PRIVATE_RUNTIME')
  const dependencyReport = verifyPackagedDependencies(stage, file)
  const resourceList = resourceFiles(root)
  for (const source of resourceList) assert.equal(digest(path.join(packaged, 'resources', source)), digest(path.join(root, source)), 'STANDARD_RESOURCE_MISMATCH: ' + source)
  const shippedResources = walk(path.join(packaged, 'resources/resources')).map(item => slash(path.relative(path.join(packaged, 'resources'), item))).sort()
  assert.deepEqual(shippedResources, resourceList, 'STANDARD_EXTRA_RESOURCE')
  return { ...result, ...dependencyReport, resourcesVerified: resourceList.length, archiveFilesVerified: actual.length, appAsarSha256: digest(file) }
}
module.exports = { RUNTIME_DEPENDENCIES, DEVELOPMENT_DEPENDENCIES, SOURCE_FILES, SOURCE_DIRECTORIES, RESOURCE_DIRECTORIES, sourceFiles, resourceFiles, packageManifest, aliases, aliasPlugin, assertInputGraph, verifyCompiled, verifyPackaged, packagedDependencyJson, dependencyInventory, verifyDependencyFiles, verifyPackagedDependencies, assertArchiveNamespace, walk, digest }
if (require.main === module) {
  const root = path.resolve(__dirname, '..')
  const files = sourceFiles(root); for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), file)
  console.log(JSON.stringify({ publicSourceFiles: files.length, resources: resourceFiles(root).length }))
}
