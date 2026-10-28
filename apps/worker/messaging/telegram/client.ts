/**
 * TelegramBotClient — HTTP client for the Telegram Bot API.
 *
 * All methods correspond to Telegram Bot API methods:
 * https://core.telegram.org/bots/api
 *
 * Methods POST JSON to `https://api.telegram.org/bot{token}/{method}`.
 */
import { safeFetch } from '../../lib/safe-fetch'
import type {
  TelegramFile,
  TelegramGetFileResponse,
  TelegramGetMeResponse,
  TelegramMessage,
  TelegramSendMessageResponse,
  TelegramUser,
} from './types'

export class TelegramBotClient {
  private readonly baseUrl: string

  constructor(private readonly botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`
  }

  /**
   * Send a text message to a chat.
   * https://core.telegram.org/bots/api#sendmessage
   */
  async sendMessage(
    chatId: number | string,
    text: string,
  ): Promise<{ ok: boolean; result?: TelegramMessage; error?: string }> {
    const res = await safeFetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })

    const data = await res.json() as TelegramSendMessageResponse
    if (!data.ok) {
      return { ok: false, error: data.description ?? `HTTP ${res.status}` }
    }
    return { ok: true, result: data.result }
  }

  /**
   * Send a photo to a chat.
   * https://core.telegram.org/bots/api#sendphoto
   *
   * @param photo - File ID, HTTP URL, or upload (only URL/file_id supported here)
   */
  async sendPhoto(
    chatId: number | string,
    photo: string,
    caption?: string,
  ): Promise<{ ok: boolean; result?: TelegramMessage; error?: string }> {
    const body: Record<string, unknown> = { chat_id: chatId, photo }
    if (caption) body.caption = caption

    const res = await safeFetch(`${this.baseUrl}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await res.json() as TelegramSendMessageResponse
    if (!data.ok) {
      return { ok: false, error: data.description ?? `HTTP ${res.status}` }
    }
    return { ok: true, result: data.result }
  }

  /**
   * Send a voice message to a chat.
   * https://core.telegram.org/bots/api#sendvoice
   *
   * @param voiceUrl - HTTP URL to an OGG file encoded with OPUS
   */
  async sendVoice(
    chatId: number | string,
    voiceUrl: string,
  ): Promise<{ ok: boolean; result?: TelegramMessage; error?: string }> {
    const res = await safeFetch(`${this.baseUrl}/sendVoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, voice: voiceUrl }),
    })

    const data = await res.json() as TelegramSendMessageResponse
    if (!data.ok) {
      return { ok: false, error: data.description ?? `HTTP ${res.status}` }
    }
    return { ok: true, result: data.result }
  }

  /**
   * Send a document (general file) to a chat.
   * https://core.telegram.org/bots/api#senddocument
   */
  async sendDocument(
    chatId: number | string,
    documentUrl: string,
    caption?: string,
  ): Promise<{ ok: boolean; result?: TelegramMessage; error?: string }> {
    const body: Record<string, unknown> = { chat_id: chatId, document: documentUrl }
    if (caption) body.caption = caption

    const res = await safeFetch(`${this.baseUrl}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await res.json() as TelegramSendMessageResponse
    if (!data.ok) {
      return { ok: false, error: data.description ?? `HTTP ${res.status}` }
    }
    return { ok: true, result: data.result }
  }

  /**
   * Verify the bot token and get bot info.
   * https://core.telegram.org/bots/api#getme
   */
  async getMe(): Promise<{ ok: boolean; result?: TelegramUser; error?: string }> {
    const res = await safeFetch(`${this.baseUrl}/getMe`, {
      method: 'GET',
    })

    const data = await res.json() as TelegramGetMeResponse
    if (!data.ok) {
      return { ok: false, error: data.description ?? `HTTP ${res.status}` }
    }
    return { ok: true, result: data.result }
  }

  /**
   * Register a webhook URL with Telegram.
   * https://core.telegram.org/bots/api#setwebhook
   *
   * @param url - HTTPS URL to send updates to
   * @param secret - Secret token for X-Telegram-Bot-Api-Secret-Token header verification.
   *   Required: a webhook registered without one is never authenticated by Telegram's header.
   */
  async setWebhook(url: string, secret: string): Promise<{ ok: boolean; error?: string }> {
    const body: Record<string, unknown> = { url, secret_token: secret }

    const res = await safeFetch(`${this.baseUrl}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = (await res.json()) as { ok: boolean; description?: string }
    if (!data.ok) {
      return { ok: false, error: data.description ?? `HTTP ${res.status}` }
    }
    return { ok: true }
  }

  /**
   * Get file info for downloading.
   * https://core.telegram.org/bots/api#getfile
   *
   * After getting the file_path, download from:
   * https://api.telegram.org/file/bot{token}/{file_path}
   */
  async getFile(fileId: string): Promise<{ ok: boolean; result?: TelegramFile; error?: string }> {
    const res = await safeFetch(`${this.baseUrl}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    })

    const data = await res.json() as TelegramGetFileResponse
    if (!data.ok) {
      return { ok: false, error: data.description ?? `HTTP ${res.status}` }
    }
    return { ok: true, result: data.result }
  }

  /**
   * Download file content by file_path.
   * Uses the Telegram file download endpoint:
   * https://api.telegram.org/file/bot{token}/{file_path}
   */
  async downloadFile(filePath: string): Promise<ArrayBuffer> {
    const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`
    const res = await safeFetch(url, { timeoutMs: 60_000 })
    if (!res.ok) {
      throw new Error(`Failed to download Telegram file: HTTP ${res.status}`)
    }
    return res.arrayBuffer()
  }
}
