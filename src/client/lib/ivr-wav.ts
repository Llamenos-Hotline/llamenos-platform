/**
 * IVR prompts are played by the telephony provider, not the browser, so they
 * are uploaded in the one format every provider plays: 8 kHz mono 16-bit PCM
 * WAV. The server rejects anything else (`ivrAudioFormatError` in
 * apps/worker/lib/helpers.ts) — a browser recording is WebM/Opus or MP4/AAC,
 * which Asterisk and Twilio download and then play as silence.
 */

export const IVR_WAV_SAMPLE_RATE = 8000

/** Encode mono samples in [-1, 1] as 16-bit PCM WAV */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2
  const wav = new Uint8Array(44 + dataBytes)
  const view = new DataView(wav.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return wav
}

/** Average an AudioBuffer's channels into one */
function downmix(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0)
  const mono = new Float32Array(buffer.length)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels
  }
  return mono
}

/**
 * Convert any audio the browser can decode (a MediaRecorder recording, an
 * uploaded file) to an IVR prompt WAV. decodeAudioData resamples to its
 * context's rate, so decoding in an 8 kHz context does the resampling.
 */
export async function toIvrPromptWav(audio: Blob): Promise<Blob> {
  const context = new OfflineAudioContext(1, 1, IVR_WAV_SAMPLE_RATE)
  const decoded = await context.decodeAudioData(await audio.arrayBuffer())
  const wav = encodePcm16Wav(downmix(decoded), IVR_WAV_SAMPLE_RATE)
  return new Blob([wav], { type: 'audio/wav' })
}
