#!/bin/sh
# Re-pins reference/redactions.json.gz's SHA-256 in ingest.ts after regenerating it.
set -e
cd "$(dirname "$0")/.."
sha=$(shasum -a 256 reference/redactions.json.gz | cut -d' ' -f1)
sed -i '' -E "s|(path: \"reference/redactions.json.gz\", sha256: \")[0-9a-f]+|\1$sha|" ingest.ts
grep -n "redactions.json.gz" ingest.ts
