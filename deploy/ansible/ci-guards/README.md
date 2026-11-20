# Ansible CI guards

Every `*.toml` here is one guard run by the single "Run ansible guards" step of
the `ansible-validate` job in `.github/workflows/ci.yml`, via
`deploy/ansible/scripts/run-ci-guards.py`.

To add a guard, **add a file** — do not add a step to `ci.yml` (#2645: appending
at one anchor in that list made every concurrent deploy PR conflict with the
last).

```toml
name = "Check X cannot happen"                          # required, unique; shown in the log and failure summary
run  = "python3 deploy/ansible/scripts/check-x.py"      # required; bash, cwd = repo root, non-zero exit = fail
why  = "The incident this guard prevents."              # optional
```

Name the file for the guard, not a number. Use `'''…'''` for multi-line `run`
bodies. Each guard gets its own log group and an `::error` annotation naming it,
and all guards run even after one fails. Scripts that need extra tooling beyond
what the job installs (ansible, ansible-lint, Python 3.12, Docker) do not belong
here. Run locally from the repo root: `python3 deploy/ansible/scripts/run-ci-guards.py`.
