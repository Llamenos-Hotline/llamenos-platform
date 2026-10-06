# Placeholder mount point for an externally-managed SIP TLS certificate

This directory is intentionally almost empty. It is the **default source** of
the read-only bind mount that lands at `/etc/llamenos/sip-tls` inside the
`kamailio` and `asterisk` containers:

```yaml
- ${SIP_TLS_CERT_DIR:-./sip-tls-mount}:/etc/llamenos/sip-tls:ro
```

Compose needs *some* existing path there, so an unset `SIP_TLS_CERT_DIR`
mounts this directory and the services fall back to generating a self-signed
certificate — the default, zero-configuration behaviour.

To serve a real certificate instead (Let's Encrypt is the encouraged
production path), set `SIP_TLS_CERT_DIR` to the host directory holding it and
point `KAMAILIO_TLS_CERT_FILE` / `KAMAILIO_TLS_KEY_FILE` (and the `ASTERISK_`
equivalents, if Asterisk is your edge) at the files inside
`/etc/llamenos/sip-tls`.

The full recipe, including the renewal reload that Let's Encrypt makes
mandatory, is in `.env.example` under "Telephony: SIP TLS trust".

**Never commit a certificate or a private key here.**
