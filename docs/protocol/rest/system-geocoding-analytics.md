# Llamenos Protocol: REST API: system health, geocoding and analytics

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.34 System Health

Aggregated system health dashboard for admins.

```
GET /api/system/health
Permission: system:manage-instance
Response: SystemHealth { server, services, calls, storage, backup, users, timestamp }
```

### 4.35 Geocoding

Address autocomplete and geocoding (rate-limited per user).

```
POST /api/geocoding/autocomplete
Permission: notes:read-own
Body: { "query": string, "limit"?: number }
Response: LocationResult[]
Rate limit: 60/min per user

POST /api/geocoding/geocode
Permission: notes:read-own
Body: { "address": string }
Response: LocationResult | null
Rate limit: 20/min per user

POST /api/geocoding/reverse
Permission: notes:read-own
Body: { "lat": number, "lon": number }
Response: LocationResult | null
Rate limit: 20/min per user
```

### 4.36 Analytics

Admin dashboard metrics. Available at both global (`/api/analytics/*`) and hub-scoped (`/api/hubs/:hubId/analytics/*`). Platform-scoped access requires super-admin.

```
GET /api/analytics/calls
Permission: audit:read
Query: ?from=ISO8601&to=ISO8601
Response: CallMetrics

GET /api/analytics/conversations
Permission: audit:read
Query: ?from=ISO8601&to=ISO8601
Response: ConversationMetrics

GET /api/analytics/shifts
Permission: audit:read
Response: ShiftMetrics

GET /api/analytics/health
Permission: audit:read
Response: AnalyticsSystemHealth

GET /api/analytics/hours
Permission: audit:read
Query: ?from=ISO8601&to=ISO8601
Response: HourlyDistribution

GET /api/analytics/users
Permission: audit:read
Query: ?from=ISO8601&to=ISO8601
Response: UserStats

GET /api/analytics/me
Auth: Required (any role)
Query: ?from=ISO8601&to=ISO8601
Response: PersonalStats
```

