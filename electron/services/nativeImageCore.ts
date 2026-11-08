// This module also runs in a Node worker thread. Keep Electron and application
// configuration imports out of its entire dependency graph.
import { existsSync } from 'node:fs'

export type NativeDatMeta = { version?: number; aesSize?: number; aes_size?: number; xorSize?: number; xor_size?: number;
  rawSize?: number; raw_size?: number; flag?: number }
export type NativeImageResult = { data: Buffer; ext: string; isWxgf: boolean; meta: NativeDatMeta }
export type NativeImageDiagnosticCode = 'disabled' | 'addon_missing' | 'addon_load_failed' | 'api_missing'
  | 'decrypt_failed' | 'invalid_result' | 'worker_unavailable' | 'worker_failed' | 'worker_timeout'
export type NativeImageDiagnostic = { code: NativeImageDiagnosticCode; message: string }
const diagnosticMessages: Record<NativeImageDiagnosticCode, string> = {
  disabled: '原生图片解密已停用', addon_missing: '未找到图片解密组件', addon_load_failed: '图片解密组件加载失败，请检查组件兼容性',
  api_missing: '图片解密组件缺少所需接口', decrypt_failed: '原生图片解密失败，请检查文件和图片密钥配置',
  invalid_result: '图片解密组件返回了无效数据', worker_unavailable: '图片解密后台线程文件缺失',
  worker_failed: '图片解密后台线程启动或运行失败', worker_timeout: '图片解密后台线程超时',
}
export const nativeImageDiagnostic = (code: NativeImageDiagnosticCode): NativeImageDiagnostic => ({ code, message: diagnosticMessages[code] })
export function nativeImageCandidates(filePath: string): string[] {
  if (!filePath) return []
  return filePath.includes('app.asar') && !filePath.includes('app.asar.unpacked')
    ? [filePath.replace('app.asar', 'app.asar.unpacked'), filePath] : [filePath]
}
type NativeAddon = {
  decryptDatNative(inputPath: string, xorKey: number, aesKey?: string): NativeDatMeta & { data: Buffer; ext?: string; isWxgf?: boolean; is_wxgf?: boolean }
  encryptDatNative?(inputPath: string, xorKey: number, aesKey?: string, meta?: NativeDatMeta): Buffer
}
export function createNativeImageLoader(candidates: () => string[]) {
  let cachedAddon: NativeAddon | null | undefined, signature = '', diagnostic: NativeImageDiagnostic | undefined
  const fail = (code: NativeImageDiagnosticCode) => { diagnostic = nativeImageDiagnostic(code); return null }
  const reset = () => { cachedAddon = undefined; signature = ''; diagnostic = undefined }
  const load = (): NativeAddon | null => {
    if (process.env.WEFLOW_IMAGE_NATIVE === '0') return fail('disabled')
    const paths = candidates(), nextSignature = JSON.stringify(paths)
    if (signature !== nextSignature) { reset(); signature = nextSignature }
    if (cachedAddon !== undefined) return cachedAddon
    let failure: NativeImageDiagnosticCode = 'addon_missing'
    for (const path of paths) {
      if (!existsSync(path)) continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const addon = require(path) as NativeAddon
        if (addon && typeof addon.decryptDatNative === 'function') { cachedAddon = addon; diagnostic = undefined; return addon }
        failure = 'api_missing'
      } catch { failure = 'addon_load_failed' }
    }
    cachedAddon = null
    return fail(failure)
  }
  return {
    reset,
    location: () => candidates().find(existsSync) || null,
    diagnostic: () => diagnostic,
    decrypt(inputPath: string, xorKey: number, aesKey?: string): NativeImageResult | null {
      const addon = load()
      if (!addon) return null
      try {
        const result = addon.decryptDatNative(inputPath, xorKey, aesKey)
        if (!result || !Buffer.isBuffer(result.data) || !result.data.length) return fail('invalid_result')
        const rawExt = typeof result.ext === 'string' ? result.ext.trim().toLowerCase() : ''
        diagnostic = undefined
        return { data: result.data, ext: rawExt ? (rawExt.startsWith('.') ? rawExt : '.' + rawExt) : '',
          isWxgf: Boolean(result.isWxgf ?? result.is_wxgf), meta: { version: result.version,
            aes_size: result.aes_size ?? result.aesSize, xor_size: result.xor_size ?? result.xorSize,
            raw_size: result.raw_size ?? result.rawSize, flag: result.flag } }
      } catch { return fail('decrypt_failed') }
    },
    encrypt(inputPath: string, xorKey: number, aesKey?: string, meta?: NativeDatMeta): Buffer | null {
      const addon = load()
      if (!addon?.encryptDatNative) return null
      try { const result = addon.encryptDatNative(inputPath, xorKey, aesKey, meta); return Buffer.isBuffer(result) ? result : null }
      catch { return null }
    },
  }
}
