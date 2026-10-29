# Self-Hosting Llamenos: Custom ISO with Full Disk Encryption

This guide walks you through building a custom Debian 13 installer ISO with
LUKS2 + LVM full disk encryption, uploading it to a VPS provider, and
handing off to the Ansible playbook for the rest of your Llamenos setup.

This is the recommended path for self-hosters who:

- Want their VPS provider to be unable to read disk contents
- Are comfortable opening a web console once during install
- Have a Linux/macOS workstation with Docker installed

## Why a custom ISO

Llamenos's threat model assumes well-funded adversaries — including the
VPS provider itself. Standard provider images give the provider full read
access to your disk via snapshots, decommissioned hardware, or hypervisor
attack. Building your own ISO with full disk encryption from the install
moment forward closes that gap.

A LUKS2-encrypted disk is unreadable to the provider while powered off,
and the LUKS unlock passphrase never lives on the disk. Combined with
dropbear-initramfs SSH unlock (the default), the passphrase doesn't even
travel through the provider's web console on every boot.

## Prerequisites

- **Docker** on your workstation. The builder runs in a pinned Debian
  container so you don't need any other tools installed.
- **An ed25519 SSH key.** If you don't have one:

  ```bash
  ssh-keygen -t ed25519 -C "$(whoami)@llamenos"
  ```

- **A VPS provider that accepts ISO uploads.** Tested providers:
  - 1984 Hosting (Iceland) — recommended; requires support ticket to attach ISO
  - Hetzner Cloud (rescue ISO upload)
  - OVH / Hetzner Robot dedicated servers
  - Any KVM-based VPS provider with a "boot from ISO" option

## Building the ISO

From a Llamenos checkout:

```bash
bun run build:iso \
  --hostname llamenos-01 \
  --ssh-key ~/.ssh/id_ed25519.pub
```

For VPS providers using paravirtualized disks (vda):

```bash
bun run build:iso \
  --hostname llamenos-01 \
  --ssh-key ~/.ssh/id_ed25519.pub \
  --disk /dev/vda
```

For static IP configuration (required for 1984 Hosting and other providers
that don't run DHCP during install):

```bash
bun run build:iso \
  --hostname llamenos-01 \
  --ssh-key ~/.ssh/id_ed25519.pub \
  --static-ip 203.0.113.10/24 \
  --gateway 203.0.113.1
```

(`203.0.113.0/24` is the RFC 5737 documentation range — substitute the address
and gateway your provider assigned.)

For console unlock instead of dropbear (if your network is unreliable):

```bash
bun run build:iso \
  --hostname llamenos-01 \
  --ssh-key ~/.ssh/id_ed25519.pub \
  --unlock console
```

The output ISO appears in `dist/iso/`:

```
dist/iso/debian13-fde-dropbear.iso       # ~500 MB
dist/iso/debian13-fde-dropbear.iso.sha256
```

### Verifying reproducibility (optional)

Llamenos ISOs are reproducible: building twice from the same source with
the same arguments must produce a byte-identical ISO. If you want to
verify this yourself:

```bash
./scripts/verify-iso.sh dist/iso/debian13-fde-dropbear.iso -- \
  --hostname llamenos-01 --ssh-key ~/.ssh/id_ed25519.pub
```

Expected output: `==> REPRODUCIBLE: SHAs match`.

## Choosing a provider

Before choosing a VPS provider, read the [deployment tier analysis in
THREAT_MODEL.md](../security/THREAT_MODEL.md#provider-jurisdiction-and-deployment-tiers).
Not every provider is suitable — FDE only works against a subset of adversaries,
and provider corporate jurisdiction matters at least as much as the datacenter
location.

The test is **strict**: a provider must have **zero US operations** — no US
datacenters, no US subsidiary, no US office, no US employees. A foreign parent
company with a US cloud subsidiary is still reachable through the US arm for
data stored anywhere in its network.

**Clean list** (single-jurisdiction, no US operations, verified 2026-04-12):

- **1984 Hosting** (Iceland) — strong jurisdictional posture; custom ISO via
  support ticket; FDE install verified on 2026-04-19.
- **Scaleway** (France) — EU-only datacenters, mature cloud product line, custom
  image support. Good candidate for managed deployments.
- **FlokiNET** (Iceland, Romania, Netherlands, Finland) — purpose-built for civil
  society and whistleblower projects, no ID required, accepts crypto.
- **Infomaniak** (Switzerland) — Swiss data protection law, more expensive.
- **Exoscale** (Switzerland, with additional EU datacenters) — Swiss parent.
- **Self-hosting** on operator-owned hardware — the highest-assurance option.

**Disqualified** (as of 2026-04-12 — verify before assuming current status):

- **US-headquartered:** AWS, GCP, Azure, Vultr, Linode (Akamai), DigitalOcean,
  Cloudflare paid products, Backblaze.
- **Foreign parent with US operations:** **Hetzner** (operates US cloud
  datacenters in Ashburn VA since 2021 and Hillsboro OR since 2023), **OVHcloud**
  (operates OVHcloud US LLC subsidiary with two US datacenters and ~200
  employees). Both are disqualified despite non-US headquarters because their
  US presence creates personal-jurisdiction hooks for US legal process.
- **Chinese clouds:** Alibaba Cloud, Tencent Cloud, Huawei Cloud, Baidu Cloud.
  China National Intelligence Law Art. 7 compels cooperation with PRC state
  intelligence. Alibaba additionally operates Santa Clara CA datacenters,
  creating dual jurisdictional exposure.

Stacking FDE on top of a disqualified host is a false sense of security — a
compelled hypervisor can capture the LUKS key from running VM memory. Pick a
provider that passes the strict test, then use FDE on top for defense in depth.

## Hosting the ISO for your provider to fetch

Most providers that support custom ISO installation take a URL rather than a
direct upload. You need to host the built ISO somewhere public before you start.

**ISO hosting threat model is not the same as app hosting threat model.** The
ISO is built from public source, fully reproducible, and its SHA-256 is
published alongside every release. A malicious host substituting a modified ISO
is detectable by any operator who verifies the hash (and the whole point of
reproducible builds is that you can rebuild from source and compare). This
means ISO hosting does **not** need to inherit the non-US-subject rule from
the app hosting deployment — US-subject S3 providers (Backblaze B2, etc.)
are acceptable for ISO distribution as long as the SHA-256 is published
out-of-band via GitHub Releases.

Llamenos's canonical ISO is published to each GitHub Release with its SHA-256.
Self-hosters are encouraged to either download from the release page and verify,
or to rebuild from source and compare (`scripts/verify-iso.sh`). Either path
ensures the host cannot tamper with the ISO you install.

For your own throwaway testing, any publicly reachable HTTPS URL works. Scaleway
Object Storage, S3, or even a short-lived GitHub Release asset are all fine.

## 1984 Hosting (Iceland) — recommended

1984 Hosting (Iceland) is excellent for Llamenos deployments on jurisdictional
grounds. Iceland has strong journalist-source protections and is outside the
EU/US/UK surveillance frameworks.

1984 does not expose custom ISO upload in their web panel, but **support will
attach a custom ISO if you provide a URL**. FDE install on 1984 was verified on
2026-04-19 using this path.

### Required build parameters for 1984

**1984 uses static IP — you must pass `--static-ip` or the installer hangs.**
The preseed defaults to DHCP, which 1984 does not provide during install. The
install will stop silently at "Configure the network" with no auto-recovery.

Get your IP, netmask/CIDR, and gateway from the 1984 control panel. The disk
device on 1984 KVM is `/dev/vda`.

```bash
# Replace with your 1984-assigned values
bun run build:iso \
  --hostname llamenos-01 \
  --ssh-key ~/.ssh/id_ed25519.pub \
  --disk /dev/vda \
  --static-ip <YOUR-IP>/24 \
  --gateway <YOUR-GATEWAY>
```

### 1984 install workflow

1. Build the ISO with your 1984 static IP params (see above).

2. Host the ISO at a publicly accessible HTTPS URL (see *Hosting the ISO* above).

3. Email or open a ticket with 1984 support:

   - Subject: **Please attach custom ISO to my VPS**
   - Body: your VPS ID, the public HTTPS URL of your ISO, and its SHA-256 from
     `debian13-fde-dropbear.iso.sha256`

   They typically respond within a business day (Iceland business hours, GMT).

4. When support confirms the ISO is attached, log into the 1984 panel and
   boot/reboot the VPS from the ISO.

5. Open the noVNC console in the 1984 panel. The installer boot menu appears
   automatically with a single entry, `Install Debian 13 (LUKS full-disk
   encryption)`. Wait for the auto-select (or press Enter immediately). The ISO
   volume label is `debian13-fde`; neither string names this project, by design —
   the hosting provider can read both.

6. After about a minute, the installer asks for the LUKS encryption passphrase.
   Type a strong passphrase (30+ chars, 5+ random words). Confirm.

7. Wait ~5–10 minutes for the install to complete and auto-reboot.

8. After reboot, detach the ISO in the 1984 panel so it boots from disk on
   future reboots.

9. Continue to [Subsequent boots — dropbear unlock](#subsequent-boots--dropbear-unlock-default) below.

## Hetzner Cloud (Path A and B)

Hetzner Cloud has German jurisdiction but has US datacenters — see *Choosing a
provider* above. Listed here because the install workflows are well-documented
and the qemu rescue path (Path B) applies anywhere that provides rescue access.

### Path A: Support-ticket ISO attach

1. Build the ISO (Hetzner Cloud uses `--disk /dev/sda` by default):

   ```bash
   bun run build:iso \
     --hostname llamenos-01 \
     --ssh-key ~/.ssh/id_ed25519.pub
   ```

2. Host the ISO at a publicly accessible HTTPS URL.

3. Open a Hetzner support ticket → request custom ISO attach with URL + SHA-256.

4. Once the ISO appears in your account, create a server, mount the ISO,
   reset it, and type the LUKS passphrase in the noVNC console.

5. Unmount the ISO after reboot.

### Path B: Rescue-mode qemu install (no support ticket)

This path uses Hetzner's Rescue System to run the Llamenos installer inside
`qemu-system-x86_64` with the VM's real disk passed through as the target.

```bash
# In Hetzner rescue system
apt-get update && apt-get install -y qemu-system-x86 qemu-utils
wget -O /tmp/llamenos.iso https://<your-iso-host>/debian13-fde-dropbear.iso
echo "<expected-sha256>  /tmp/llamenos.iso" | sha256sum -c -

qemu-system-x86_64 \
  -enable-kvm -cpu host -m 4096 -smp 2 \
  -drive file=/dev/sda,format=raw,if=virtio,cache=none \
  -cdrom /tmp/llamenos.iso -boot d \
  -netdev user,id=n0 -device virtio-net-pci,netdev=n0 \
  -vnc 127.0.0.1:1 -daemonize
```

SSH with VNC tunnel first: `ssh -L 5901:127.0.0.1:5901 root@<server-ip>`.
Connect VNC client to `localhost:5901`.

### OVHcloud / Scaleway (direct custom ISO upload)

Both support self-service custom ISO uploads. Consult their current docs;
the workflow is: upload ISO, attach to instance, boot from it, type LUKS
passphrase at the console.

### Self-hosting on your own hardware

The highest-assurance deployment. Write the ISO to a USB stick with `dd`,
boot the target machine from it, and continue from "Subsequent boots" below.

## First boot — installer (one-time)

The installer is fully unattended **except** for one step: setting the LUKS
passphrase. This is the only thing the operator types during install.

1. Open your provider's web console (VNC or serial)
2. Watch the Debian installer start automatically
3. After about a minute, the installer asks for the LUKS encryption passphrase
4. **Type a strong passphrase** (use a passphrase manager — at least 30
   characters, 5+ random words)
5. Confirm the passphrase
6. The install completes (5–10 minutes) and reboots automatically

> **Forgetting the passphrase means rebuilding from scratch.** Llamenos has
> no recovery mechanism for forgotten LUKS passphrases. This is by design.

## Subsequent boots — dropbear unlock (default)

After install, every boot pauses in the initramfs waiting for an SSH
connection. Unlock from your laptop:

```bash
ssh -p 2222 -i ~/.ssh/id_ed25519 root@<vps-ip>
```

You'll be prompted for the LUKS passphrase. Type it; the connection closes
immediately and the VPS continues booting.

> **Why a separate port?** Dropbear runs on 2222 to avoid clashing with
> the post-install sshd on port 22. Their host keys are different — your
> SSH client will warn the first time. That's expected.

After the VPS finishes booting (~30 seconds), you can log in normally:

```bash
ssh deploy@<vps-ip>
```

You'll see the welcome banner with next-step instructions.

## Subsequent boots — console unlock (if you built with `--unlock console`)

1. Open your provider's web console
2. The standard `cryptsetup` prompt appears on TTY1
3. Type the LUKS passphrase
4. Boot continues

## Hand-off to Ansible

From your workstation, with the Llamenos checkout still open, follow
[`first-deploy.md`](first-deploy.md) from step 3 (DNS) onward. In short:
DNS records → `inventory-production.yml` + `vars-production.yml` →
`playbooks/preflight.yml` → `playbooks/harden.yml` → update `ansible_port` →
`playbooks/deploy.yml` → `playbooks/smoke-check.yml`. See
`deploy/ansible/vars-production.example.yml` for every value you must supply.

> Do not run `ansible-playbook setup.yml -i '<ip>,'` (an older version of this
> section, and the installed motd, suggested it): an ad-hoc `<ip>,` inventory
> puts the host in no group, so the deploy plays match nothing and skip, and it
> carries none of the required variables.

## Troubleshooting

**Installer hangs at "Configure the network"**

The provider does not run DHCP during install. Rebuild with
`--static-ip <CIDR> --gateway <ip>`. This is required for 1984 Hosting
and any provider that assigns static IPs.

**Dropbear doesn't start (no port 2222 response after reboot)**

Most likely the network config is wrong. Either:

- The provider doesn't run DHCP in their network — rebuild with
  `--static-ip <CIDR> --gateway <ip>`
- The interface isn't detected correctly — very rare since the ISO now
  uses auto-detection (empty `<iface>` field in klibc IP= syntax)

**SSH host key warning when connecting on port 2222 vs port 22**

Expected — they're different SSH servers (dropbear in initramfs vs sshd in
the live system). Add both with separate aliases in `~/.ssh/config`:

```ssh-config
Host llamenos-unlock
  HostName <vps-ip>
  Port 2222
  User root
  UserKnownHostsFile ~/.ssh/known_hosts.dropbear

Host llamenos
  HostName <vps-ip>
  Port 22
  User deploy
```

**sudo prompts for a password that doesn't work**

This should not happen with ISOs built from current sources — the deploy
user gets a NOPASSWD sudoers entry during install. If you have an older ISO,
rebuild it.

**I forgot the LUKS passphrase**

Rebuild from scratch. There is no recovery.

**Build fails with GPG verification error**

Either your network has tampered with the upstream Debian ISO download,
or the Debian signing key has rotated and the builder needs an update.
Check `docs/superpowers/specs/2026-04-09-fde-iso-builder-design.md` and
file an issue.

**Disk shows up as `/dev/vda` not `/dev/sda` and install fails**

Rebuild with `--disk /dev/vda`. Required for 1984 Hosting and most KVM providers.

## What this defends against (and what it doesn't)

**Defends against:**

- VPS provider reading your disk via snapshots or decommissioned hardware
- Disk image theft from the provider
- Keystroke capture on the VPS web console (dropbear mode only)
- Tampered upstream Debian ISO downloads (GPG-verified during build)

**Does NOT defend against:**

- A provider with hypervisor access dumping guest RAM at runtime
- Cold boot attacks against the VPS hardware (out of your control)
- Compromise of your workstation where you build the ISO
- Forgetting your LUKS passphrase

For the full threat model, see
[`docs/superpowers/specs/2026-04-09-fde-iso-builder-design.md`](../superpowers/specs/2026-04-09-fde-iso-builder-design.md).
