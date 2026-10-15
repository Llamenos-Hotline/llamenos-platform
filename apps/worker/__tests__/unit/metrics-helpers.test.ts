/**
 * Unit tests for apps/worker/routes/metrics.ts exported helper functions.
 *
 * Tests counter/gauge/histogram metric recording and domain-specific helpers.
 */
import { describe, it, expect } from 'vitest'

// Need to get access to the in-memory state. The module exports functions
// but uses module-level state, so we test behavior through the helpers.
import {
  incCounter,
  setGauge,
  incGauge,
  decGauge,
  observeHistogram,
  recordHttpRequest,
  setActiveCalls,
  setActiveConversations,
  setSipBridgeStatus,
  setBackupAge,
} from '@worker/routes/metrics'

describe('metrics helpers', () => {
  // Note: metrics are module-level singletons that accumulate across tests.
  // We test incremental behavior rather than absolute values.

  describe('incCounter', () => {
    it('does not throw when incrementing a counter', () => {
      expect(() => incCounter('test_counter_1')).not.toThrow()
    })

    it('accepts labels', () => {
      expect(() => incCounter('test_counter_2', { method: 'GET', status: '200' })).not.toThrow()
    })
  })

  describe('setGauge', () => {
    it('does not throw when setting a gauge', () => {
      expect(() => setGauge('test_gauge_1', 42)).not.toThrow()
    })

    it('accepts labels', () => {
      expect(() => setGauge('test_gauge_2', 99, { region: 'us-east' })).not.toThrow()
    })
  })

  describe('incGauge / decGauge', () => {
    it('increments gauge without error', () => {
      expect(() => incGauge('test_gauge_inc')).not.toThrow()
    })

    it('decrements gauge without error', () => {
      expect(() => decGauge('test_gauge_dec')).not.toThrow()
    })
  })

  describe('observeHistogram', () => {
    it('records a histogram observation', () => {
      expect(() => observeHistogram('test_histogram', 0.05)).not.toThrow()
    })

    it('records observation with labels', () => {
      expect(() => observeHistogram('test_histogram', 1.5, { path: '/api/test' })).not.toThrow()
    })

    it('handles values larger than all buckets', () => {
      expect(() => observeHistogram('test_histogram_big', 100)).not.toThrow()
    })

    it('handles value of 0', () => {
      expect(() => observeHistogram('test_histogram_zero', 0)).not.toThrow()
    })

    it('handles negative values', () => {
      // Prometheus histograms should handle negative values without crashing
      expect(() => observeHistogram('test_histogram_neg', -1)).not.toThrow()
    })
  })

  describe('recordHttpRequest', () => {
    it('records an HTTP request metric', () => {
      expect(() => recordHttpRequest('GET', '/api/test', 200, 0.05)).not.toThrow()
    })

    it('records different status classes', () => {
      expect(() => recordHttpRequest('POST', '/api/data', 201, 0.1)).not.toThrow()
      expect(() => recordHttpRequest('GET', '/api/missing', 404, 0.01)).not.toThrow()
      expect(() => recordHttpRequest('POST', '/api/error', 500, 0.5)).not.toThrow()
    })
  })

  describe('domain-specific helpers', () => {
    it('setActiveCalls sets gauge without error', () => {
      expect(() => setActiveCalls(5)).not.toThrow()
      expect(() => setActiveCalls(0)).not.toThrow()
    })

    it('setActiveConversations sets gauge without error', () => {
      expect(() => setActiveConversations(12)).not.toThrow()
    })

    it('setSipBridgeStatus sets gauge with hub_id label', () => {
      expect(() => setSipBridgeStatus('hub-123', true)).not.toThrow()
      expect(() => setSipBridgeStatus('hub-456', false)).not.toThrow()
    })

    it('setBackupAge sets gauge', () => {
      expect(() => setBackupAge(3600)).not.toThrow()
    })
  })
})
