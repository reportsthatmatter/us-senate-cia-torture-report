#!/bin/sh
# Re-pins reference/redactions.json.gz's SHA-256 in ingest.ts and datapackage.json after regenerating it.
set -e
cd "$(dirname "$0")/.."
sha=$(shasum -a 256 reference/redactions.json.gz | cut -d' ' -f1)
sed -i '' -E "s|(path: \"reference/redactions.json.gz\", sha256: \")[0-9a-f]+|\1$sha|" ingest.ts
python3 - "$sha" <<'PY'
import json, sys
p = "datapackage.json"; d = json.load(open(p))
for r in d["resources"]:
    if r["path"] == "reference/redactions.json.gz": r["hash"] = "sha256:" + sys.argv[1]
open(p, "w").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY
grep -n "redactions.json.gz" ingest.ts
