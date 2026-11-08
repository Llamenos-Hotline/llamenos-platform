# MOVED — this file is not read by anything

The prompt this file used to hold is now assembled by `_assemble_standard()` in
`dispatch-one.sh`. Edit it **there**.

This file was a trap: no script ever read it (`grep -rn prompt-template` returned
zero hits across the whole skill), so the two most expensive worker rules ever
written — "no subagents" and "never background a `git commit`" — lived here and
shipped in nothing from 2026-08-02 until 2026-08-30. They are inlined in all three
assemblers now. Do not restore prose here; it can only diverge again.
