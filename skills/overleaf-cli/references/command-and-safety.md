# Command and Safety Reference

## Contents

- Command surface
- Mutation classes
- Local files and invariants
- Architecture map
- Failure routing
- Maintainer verification

## Command Surface

Use current `--help` output as the source of truth. The expected command families are:

```text
overleaf-cli login [-s server]
overleaf-cli list [-s server]
overleaf-cli pull <projectId> [localDir] [-s server] [--force]
overleaf-cli init <projectName> [localDir] [-s server]
overleaf-cli push [localDir] [--prune-remote]
overleaf-cli diff [localDir]
overleaf-cli watch [localDir]
overleaf-cli compile [localDir] [--compiler pdflatex|xelatex|lualatex]
overleaf-cli history list [localDir] [--limit N]
overleaf-cli history diff <fromVersion> <toVersion> [localDir] [--file path]
overleaf-cli history export <version> [localDir] [--output path]
overleaf-cli history restore <version> [localDir] --file path
overleaf-cli share list [localDir]
overleaf-cli share invite <email> [localDir] --role viewer|reviewer|editor
overleaf-cli share set-role <userId> [localDir] --role viewer|reviewer|editor
overleaf-cli share remove <userId> [localDir]
overleaf-cli share revoke <inviteId> [localDir]
overleaf-cli share resend <inviteId> [localDir]
```

Prefer an existing saved login. If login is required, supply `OVERLEAF_COOKIE`, or both `OVERLEAF_EMAIL` and `OVERLEAF_PASSWORD`, through the environment without echoing them or placing them in command arguments. Unset them after `login`. Cookie login is generally more reliable because CAPTCHA can block the password flow.

## Mutation Classes

| Class | Commands | Guardrail |
| --- | --- | --- |
| Read-only remote inspection | `list`, `diff`, `history list`, `history diff`, `share list` | Run within the selected project scope. |
| Local output | `history export`, `compile`, `pull` | Resolve exact output paths and preserve existing data. |
| Remote project data | `init`, `push`, `watch`, `history restore` | Verify project binding and intended paths first. |
| Remote access control | `share invite`, `set-role`, `remove`, `revoke`, `resend` | Verify user or invite identity and exact role. |

`pull --force` suppresses the normal local conflict archive. Ordinary `push` propagates deletion only for paths previously tracked by this replica. `push --prune-remote` expands deletion to remote-only paths. Inspect deletions before either push mode, and never infer either flag from a generic request to sync.

## Local Files and Invariants

- `~/.overleaf-cli/config.json`: server-keyed credentials; mode `0600`; never display or commit.
- `.overleaf-cli.json`: normalized server and project binding; one local root maps to one remote project.
- `.overleaf-cliignore`: project ignore patterns; hidden files and common LaTeX build artifacts are also ignored.
- `.overleaf-cli-hashes.json`: confirmed binary hashes used to skip uploads.
- `.overleaf-cli-tracked.json`: paths previously owned by this replica; controls safe deletion.
- `.overleaf-cli-cache/`: confirmed text merge bases across reconnects and restarts.
- `.overleaf-cli-conflicts/`: archived local or remote snapshots requiring manual reconciliation.

Reject remote names that are empty, dot segments, contain separators, contain NUL, or escape the project root. Do not follow symbolic links while scanning or writing project files.

Text synchronization uses operational transforms and three-way merge. Validate OT positions and deleted content before application. Allow automatic merge only for non-overlapping changes with a trustworthy base. Preserve both sides and stop remote writes on overlap or a missing base.

## Architecture Map

- `src/index.ts`: Commander command graph and one process-level error boundary.
- `src/commands/`: user workflow orchestration and presentation.
- `src/project-context.ts`: shared resolution of root, binding, credentials, API, and socket.
- `src/api/base.ts`: HTTP routes, timeouts, status validation, downloads, history, compile, and sharing.
- `src/api/socketio.ts`: legacy Socket.IO lifecycle, project identity replay, and RPC timeouts.
- `src/sync/remote-tree.ts`: validated remote tree and identity indexes.
- `src/sync/remote-ops.ts`: remote mutation primitives.
- `src/sync/engine.ts`: synchronization state machine and reconciliation coordinator.
- `src/sync/local-snapshot.ts`: one classification path for local text and binary files.
- `src/sync/state-store.ts`: atomic durable hashes, tracked paths, cache, and conflict snapshots.
- `src/sync/merge.ts` and `src/sync/debounce.ts`: OT/merge correctness and queued local changes.
- `src/sync/watcher.ts`: filesystem event normalization and ignore reload.
- `src/utils/paths.ts`: normalized project identities and containment checks.
- `scripts/patch-socketio.js`: idempotent compatibility patch for Overleaf's legacy client.

Keep the sync engine as coordinator. Extract deterministic policies or persistence into focused modules instead of adding another source of truth.

## Failure Routing

- Authentication or project listing: inspect normalized server selection and credential presence without reading secret values.
- HTTP timeout or status: reproduce the exact route with verbose logging; increase only the HTTP timeout when justified.
- Join, ack, or reconnect timeout: inspect project identity replay, RPC timers, queue draining, and the Socket.IO timeout. Some deployments omit `meta.source`; accept an exact pending-operation match, and accept a version-only self-ack only while the same document has a known push in flight.
- Garbled Unicode: inspect transport text decoding before changing file encodings.
- Repeated upload or missed delete: inspect confirmed hashes and tracked-path ownership, not only the current directory tree.
- Conflict: inspect merge base, local content, and saved remote snapshot; do not retry blind writes.
- Compile ambiguity: require a canonical output artifact or one unambiguous candidate.
- Share invite failure: surface CAPTCHA guidance instead of repeatedly retrying.

## Maintainer Verification

Run the repository checks after implementation:

```bash
npm run check
git diff --check
node out/index.js --version
node out/index.js --help
```

For packaging changes, pack into a temporary directory, install the tarball into an empty consumer project, run the installed binary, verify the nested patched `socket.io-client` and `ws` version, and audit the consumer tree. Keep temporary artifacts outside the repository and remove only the exact temporary directory after validation.
