# Rollback Procedures

## Purpose

Roll back a failed deployment to the previous working state.

## Application Rollback

### Via Ansible (recommended)

```bash
cd deploy/ansible
ansible-playbook playbooks/rollback.yml \
  -i inventory.yml \
  -e "@vars.yml" \
  -e "rollback_to_image=ghcr.io/llamenos-hotline/llamenos-platform:<previous_tag>"
```

### Manual Docker rollback

```bash
ssh deploy@<server>

# Find previous image
docker images | grep llamenos

# Update compose to previous image and restart
cd /opt/llamenos/services/app
# Edit docker-compose.yml to set previous image tag
docker compose up -d

# Verify health
curl http://localhost:3000/api/health/ready
```

## Database Migration Rollback

If a deployment included a database migration that needs reverting:

```bash
ssh deploy@<server>

# Connect to database
docker exec -it $(docker ps -q -f name=postgres) psql -U llamenos

# Check current migration state
SELECT * FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 5;
```

Drizzle does not auto-generate down migrations. If rollback is needed:
1. Write a manual rollback SQL script
2. Test against a backup copy first
3. Apply to production

## Version Pinning

To prevent automatic updates via Watchtower, pin a specific image version:

```bash
ssh deploy@<server>
cd /opt/llamenos/services/app

# Edit docker-compose.yml: change image tag from :latest to :v1.2.3
docker compose up -d

# Disable Watchtower for this service (if running)
docker compose -f /opt/llamenos/services/watchtower/docker-compose.yml stop
```

## Verification After Rollback

```bash
# Health check
curl https://api.llamenos-hotline.org/api/health/ready

# Check running version
curl https://api.llamenos-hotline.org/api/health/ready | jq .version

# Check logs for errors
ssh deploy@<server> docker logs --tail 50 $(docker ps -q -f name=app)
```
