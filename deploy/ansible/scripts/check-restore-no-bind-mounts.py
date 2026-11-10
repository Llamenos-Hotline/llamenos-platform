#!/usr/bin/env python3
"""Reject restore playbooks that hand decrypted data to a container through a
bind mount, or that empty a data volume in place.

Why this gate exists
--------------------
Two defects, one root cause, found by standing the stack up on a clean host and
running ``harden.yml`` first:

* ``harden.yml`` enables Docker's ``userns-remap``. The container's root is then
  an unprivileged sub-UID of the host, and it cannot traverse a ``0700`` host
  directory. ``restore.yml`` extracted the RustFS archive into such a directory
  and bind-mounted it into a helper container (``cp: can't stat '/in/.':
  Permission denied``); ``test-restore.yml`` did the same with the decrypted
  dump (``pg_restore: could not open input file ... Permission denied``, then a
  false "the backup is not restorable").
* The helper ran ``rm -rf /data/*`` BEFORE the copy that then failed, so the
  restore of a damaged host emptied the volume it was meant to refill.

The round trip in ``verify-backup-restore.sh`` runs on a daemon WITHOUT
userns-remap, so it cannot see the first, and the failure-injection cases it now
runs prove the second behaviourally. This is the cheap static half: it makes
the first impossible to reintroduce unnoticed, on any machine, with no Docker.

The rules (over ``playbooks/*.yml``)
------------------------------------
1. No ``docker ... -v/--volume/--mount`` whose source is a temp directory
   (a ``*tmpdir*`` / ``*tmp_dir*`` / ``/tmp`` path). Stream the data on stdin.
2. No ``rm -rf /data/<glob>`` (or ``rm -rf /data/..?*`` / ``/data/.[!.]*``)
   emptying a data volume in place. Stage the replacement on the same volume
   and swap it in; delete the old data last.

There is no allowlist: an allowlist is the hole a rail like this dies of.
"""
from __future__ import annotations

import pathlib
import re
import sys

PLAYBOOKS = pathlib.Path(__file__).resolve().parent.parent / "playbooks"

# `-v <src>:<dst>` / `--volume <src>:<dst>` / `--mount ...source=<src>` where the
# source is a templated temp path or a literal /tmp path.
TMP_SOURCE = r"""["']?(?:\{\{[^}]*(?:tmpdir|tmp_dir|tempdir|tempfile)[^}]*\}\}|/tmp/|\$\{?(?:TMPDIR|tmpdir|WORK|work)\b)"""
BIND_MOUNT_FROM_TMP = re.compile(
    r"(?:\s-v[ =]|\s--volume[ =]|\s--mount[ =][^\n]*?source=)" + TMP_SOURCE
)
EMPTY_DATA_VOLUME = re.compile(r"rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(?:-[a-zA-Z]+\s+)*[\"']?/data/(?:\*|\.\.\?\*|\.\[!\.\]\*)")


def main() -> int:
    failures: list[str] = []
    files = sorted(PLAYBOOKS.glob("*.yml"))
    if len(files) < 15:
        print(f"::error::found only {len(files)} playbooks under {PLAYBOOKS}; the glob is wrong", file=sys.stderr)
        return 2
    for path in files:
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            if BIND_MOUNT_FROM_TMP.search(line):
                failures.append(
                    f"{path.name}:{lineno}: bind-mounts a temp directory into a container. "
                    "Under userns-remap the container cannot read it. Stream the data on stdin."
                )
            if EMPTY_DATA_VOLUME.search(line):
                failures.append(
                    f"{path.name}:{lineno}: empties a data volume in place. "
                    "Stage the replacement on the same volume, verify it, swap it in, delete the old data last."
                )
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"OK: {len(files)} playbooks: no temp-directory bind mounts, no in-place volume wipes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
