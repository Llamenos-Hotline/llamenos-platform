/**
 * #2068 — the webhook URLs an admin is shown are the SERVER's, never assembled
 * in the webview.
 *
 * These panels used to render `${window.location.origin}/api/telephony/status`
 * and `${window.location.origin}/api/messaging/<channel>/webhook`. In the Tauri
 * desktop app that origin is the webview's, not the server's, and
 * `/api/telephony/status` was never mounted — so an admin who pasted the panel
 * into a provider configured a dead callback. They now render exactly what
 * `GET /provider-setup/webhook-urls` returns, and a failed load says so rather
 * than offering a guessed URL to copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { WebhookUrlsResponse } from '@protocol/schemas/provider-setup'

const getWebhookUrls = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/provider-setup', () => ({ getWebhookUrls }))

import { WebhookUrlField } from '../webhook-url-field'
import { VoiceWebhookConfirmation } from '../../setup/VoiceWebhookConfirmation'

const SERVER = 'https://hotline.example.org'
const TABLE: WebhookUrlsResponse = {
  voiceIncoming: `${SERVER}/api/telephony/incoming`,
  voiceStatus: `${SERVER}/api/telephony/call-status`,
  messaging: {
    sms: `${SERVER}/api/messaging/sms/webhook?hub=h1`,
    whatsapp: `${SERVER}/api/messaging/whatsapp/webhook?hub=h1`,
    signal: `${SERVER}/api/messaging/signal/webhook?hub=h1`,
    rcs: `${SERVER}/api/messaging/rcs/webhook?hub=h1`,
    telegram: `${SERVER}/api/messaging/telegram/webhook?hub=h1`,
  },
}

function renderWithQuery(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(createElement(QueryClientProvider, { client }, node))
}

describe('webhook URL panels show the server-built URLs — #2068', () => {
  beforeEach(() => {
    cleanup()
    getWebhookUrls.mockReset()
  })

  it('a messaging channel shows its URL from the server, not the webview origin', async () => {
    getWebhookUrls.mockResolvedValue(TABLE)
    renderWithQuery(createElement(WebhookUrlField, { channel: 'telegram', label: 'Webhook URL' }))

    const code = await screen.findByTestId('telegram-webhook-url')
    expect(code.textContent).toBe(TABLE.messaging.telegram)
    expect(code.textContent).not.toContain(window.location.origin)
  })

  it('a failed load shows an error and offers nothing to copy', async () => {
    getWebhookUrls.mockRejectedValue(new Error('Access denied'))
    renderWithQuery(createElement(WebhookUrlField, { channel: 'signal', label: 'Webhook URL' }))

    const error = await screen.findByTestId('signal-webhook-url-error')
    expect(error.textContent).toContain('Access denied')
    expect(screen.queryByTestId('signal-webhook-url')).toBeNull()
  })

  it('the voice panel shows the mounted call-status route, not /api/telephony/status', async () => {
    getWebhookUrls.mockResolvedValue(TABLE)
    renderWithQuery(createElement(VoiceWebhookConfirmation))

    await waitFor(() => expect(screen.getByTestId('webhook-confirmation')).toBeTruthy())
    const text = screen.getByTestId('webhook-confirmation').textContent ?? ''
    expect(text).toContain(TABLE.voiceIncoming)
    expect(text).toContain(TABLE.voiceStatus)
    expect(text).not.toContain('/api/telephony/status')
  })

  it('the voice panel reports a failed load instead of rendering URLs', async () => {
    getWebhookUrls.mockRejectedValue(new Error('boom'))
    renderWithQuery(createElement(VoiceWebhookConfirmation))

    expect((await screen.findByTestId('webhook-urls-error')).textContent).toContain('boom')
    expect(screen.queryByTestId('webhook-confirmation')).toBeNull()
  })
})
