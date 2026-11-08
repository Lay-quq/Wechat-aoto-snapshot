// Voice-file export is supported. Speech recognition/model downloads are not
// part of the public export-only edition.
export const voiceTranscribeService = {
  async getModelStatus() { return { success: true, exists: false, available: false, installed: false } },
  async downloadModel(_progress?: (value: unknown) => void) { return { success: false, error: '普通版不提供语音转写模型' } },
}
