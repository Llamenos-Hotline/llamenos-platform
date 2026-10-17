"""`url_userinfo`: percent-encode a value for the userinfo part of a URL.

Every credential this repo puts into a connection URL -- the worker's
DATABASE_URL, the postgres exporter's DATA_SOURCE_NAME -- goes through this
filter. A raw interpolation is wrong for any password that is not already
URL-safe, and the documented generator for those passwords
(`openssl rand -base64 24`) routinely yields `/` and `+`:

  postgresql://user:ab/cd+ef@postgres:5432/llamenos

postgres.js (the worker) cuts the authority at the first `/` or `?` before it
decodes anything, and Go's net/url (postgres_exporter) does the same, so the
host becomes `user:ab` and the connection fails. The exporter only logs that
and keeps serving `pg_up 0` -- nothing about the deploy goes red.

Why not the built-in `urlencode`: Ansible's and Jinja's `urlencode` filters
both call `quote(value, safe="/")`, i.e. they leave `/` -- the one character
that breaks userinfo worst -- untouched. Measured with ansible-core 2.20:
`'a/b+c' | urlencode` renders `a/b%2Bc`.

This encodes everything outside RFC 3986 "unreserved" (A-Z a-z 0-9 - . _ ~),
so the output alphabet is unreserved characters plus `%XX`. That alphabet is
also inert in a plain YAML scalar, a docker compose `$` interpolation and an
env_file line, so the encoded value needs no further quoting at any of the
layers a connection string passes through. Every consumer percent-decodes
userinfo (postgres.js and net/url both do), so the password the server sees
is byte-for-byte the configured one.
"""
from __future__ import annotations

from urllib.parse import quote


def url_userinfo(value: object) -> str:
    if value is None:
        raise ValueError("url_userinfo: refusing to encode None into a URL")
    return quote(str(value), safe="")


class FilterModule:
    def filters(self) -> dict:
        return {"url_userinfo": url_userinfo}
