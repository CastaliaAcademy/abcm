# Obsidian integration

ABCM supports an Obsidian vault as a one-way, read-only documentation source. Obsidian remains canonical; ABCM mirrors Markdown into a managed workspace and never writes into the vault. `.obsidian` and symbolic links are ignored.

## Readiness

- Network/local folder: available with PLAN-0008 after the runtime is rebuilt and started with the directory source configuration below. SMB/NFS/Synology/Windows shares must first be mounted on the Docker host.
- Plugin calling REST: the required preview/apply/sync API is available in the same release, so a private Obsidian plugin can invoke synchronization immediately.
- Packaged Obsidian community plugin: not included yet. Authentication UI, source selection, status display, debounce/watcher behavior, and distribution remain a separate feature.

Synchronization is currently explicit. Call `preview` then `apply`, or call `sync` for an immediate checksum-pinned preview/apply. There is no background watcher and no two-way merge.

## Docker setup

The `castalia-public` workspace must already exist in the managed workspace volume. On a fresh installation, start ABCM without the Obsidian overlay, create the workspace through `POST /v1/workspaces`, then recreate the service with the overlay.

The overlay makes that managed workspace the process default because SQLite needs a writable `<workspace>/.abcm` directory; the read-only application checkout remains mounted separately.

Add these values to the deployment `.env`:

```dotenv
ABCM_DOCUMENTATION_SOURCE_PATH=/absolute/host/path/to/ObsidianVault
ABCM_DOCUMENTATION_SOURCE_ID=obsidian
ABCM_DOCUMENTATION_WORKSPACE_ID=castalia-public
ABCM_DOCUMENTATION_TARGET_BASE_PATH=abcm/artifacts/notes/obsidian
```

`ABCM_DOCUMENTATION_SOURCE_PATH` may be a local directory or an already mounted network share. Start the service with the additional read-only bind overlay:

```bash
docker compose \
  --env-file .env \
  -f app/deploy/compose.config.yaml \
  -f app/deploy/compose.service.yaml \
  -f app/deploy/compose.obsidian.yaml \
  up -d --build
```

For a non-Compose process, configure the same source registry as strict JSON and enable SQLite:

```bash
export ABCM_DERIVED_STORE_ENABLED=true
export ABCM_DOCUMENTATION_SOURCES='[{"id":"obsidian","workspaceId":"castalia-public","root":"/absolute/path/to/ObsidianVault","targetBasePath":"abcm/artifacts/notes/obsidian"}]'
```

For selective routing, add deployment-owned `include`, `exclude`, and `mapping` fields. For example, `"include":["docs/**","README.md"]`, `"exclude":["docs/drafts/**"]`, and `"mapping":[{"match":"docs/adr/**","target":"abcm/artifacts/adr/"},{"match":"README.md","target":"abcm/README.md"}]`. Exact rules use the exact target; wildcard rules append the matched suffix to the target directory. Overlapping rules fail preview with `DOCUMENTATION_MAPPING_AMBIGUOUS`.

The source `root` is deployment-owned configuration. REST and MCP requests accept only `sourceId`; they cannot select an arbitrary host path.

## REST flow

Preview without mutations:

```bash
curl -sS \
  -H "Authorization: Bearer $ABCM_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sourceId":"obsidian"}' \
  http://127.0.0.1:8787/v1/workspaces/castalia-public/documentation-sources/preview
```

Apply the returned `importId` only after reviewing operations:

```bash
curl -sS \
  -H "Authorization: Bearer $ABCM_API_TOKEN" \
  -X POST \
  http://127.0.0.1:8787/v1/documentation-imports/IMPORT_ID/apply
```

For later updates, an Obsidian plugin or trusted operator can trigger the combined operation:

```bash
curl -sS \
  -H "Authorization: Bearer $ABCM_API_TOKEN" \
  -X POST \
  http://127.0.0.1:8787/v1/documentation-sources/obsidian/sync
```

To transfer canonical ownership into ABCM, first coordinate/freeze vault edits and review a fresh preview. Then submit its `snapshotDigest` with explicit approval:

```bash
curl -sS \
  -H "Authorization: Bearer $ABCM_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"operatorApproved":true,"expectedSnapshotDigest":"sha256:REVIEWED_DIGEST"}' \
  http://127.0.0.1:8787/v1/documentation-sources/obsidian/cutover
```

Cutover performs a final sync and checksum verification, then atomically marks the copies managed. After success the vault may be unmounted or deleted without affecting ABCM, and ordinary authorized REST/MCP/filesystem edits to the managed copies are allowed. Further preview/sync calls fail with `DOCUMENTATION_SOURCE_ALREADY_MANAGED`. Repeating cutover returns the recorded result and completes any interrupted MapRevision publication.

If either the source snapshot or a mirrored target changes after preview, apply fails rather than overwriting. A unique checksum/provenance source rename moves the mirror while retaining its frontmatter document identity and creates no tombstone. Deleting a canonical Markdown file removes its active mirror and retains inactive provenance plus a tombstone. Direct REST/MCP write, delete, or move operations against active mirrors fail with `MIRROR_DOCUMENT_READ_ONLY`.

## Plugin contract

An Obsidian plugin needs only the ABCM base URL, bearer token, configured `sourceId`, and workspace id. It should:

1. request preview and display create/update/delete/conflict counts;
2. ask for confirmation before the initial apply or any deletion;
3. call apply with the returned `importId`;
4. use `sync` only for subsequent user-triggered refreshes;
5. treat `DOCUMENTATION_IMPORT_STALE` and `SOURCE_TARGET_CONFLICT` as requests to refresh preview.
6. expose cutover only as a separately confirmed operator action and pin the displayed preview digest.

For remote access, use the same approved HTTPS tunnel as MCP. Do not embed a long-lived production token in a public plugin build.
