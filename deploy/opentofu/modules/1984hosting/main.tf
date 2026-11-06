# Hand-provisioned VPS module (worked example: 1984 Hosting, Iceland)
#
# THIS MODULE AUTOMATES NOTHING. 1984 Hosting has no Terraform/OpenTofu provider;
# the VPS is ordered by hand and this module only records the address you were
# given and emits an Ansible inventory from it. It exists so the root module can
# treat "a VPS someone ordered by hand" like any other provider. The steps below
# are provider-neutral — they apply to any host that meets the two hard
# requirements — with 1984 as the worked (and verified) example.
#
# The complete, command-by-command procedure lives in
#   docs/deployment/first-deploy.md   (order → FDE install → harden → deploy)
#   docs/deployment/iso-install.md    (building and installing the FDE ISO)
# Keep this file as a summary; if it disagrees with those, they win.
#
# ── Hard requirements when choosing a host (both are security properties) ──
#
#   (a) CUSTOM ISO BOOT + REMOTE CONSOLE (VNC/iKVM/noVNC).
#       This is what makes full-disk encryption with remote LUKS unlock
#       possible: you boot the project's own installer ISO, set the LUKS
#       passphrase at the console, and afterwards unlock over SSH (dropbear).
#       A host that offers only its own images (or no console) cannot do this,
#       and FDE-with-remote-unlock does not transfer to it.
#       1984: custom ISO is attached by SUPPORT on request (URL + SHA-256 in a
#       ticket), console is noVNC — verified 2026-04-19. The panel has no ISO
#       upload of its own.
#
#   (b) TLS TERMINATES ON OUR OWN BOX, with a Let's Encrypt (ISRG-chained)
#       certificate. The Android client pins ISRG Root X1/X2/YR/YE with HARD FAIL
#       (apps/android/app/src/main/res/xml/network_security_config.xml). A CDN,
#       reverse-proxy product or "managed TLS" in front of the VPS presents a
#       different chain and breaks Android connectivity entirely. Do not proxy
#       (orange-cloud) these DNS records.
#
#   Also required by policy: provider jurisdiction must pass the strict test in
#   docs/deployment/iso-install.md ("Choosing a provider"; zero US operations).
#
#   OPEN QUESTION (unverified): FlokiNET is on the jurisdiction "clean list" but
#   nobody has confirmed that it offers custom-ISO boot AND a remote console.
#   If it does not, FDE with remote unlock is not achievable there. Verify
#   before ordering; do not assume.
#
# ── Steps ──
#
#   1. Order a VPS (Debian 13 is what the installer ISO installs; the image you
#      order is replaced by the ISO install, so the chosen OS does not matter).
#      Sizing: >= 2 vCPU, 4 GB RAM, 40 GB disk (docs/runbooks/deploy-self-hosted.md).
#   2. Note the assigned IPv4 (and IPv6) address, netmask/CIDR and gateway, and
#      the disk device (1984 KVM: /dev/vda). Feed the IPv4 to this module as
#      var.server_ip.
#   3. Build the FDE ISO. 1984 does not run DHCP during install, so --static-ip
#      and --gateway are REQUIRED or the installer hangs at "Configure the network":
#        bun run build:iso --hostname <host> --ssh-key ~/.ssh/<key>.pub \
#          --disk /dev/vda --static-ip <ipv4>/<prefix> --gateway <gw>
#   4. Host the ISO at a public HTTPS URL, open a support ticket asking for it to
#      be attached (URL + SHA-256), boot the VPS from it, open the console and
#      type the LUKS passphrase when asked (30+ chars; there is NO recovery).
#   5. After the install reboots, detach the ISO. Every boot then waits in the
#      initramfs for an SSH unlock:
#        ssh -p 2222 -i ~/.ssh/<key> root@<ip>
#      (login user is root, not deploy: dropbear runs one forced command,
#      cryptroot-unlock, then the connection closes and the box boots.)
#   6. Create the DNS records below, then continue with docs/deployment/first-deploy.md
#      (harden → deploy → smoke-check).
#
# ── DNS records ──
#
# 1984 provides authoritative DNS (control panel → Domains → DNS), which is why
# it can host the zone itself. Records must be DNS-only (no proxying) and must
# exist BEFORE the deploy: Caddy obtains certificates by ACME on first start and
# preflight's DNS validation fails the run if a name does not resolve here.
#
#   Type | Name                | Value           | Notes
#   A    | api.<domain>        | <server_ipv4>   | app + API + WebSocket + webhooks
#   A    | <domain> (apex)     | <server_ipv4>   | redirects to api.<domain>
#   A    | updates.<domain>    | <server_ipv4>   | desktop updater manifest
#   A    | releases.<domain>   | <server_ipv4>   | desktop updater artifacts
#   A    | push.<domain>       | <server_ipv4>   | ntfy/UnifiedPush (Android push)
#   AAAA | same names          | <server_ipv6>   | only if the VPS has IPv6
#
# Migrating an existing zone: docs/runbooks/dns-migration.md.

locals {
  # These values must be filled in manually after provisioning
  server_ip   = var.server_ip
  server_name = var.server_name
  domain      = var.domain
}
