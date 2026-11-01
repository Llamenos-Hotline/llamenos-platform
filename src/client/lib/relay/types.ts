/**
 * Relay event types for the Llamenos WebSocket relay.
 */

/** Decrypted event content with type discriminator */
export interface LlamenosEvent {
  type: string
  [key: string]: unknown
}

/** Call ring notification */
export interface CallRingEvent extends LlamenosEvent {
  type: 'call:ring'
  callId: string
  startedAt: string
}

/** Call answered notification */
export interface CallAnsweredEvent extends LlamenosEvent {
  type: 'call:answered'
  callId: string
  volunteerPubkey: string
}

/** Call ended notification */
export interface CallEndedEvent extends LlamenosEvent {
  type: 'call:ended'
  callId: string
}

/** Call update (status change) */
export interface CallUpdateEvent extends LlamenosEvent {
  type: 'call:update'
  callId: string
  status: string
  answeredBy?: string
}

/** Voicemail notification */
export interface VoicemailEvent extends LlamenosEvent {
  type: 'voicemail:new'
  callId: string
  startedAt: string
}

/** Presence summary (all hub members) */
export interface PresenceSummaryEvent extends LlamenosEvent {
  type: 'presence:summary'
  hasAvailable: boolean
}

/** Presence detail (admins only) */
export interface PresenceDetailEvent extends LlamenosEvent {
  type: 'presence:detail'
  available: number
  onCall: number
  total: number
}

/** New conversation message */
export interface MessageNewEvent extends LlamenosEvent {
  type: 'message:new'
  conversationId: string
  channelType: string
}

/** Conversation assigned */
export interface ConversationAssignedEvent extends LlamenosEvent {
  type: 'conversation:assigned'
  conversationId: string
  assignedTo: string
}

/**
 * Envelopes were added to a conversation's messages for its assignee (#2046).
 * Rides `KIND_CONVERSATION_ASSIGNED`. The assignee's open thread re-reads its
 * messages so pre-claim messages become readable without a manual refresh.
 */
export interface ConversationEnvelopesAddedEvent extends LlamenosEvent {
  type: 'conversation:envelopes-added'
  conversationId: string
  assignedTo: string
  added: number
}

/** Conversation closed */
export interface ConversationClosedEvent extends LlamenosEvent {
  type: 'conversation:closed'
  conversationId: string
}

/** New conversation */
export interface ConversationNewEvent extends LlamenosEvent {
  type: 'conversation:new'
  conversationId: string
}

/** Message delivery status update */
export interface MessageStatusEvent extends LlamenosEvent {
  type: 'message:status'
  conversationId: string
  messageId: string
  status: string
}

/** Volunteer clocked in */
export interface ShiftClockInEvent extends LlamenosEvent {
  type: 'shift:clockIn'
  pubkey: string
}

/** Volunteer clocked out */
export interface ShiftClockOutEvent extends LlamenosEvent {
  type: 'shift:clockOut'
  pubkey: string
}

/** Shift override created */
export interface ShiftOverrideCreatedEvent extends LlamenosEvent {
  type: 'shift:overrideCreated'
  overrideId: string
}

/** Shift join/leave request received */
export interface ShiftRequestReceivedEvent extends LlamenosEvent {
  type: 'shift:requestReceived'
  requestId: string
  shiftId: string
  requestType: 'join' | 'leave'
}

/** Shift join/leave request reviewed */
export interface ShiftRequestReviewedEvent extends LlamenosEvent {
  type: 'shift:requestReviewed'
  requestId: string
  status: 'approved' | 'denied'
}

/** Relay connection state */
export type RelayState = 'disconnected' | 'connecting' | 'connected' | 'authenticating'

/** Event handler type — receives the decrypted event content */
export type RelayEventHandler = (kind: number, content: LlamenosEvent, hubId: string) => void
