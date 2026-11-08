'use strict'
// Resolve precisely the same public adapters as the bundler. A source archive
// never needs the private project's tsconfig or an undeclared private module.
const ts = require('typescript'), path = require('node:path'), assert = require('node:assert/strict'), policy = require('./standard-release-policy.cjs')
function typecheckStandard(root = path.resolve(__dirname, '..')) {
  const publicFiles = policy.sourceFiles(root), allowed = new Set(publicFiles.map(file => path.resolve(root, file).toLowerCase()))
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: ['node'], strict: true, skipLibCheck: true,
    noEmit: true, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, resolveJsonModule: true, allowImportingTsExtensions: true }
  const host = ts.createCompilerHost(options), replacements = policy.aliases(root)
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    const replacement = name.startsWith('.') && replacements[path.basename(name).replace(/\.ts$/, '')]
    if (replacement) return { resolvedFileName: replacement, extension: ts.Extension.Ts, isExternalLibraryImport: false }
    return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
  })
  const program = ts.createProgram(publicFiles.filter(file => /\.tsx?$/.test(file)).map(file => path.join(root, file)), options, host)
  for (const file of program.getSourceFiles()) if (!file.fileName.replace(/\\/g, '/').includes('/node_modules/')) assert.ok(allowed.has(path.resolve(file.fileName).toLowerCase()), 'STANDARD_PRIVATE_TYPE_INPUT: ' + file.fileName)
  const errors = ts.getPreEmitDiagnostics(program)
  if (errors.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => '\n' }))
    throw Error('Standard source typecheck failed')
  }
  return { success: true, publicSourceFiles: publicFiles.length, checkedFiles: program.getSourceFiles().filter(file => !file.isDeclarationFile).length }
}
module.exports = { typecheckStandard }
if (require.main === module) { try { console.log(JSON.stringify(typecheckStandard())) } catch (error) { console.error(error.message); process.exitCode = 1 } }
