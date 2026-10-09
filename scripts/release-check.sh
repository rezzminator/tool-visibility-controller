#!/usr/bin/env bash
# Release integrity: the version agrees in every place that carries it, and
# CHANGELOG.md has a dated section for it. With a base version argument (the
# version on main), the version must also have moved past it.
# Prints one line per failure and exits 1; exits 2 when a file cannot be read.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
read_json() { node -e 'const [f, e] = process.argv.slice(1); const j = JSON.parse(require("fs").readFileSync(f, "utf8")); process.stdout.write(String(e.split(".").reduce((o, k) => o?.[k], j) ?? ""))' "$1" "$2" || { echo "ERROR cannot read $1" >&2; return 1; }; }
v=$(read_json plugins/agent-scope/.claude-plugin/plugin.json version) || exit 2
[ -n "$v" ] || { echo "ERROR plugin.json has no version"; exit 2; }
v_re=$(printf '%s' "$v" | sed 's/\./\\./g')
fail=0
m=$(node -e 'const j = require("./.claude-plugin/marketplace.json"); process.stdout.write(j.plugins.find((p) => p.name === "agent-scope")?.version ?? "")') || { echo "ERROR cannot read marketplace.json"; exit 2; }
p=$(read_json package.json version) || exit 2
l=$(read_json package-lock.json version) || exit 2
lr=$(read_json package-lock.json packages..version) || exit 2
b=$(grep -oE 'badge/version-[0-9]+\.[0-9]+\.[0-9]+(--[0-9A-Za-z.]+)?-' README.md | sed -E 's/^badge\/version-//; s/-$//; s/--/-/')
[ "$m" = "$v" ] || { echo "FAIL marketplace.json says $m, plugin.json $v"; fail=1; }
[ "$p" = "$v" ] || { echo "FAIL package.json says $p, plugin.json $v"; fail=1; }
[ "$l" = "$v" ] && [ "$lr" = "$v" ] || { echo "FAIL package-lock.json says $l / $lr, plugin.json $v"; fail=1; }
[ "$b" = "$v" ] || { echo "FAIL README badge says ${b:-nothing}, plugin.json $v"; fail=1; }
grep -qE "^## \[$v_re\] — [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md || { echo "FAIL CHANGELOG.md has no dated section for $v"; fail=1; }
if [ -n "${1:-}" ]; then
  newest=$(node -e 'const p = (v) => { const [c, pre] = v.split("-"); return { c: c.split(".").map(Number), pre }; }; const cmp = (a, b) => { const A = p(a), B = p(b); for (let i = 0; i < 3; i++) { const d = (A.c[i] || 0) - (B.c[i] || 0); if (d) return d; } if (A.pre === B.pre) return 0; if (A.pre === undefined) return 1; if (B.pre === undefined) return -1; return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0; }; const [a, b] = process.argv.slice(1); process.stdout.write(cmp(a, b) >= 0 ? a : b)' "$1" "$v")
  { [ "$v" != "$1" ] && [ "$newest" = "$v" ]; } || { echo "FAIL version $v has not moved past main's $1"; fail=1; }
fi
[ $fail -eq 0 ] && echo "PASS release $v: versions agree, CHANGELOG dated${1:+, past $1}"
exit $fail
