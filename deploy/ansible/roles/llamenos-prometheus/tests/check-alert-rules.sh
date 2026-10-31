#!/usr/bin/env bash
# Validate and unit-test the Prometheus alert rules this role deploys.
#
#   1. Render templates/alert-rules.yml.j2 with Jinja2 (StrictUndefined, so a
#      template that starts depending on a variable fails here loudly rather
#      than rendering a hole), exactly as the role's `template` task would.
#      The ONLY variables supplied are defaults/main.yml's: a fresh checkout
#      deploys exactly what is tested here, so a variable a rule needs that has
#      no default fails this script instead of silently rendering nothing.
#   2. `promtool check rules` on the rendered file.
#   3. `promtool test rules` with tests/alert-rules.test.yml.
#
# promtool comes from the SAME prom/prometheus image the role deploys
# (prometheus_image in defaults/main.yml), so the PromQL is judged by the
# version that will evaluate it. Needs: python3 with jinja2, and docker.
set -euo pipefail

role_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="$(awk '/^prometheus_image:/ {print $2}' "$role_dir/defaults/main.yml")"
if [ -z "$image" ]; then
  echo "error: could not read prometheus_image from $role_dir/defaults/main.yml" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

python3 - "$role_dir/templates/alert-rules.yml.j2" "$work/llamenos.yml" "$role_dir/defaults/main.yml" <<'PY'
import sys
import jinja2
import yaml

src, dst, defaults = sys.argv[1], sys.argv[2], sys.argv[3]
with open(defaults) as f:
    role_defaults = yaml.safe_load(f)
env = jinja2.Environment(
    trim_blocks=True,  # Ansible's template module default
    keep_trailing_newline=True,
    undefined=jinja2.StrictUndefined,
)
with open(src) as f:
    rendered = env.from_string(f.read()).render(**role_defaults)
with open(dst, "w") as f:
    f.write(rendered)
PY
cp "$role_dir/tests/alert-rules.test.yml" "$work/"
chmod -R a+rX "$work"

promtool() {
  docker run --rm --network none --entrypoint promtool \
    -v "$work:/rules:ro" -w /rules "$image" "$@"
}

echo "promtool ($image): check rules"
promtool check rules llamenos.yml
echo "promtool ($image): test rules"
promtool test rules alert-rules.test.yml
