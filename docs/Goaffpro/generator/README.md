# Regenerating `GoAffPro_Migration_PRODUCTION_FILLED.xlsx`

These three scripts build the populated migration workbook from the raw GoAffPro
exports in `docs/Goaffpro/`. They exist so the file can be rebuilt when the
missing **CDO orders export** arrives (BLOCKER 1 in the workbook's READ ME
FIRST sheet), or after practitioners are approved in the wholesale app.

```sh
cd docs/Goaffpro/generator
node 1-lookup-practitioners.cjs   # READ-ONLY Mongo query → apps.json + existing.json
node 2-build-workbook.cjs         # → ../GoAffPro_Migration_PRODUCTION_FILLED.xlsx
```

| Script | What it does |
|---|---|
| `goaffpro-csv.cjs` | CSV parser + the file-path map for both export folders. |
| `1-lookup-practitioners.cjs` | Read-only query against `MONGODB_URI` from `ns-retail/.env`: which affiliate emails already exist as **approved** `wholesale_applications`, plus the `cdo_practitioner_codes` / `cdo_orders` already in the database (so collisions can be detected). Writes `apps.json` and `existing.json`. Never writes to Mongo. |
| `2-build-workbook.cjs` | Builds every sheet, runs the validation checks, and writes the workbook. |

`apps.json` / `existing.json` are regenerable caches — they hold practitioner
emails and IDs, so do not commit them.

The column contract is driven by
[ns-retail/app/services/cdo/migration.service.js](../../../ns-retail/app/services/cdo/migration.service.js).
If that importer gains or renames a column, update `2-build-workbook.cjs`'s
`*_HEAD` arrays to match — the sheet order and header spelling are what the
importer keys off.

## Verifying a rebuild

Run the real importer in dry-run mode (writes nothing, no Shopify calls) rather
than trusting the built-in checks alone. Vite resolves extensionless imports and
plain Node does not, so a loader shim is needed:

```sh
# from ns-retail/
cat > .dryrun-loader.mjs <<'EOF'
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); } catch (err) {
    if (!specifier.startsWith('.')) throw err;
    for (const suffix of ['.js', '.jsx', '/index.js']) {
      try {
        const r = await next(specifier + suffix, context);
        if (existsSync(fileURLToPath(r.url))) return r;
      } catch { /* next suffix */ }
    }
    throw err;
  }
}
EOF
cat > .dryrun-register.mjs <<'EOF'
import { register } from 'node:module';
register('./.dryrun-loader.mjs', import.meta.url);
EOF
```

Then import `parseMigrationWorkbook` + `runMigrationImport({ parsed, actor, commit: false })`
under `node --import ./.dryrun-register.mjs`, after loading `.env` into
`process.env`. It makes roughly 6,000 sequential Atlas round trips for a file
this size — allow several minutes. Delete the two shim files afterwards.
