# Monitoring and Observability

The observability stack is deployed via `deploy/ansible/playbooks/observability.yml`. Two modes are available:

- **Full stack** — Prometheus, Grafana, Loki, Promtail, Alertmanager, Node Exporter
- **Healthcheck-only** — Lightweight HTTP health polling with ntfy push notifications (no Prometheus/Grafana)

## Prerequisites

- Ansible 2.15+ and the `community.docker` collection installed
- `deploy/ansible/inventory.yml` configured
- `observability_enabled: true` set in `deploy/ansible/vars.yml`

## Configuration

Edit `deploy/ansible/vars.yml` (copy from `vars.example.yml`):

```yaml
# ─── Observability ───────────────────────────────────────────────
observability_enabled: true

# Individual component toggles
prometheus_enabled: true
grafana_enabled: true
loki_enabled: true
alertmanager_enabled: true
node_exporter_enabled: true

# Set to true to skip Prometheus/Grafana/Loki and use simple health polling
healthcheck_only: false

# Grafana
grafana_admin_password: ""   # openssl rand -base64 24
grafana_allow_signup: false

# Prometheus retention
prometheus_retention: 15d
prometheus_retention_size: 5GB
prometheus_scrape_interval: 15s

# Loki log retention
loki_retention_period: 168h  # 7 days

# Alertmanager — push notifications via ntfy
alert_notification_method: ntfy
alert_ntfy_url: "https://ntfy.sh"
alert_ntfy_topic: "llamenos-alerts"
alert_ntfy_token: ""    # Optional auth token

# Healthcheck-only mode ntfy settings
healthcheck_ntfy_url: "https://ntfy.sh"
healthcheck_ntfy_topic: "llamenos-health"
```

## Deploy the Observability Stack

```bash
cd deploy/ansible
ansible-playbook playbooks/observability.yml --ask-vault-pass
```

Deploy a single component only:

```bash
ansible-playbook playbooks/observability.yml --ask-vault-pass --tags prometheus
ansible-playbook playbooks/observability.yml --ask-vault-pass --tags grafana
ansible-playbook playbooks/observability.yml --ask-vault-pass --tags loki
ansible-playbook playbooks/observability.yml --ask-vault-pass --tags alertmanager
ansible-playbook playbooks/observability.yml --ask-vault-pass --tags node-exporter
ansible-playbook playbooks/observability.yml --ask-vault-pass --tags healthcheck
```

## Accessing Services

After deployment, services are available at paths under your domain (proxied by Caddy):

| Service | URL |
|---------|-----|
| Grafana | `https://hotline.yourorg.org/grafana/` |
| Prometheus | `https://hotline.yourorg.org/prometheus/` |
| Alertmanager | `https://hotline.yourorg.org/alertmanager/` |

Log in to Grafana with username `admin` and the password from `grafana_admin_password`.

## Health Endpoints

The application exposes standard Kubernetes-compatible health probes:

```bash
# Liveness probe
curl -s http://localhost:3000/health/live

# Readiness probe
curl -s http://localhost:3000/health/ready

# Public health check (used for external uptime monitors)
curl -s https://hotline.yourorg.org/api/health
# Expected: {"status":"ok"}
```

A Prometheus `ServiceMonitor` is pre-configured. Metrics are scraped from the `/metrics` endpoint on the app container.

## Scheduler Worker Liveness (`WorkerStalled`)

The app runs background workers on timers: erasure expiry, retention purge, re-encryption, Signal queue drain, blast delivery, and others (`SCHEDULER_WORKER_NAMES` in `apps/worker/services/scheduler.ts`). If one of them stops, the app itself cannot notice. A check that runs inside a worker cannot report that worker being down. A stopped `erasure-expiry` worker would let a caller-erasure deadline pass with no record anywhere (#2323).

Liveness is therefore judged **out of process**, by Prometheus. For every worker, the app publishes two gauges on `/api/metrics/prometheus`:

| Metric | Meaning |
|--------|---------|
| `llamenos_worker_tick_interval_seconds{worker}` | How often the worker should tick. Published for every registered worker from process start. |
| `llamenos_worker_last_success_timestamp_seconds{worker}` | Unix time of the worker's last completed tick. **Absent until its first one.** |

The `WorkerStalled` alert (`deploy/ansible/roles/llamenos-prometheus/templates/alert-rules.yml.j2`) fires at `severity: critical`. Its `reason` label says which way it fired:

| `reason` | Fires when |
|----------|------------|
| `stale` | The last completed tick is older than 3 × the worker's interval, with a 10-minute minimum. |
| `never_succeeded` | The worker has completed no tick since the process started, for longer than that same threshold. This covers a worker that never started. |
| `no_liveness_metrics` | The app is up and scraped but publishes no worker-liveness data at all. |

No data is treated as a failure, never as healthy. While the app cannot be scraped, `WorkerStalled` stays silent and `AppDown` pages instead.

**What this cannot do.** The alert reaches **whoever operates the deployment**, through the Alertmanager receiver configured above. It does **not** tell hub members, volunteers or admins in the app. When the process or its scheduler is down, the app cannot tell anyone anything. Hub members learn about a stalled worker only if the operator tells them.

**The receiver is not in this repository.** `alert_notification_method` and its `alert_*` settings are filled at deploy time from the operator's OS keyvault and the private `llamenos-internal` repository. Do not commit a real endpoint, address or token for it, and do not put one in a GitHub Actions secret or variable.

**Liveness, not correctness.** "Completed a tick" means the worker's loop ran without throwing. A tick that catches and logs its own per-item failures still counts as alive. Those failures are tracked by the in-app incident layer, not by this alert.

**Triage:** the `worker` label names the worker. Search the app logs for that worker's logger namespace (for example `lib.erasure-expiry`). Restarting the app resets the gauges. The worker must then complete a tick within its threshold, or `never_succeeded` fires.

**Testing the rules:** `deploy/ansible/roles/llamenos-prometheus/tests/check-alert-rules.sh` renders the template and runs `promtool check rules` and `promtool test rules`, using the Prometheus image the role deploys. CI runs it in `ansible-validate`.

## Lightweight Mode (Healthcheck-Only)

For minimal deployments where a full Prometheus/Grafana stack is too heavy:

```yaml
# In vars.yml
observability_enabled: true
healthcheck_only: true
healthcheck_ntfy_url: "https://ntfy.sh"
healthcheck_ntfy_topic: "llamenos-health"
```

This deploys a simple poller that sends ntfy notifications when the health endpoint is non-200.

## External Uptime Monitoring

Regardless of which internal stack is used, configure an external uptime monitor (UptimeRobot, Healthchecks.io, BetterUptime, or similar) to ping:

```
https://hotline.yourorg.org/api/health
```

Alert on any non-200 response. This provides independent monitoring that is not affected by server-side issues.

## Log Access

With Loki + Promtail deployed, all Docker container logs are ingested and queryable in Grafana (Explore > Loki datasource). Useful LogQL queries:

```
{job="docker"} |= "ERROR"
{job="docker", container="llamenos-app"} | json
{job="docker", container="llamenos-postgres"} |= "FATAL"
```

Log retention defaults to 7 days (`loki_retention_period: 168h`). Adjust in `vars.yml`.

## See Also

- `deploy/ansible/playbooks/observability.yml` — full playbook
- `deploy/ansible/vars.example.yml` — all configurable observability options
- `docs/RUNBOOK.md` — alert triage and on-call procedures
- `docs/CAPACITY_PLANNING.md` — resource planning and scaling guidance
