'use strict'
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process'), assert = require('node:assert/strict')
const policy = require('./standard-release-policy.cjs')
function releaseVersion(root) {
  const product = path.join(root, 'shared/productBuild.json')
  const version = fs.existsSync(product) ? JSON.parse(fs.readFileSync(product, 'utf8')).releaseVersion : JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'PUBLIC_SOURCE_VERSION_REQUIRED')
  return version
}
function safeRelative(value) {
  assert.ok(typeof value === 'string' && value && !path.isAbsolute(value) && !value.includes('\\') && !value.split('/').some(part => !part || ['.', '..', '.git', 'node_modules'].includes(part)), 'PUBLIC_SOURCE_INVALID_PATH')
  return value
}
function compatiblePublicLock(lock, manifest) {
  const entry = lock?.packages?.['']
  const same = (a = {}, b = {}) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key])
  return lock?.name === manifest.name && lock.version === manifest.version && entry?.name === manifest.name && entry.version === manifest.version
    && same(entry.dependencies, manifest.dependencies) && same(entry.devDependencies, manifest.devDependencies)
}
function verifyPublicSource(root = path.resolve(__dirname, '..')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'source-manifest.json'), 'utf8')), seen = new Set()
  assert.equal(manifest.edition, 'standard'); assert.equal(manifest.gitHistoryIncluded, false)
  for (const entry of manifest.files) {
    safeRelative(entry.path); assert.ok(!seen.has(entry.path), 'PUBLIC_SOURCE_DUPLICATE'); seen.add(entry.path)
    const file = path.join(root, entry.path), stat = fs.lstatSync(file)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'PUBLIC_SOURCE_INVALID_FILE')
    assert.equal(policy.digest(file), entry.sha256, 'PUBLIC_SOURCE_HASH_MISMATCH: ' + entry.path)
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, manifest.version)
  policy.sourceFiles(root); policy.resourceFiles(root)
  return { success: true, version: manifest.version, filesVerified: seen.size }
}
function exportStandardSource(destination, { root = path.resolve(__dirname, '..'), version = releaseVersion(root), zip = true } = {}) {
  const target = path.resolve(destination)
  assert.ok(!fs.existsSync(target), 'PUBLIC_SOURCE_DESTINATION_MUST_BE_NEW')
  const sources = policy.sourceFiles(root), resources = policy.resourceFiles(root), files = [...new Set([...sources, ...resources])].sort()
  const publicPolicy = JSON.parse(fs.readFileSync(path.join(root, 'scripts/standard-public-files.json'), 'utf8'))
  const publication = publicPolicy.publicationFiles || []
  const destinations = new Set(files)
  for (const entry of publication) {
    safeRelative(entry.source); safeRelative(entry.target)
    assert.ok(!destinations.has(entry.target), 'PUBLIC_SOURCE_PUBLICATION_COLLISION'); destinations.add(entry.target)
    const stat = fs.lstatSync(path.join(root, entry.source)); assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'PUBLIC_SOURCE_PUBLICATION_MISSING')
  }
  fs.mkdirSync(target, { recursive: true })
  for (const relative of files) {
    assert.ok(!relative.startsWith('.') && !relative.includes('/../') && !relative.includes('node_modules/'), relative)
    const source = path.join(root, relative), output = path.join(target, relative)
    assert.ok(output.startsWith(target + path.sep), 'PUBLIC_SOURCE_TARGET_OUTSIDE')
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(source, output)
  }
  for (const entry of publication) {
    const output = path.join(target, entry.target)
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(path.join(root, entry.source), output)
  }
  // The exported repository can export itself without the private workspace.
  publicPolicy.publicationFiles = publication.map(entry => ({ source: entry.target, target: entry.target }))
  fs.writeFileSync(path.join(target, 'scripts/standard-public-files.json'), JSON.stringify(publicPolicy, null, 2) + '\n', 'utf8')
  const manifest = policy.packageManifest(root, version)
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  const rootLockPath = path.join(root, 'package-lock.json')
  const rootLock = fs.existsSync(rootLockPath) ? JSON.parse(fs.readFileSync(rootLockPath, 'utf8')) : null
  if (compatiblePublicLock(rootLock, manifest)) fs.copyFileSync(rootLockPath, path.join(target, 'package-lock.json'))
  else {
    const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    const locked = spawnSync(process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--cache', path.join(root, '.acceptance/standard-npm-cache')], { cwd: target, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 })
    if (locked.status !== 0) throw Error('Unable to lock the standalone source dependencies: ' + String(locked.stderr || locked.error || '').slice(-1200))
  }
  const lock = JSON.parse(fs.readFileSync(path.join(target, 'package-lock.json'), 'utf8'))
  assert.ok(!Object.keys(lock.packages || {}).some(name => /(?:@ai-sdk|node_modules\/ai(?:\/|$)|bla-agents|sherpa-onnx)/.test(name)), 'PRIVATE_SOURCE_DEPENDENCY')
  fs.writeFileSync(path.join(target, '.gitignore'), 'node_modules/\n.standard-build/\n.standard-release-stage-*/\nrelease-standard-*/\nstandard-public-source-*/\nstandard-public-source-*.zip\n.acceptance/\n**/bin/\n**/obj/\n.env\n.env.*\n*.log\n', 'utf8')
  fs.writeFileSync(path.join(target, '.gitattributes'), '* -text\n', 'utf8')
  const actual = policy.walk(target).map(file => path.relative(target, file).replace(/\\/g, '/')).sort()
  const expected = [...destinations, 'package.json', 'package-lock.json', '.gitignore', '.gitattributes'].sort()
  assert.deepEqual(actual, expected, 'PUBLIC_SOURCE_EXTRA_FILE')
  const inventory = actual.map(file => ({ path: file, sha256: policy.digest(path.join(target, file)) }))
  fs.writeFileSync(path.join(target, 'source-manifest.json'), JSON.stringify({ edition: 'standard', version, files: inventory, gitHistoryIncluded: false }, null, 2), 'utf8')
  let archive
  if (zip) {
    archive = target + '.zip'; assert.ok(!fs.existsSync(archive))
    const quote = value => "'" + value.replace(/'/g, "''") + "'"
    // Windows PowerShell's older ZipFile.CreateFromDirectory writes backslash
    // entry names. Create each UTF-8 ZIP entry explicitly using portable paths.
    const script = [
      'Add-Type -AssemblyName System.IO.Compression',
      `$sourceDirectory = ${quote(target)}`,
      `$archiveStream = [System.IO.File]::Open(${quote(archive)}, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)`,
      '$sourceArchive = [System.IO.Compression.ZipArchive]::new($archiveStream, [System.IO.Compression.ZipArchiveMode]::Create, $false, [System.Text.Encoding]::UTF8)',
      'try {',
      '  foreach ($sourceFile in [System.IO.Directory]::EnumerateFiles($sourceDirectory, "*", [System.IO.SearchOption]::AllDirectories)) {',
      "    $relativeName = $sourceFile.Substring($sourceDirectory.Length + 1).Replace('\\', '/')",
      '    $sourceEntry = $sourceArchive.CreateEntry($relativeName, [System.IO.Compression.CompressionLevel]::Optimal)',
      '    $inputStream = [System.IO.File]::OpenRead($sourceFile)',
      '    try { $entryStream = $sourceEntry.Open(); try { $inputStream.CopyTo($entryStream) } finally { $entryStream.Dispose() } } finally { $inputStream.Dispose() }',
      '  }',
      '} finally { $sourceArchive.Dispose(); $archiveStream.Dispose() }',
    ].join('\n')
    const zipped = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 180000 })
    if (zipped.status !== 0) throw Error(zipped.stderr || 'Source ZIP failed')
  }
  return { directory: target, archive, archiveSha256: archive ? policy.digest(archive) : undefined, files: inventory.length, gitHistoryIncluded: false }
}
module.exports = { exportStandardSource, verifyPublicSource, releaseVersion, safeRelative, compatiblePublicLock }
if (require.main === module) { try { console.log(JSON.stringify(process.argv[2] === '--verify' ? verifyPublicSource(process.argv[3] || path.resolve(__dirname, '..')) : exportStandardSource(process.argv[2] || path.join(process.cwd(), 'standard-public-source-' + Date.now())))) } catch (error) { console.error(error); process.exitCode = 1 } }
