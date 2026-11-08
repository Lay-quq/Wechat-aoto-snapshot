import { join } from 'node:path'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ConfigService } from './config'
import { wcdbService } from './wcdb'
import { imageDecryptService } from '../services/imageDecryptService'
import { decodeMessageContent } from '../services/export/parsers/contentDecoder'
import { sanitizeQuotedContent } from '../services/export/parsers/quoteParser'

let runtime: any = {}
const safeFetch = async (value: string): Promise<Buffer> => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/(?:^|\.)(?:qq\.com|qpic\.cn|qlogo\.cn)$/i.test(url.hostname)) throw Error('媒体地址不可用')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) })
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 32 * 1024 * 1024) throw Error('媒体读取失败')
  const reader = response.body?.getReader(); if (!reader) throw Error('媒体为空')
  const blocks: Buffer[] = []; let size = 0
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 32 * 1024 * 1024) { await reader.cancel(); throw Error('媒体过大') }; blocks.push(Buffer.from(next.value)) }
  return Buffer.concat(blocks)
}
function wav(pcm: Buffer): Buffer {
  const result = Buffer.alloc(44); result.write('RIFF'); result.writeUInt32LE(36 + pcm.length, 4); result.write('WAVE', 8); result.write('fmt ', 12)
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(24000, 24); result.writeUInt32LE(48000, 28)
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([result, pcm])
}
export const chatService: any = {
  decodeMessageContent,
  sanitizeQuotedContent,
  setRuntimeConfig(value: any) { runtime = value || {} },
  async getSessions() { return wcdbService.getSessions() },
  async getContactAvatar(username: string) {
    const result = await wcdbService.getAvatarUrls([username])
    const url = result?.map?.[username]
    if (typeof url !== 'string' || !url) return { success: false }
    if (url.startsWith('data:image/')) return { success: true, avatarUrl: url, data: url }
    try { const data = await safeFetch(url); const image = 'data:image/jpeg;base64,' + data.toString('base64'); return { success: true, avatarUrl: image, data: image } } catch { return { success: false } }
  },
  async getImageData(sessionId: string, _id: string, _time?: number, md5?: string, datName?: string) {
    if (!md5) { const found = await wcdbService.getMessageById(sessionId, Number(_id)); const row = found.message; if (row) md5 = /\bmd5=["']([a-f0-9]{32})["']/i.exec(decodeMessageContent(row.message_content, row.compress_content))?.[1] }
    const result = await imageDecryptService.decryptImage({ sessionId, imageMd5: md5 || '', imageDatName: datName, preferFilePath: true } as any)
    if (!result.success || !result.localPath) return { success: false }
    const file = result.localPath.startsWith('file:') ? fileURLToPath(result.localPath) : result.localPath
    if (!existsSync(file)) return { success: false }
    return { success: true, data: readFileSync(file).toString('base64'), localPath: file }
  },
  async getVoiceData(sessionId: string, id: string, createTime?: number, serverId?: string | number, sender?: string) {
    const result = await wcdbService.getVoiceData(sessionId, createTime || 0, [sender, runtime.myAccountId, sessionId].filter(Boolean), Number(id) || 0, serverId || 0)
    if (!result.success || !result.hex) return { success: false, error: '本地语音文件不可用' }
    try {
      const silk = require('silk-wasm'), decoded = await silk.decode(Buffer.from(result.hex, 'hex'), 24000)
      const pcm = Buffer.from(decoded.data || decoded)
      return { success: true, data: wav(pcm).toString('base64') }
    } catch { return { success: false, error: '本地语音解码失败' } }
  },
  async preloadVoiceDataBatch() { return { success: true } },
  async getVoiceTranscript() { return { success: false, error: '普通版仅导出原语音文件，不进行模型转写' } },
  getCachedVoiceTranscriptCountMap() { return {} },
  hasTranscriptCache() { return false },
  async getExportSessionStats(sessionIds: string[]) {
    const ids = [...new Set(sessionIds)], result = await wcdbService.getSessionMessageTypeStatsBatch(ids, { includeGroupSenderCount: false })
    const data = result.data
    if (!result.success || !data || ids.some(id => !data[id])) return { success: false, error: '汇总不可用，请按消息游标统计' }
    const count = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0
    return { success: true, data: Object.fromEntries(ids.map(id => { const row = data[id]; return [id, {
      totalMessages: count(row.total_messages), voiceMessages: count(row.voice_messages), imageMessages: count(row.image_messages),
      videoMessages: count(row.video_messages), emojiMessages: count(row.emoji_messages), lastTimestamp: count(row.last_timestamp),
    }] })) }
  },
  async downloadEmoji(url: string) { const localPath = await chatService.downloadEmojiFile({ emojiCdnUrl: url }); return { success: !!localPath, localPath } },
  async downloadEmojiFile(message: any) {
    const url = String(message?.emojiCdnUrl || '')
    try { const directory = join(new ConfigService().getCacheBasePath(), 'standard-emojis'); mkdirSync(directory, { recursive: true });
      const file = join(directory, createHash('sha256').update(url).digest('hex') + '.gif'); if (!existsSync(file)) writeFileSync(file, await safeFetch(url)); return file } catch { return null }
  },
}
