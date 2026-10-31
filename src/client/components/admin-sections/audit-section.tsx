import { AuditPage } from '@/routes/audit'

export function AuditSection() {
  return <AuditPage />
}

export function PlatformAuditSection() {
  return <AuditPage scope="platform" />
}
