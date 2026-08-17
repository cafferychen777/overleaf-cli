---
name: overleaf-cli
description: Safely operate, troubleshoot, build, test, and maintain the overleaf-cli command-line client for bidirectional synchronization between local directories and Overleaf projects. Use for requests involving overleaf-cli login, list, pull, push, diff, watch, compile, history, sharing, `.overleaf-cli.json`, `.overleaf-cliignore`, sync conflicts, connection timeouts, packaging, or the overleaf-cli TypeScript source. Do not trigger for ordinary LaTeX editing or Overleaf web-UI work that does not use this CLI.
---

# Overleaf CLI

## Establish Context

1. Locate the executable with `command -v overleaf-cli`. In the source repository, run `npm run build` and use `node out/index.js` when the installed executable is unavailable.
2. Run `<cli> --help` and the relevant `<cli> <command> --help` before relying on remembered flags. Treat current CLI output as authoritative.
3. Find the project root by walking upward for `.overleaf-cli.json`. Keep all project-relative paths within that root.
4. Read [references/command-and-safety.md](references/command-and-safety.md) before running a mutating command, resolving conflicts, diagnosing protocol behavior, or editing this CLI.

Never print, return, commit, or inspect the contents of saved cookies, passwords, or `~/.overleaf-cli/config.json`. Report only whether credentials exist for the selected normalized server.

## Choose the Least-Mutating Workflow

- Inspect state with `list`, `diff`, `history list`, `history diff`, `history export`, or `share list` before changing remote data.
- Use `pull` to create or refresh a local replica. Preserve its default conflict archive behavior. Add `--force` only when the user explicitly accepts overwriting unarchived local conflicts.
- Run `diff` before `push` whenever practical and inspect every deletion. Ordinary `push` may delete paths previously tracked by this replica, but preserves remote-only paths. Add `--prune-remote` only when the user explicitly wants local files to mirror-delete remote-only paths.
- Use `watch` only for an explicitly requested continuous session. Keep the process observable, report connection or conflict events, and stop it cleanly on request.
- Treat `init`, `push`, `watch`, `history restore`, and share mutations as remote writes. Resolve the exact project and target before execution; stop when identity or scope remains ambiguous.
- Treat `compile` as a remote build plus a local `output.pdf` or `output.log` write. Preserve any unrelated output the user needs.

Do not broaden authorization merely because the command supports a flag. Preserve unrelated local files and remote collaborators.

## Handle Conflicts Conservatively

1. Stop automatic remote writes when the CLI reports a merge conflict.
2. Preserve the visible local file and every snapshot under `.overleaf-cli-conflicts/`.
3. Compare the local file, conflict snapshot, and available merge base; produce one resolved local file.
4. Run `diff`, then `push` only after the resolution matches user intent.
5. Leave conflict archives intact unless the user explicitly asks to remove verified obsolete snapshots.

Do not hand-edit `.overleaf-cli-hashes.json`, `.overleaf-cli-tracked.json`, or `.overleaf-cli-cache/` during normal operation. Diagnose their invariant first when recovery work truly requires an edit.

## Troubleshoot Systematically

1. Reproduce with `--verbose` while redacting secrets from all output.
2. Separate failures into configuration, HTTP, Socket.IO/OT, local filesystem, merge, compile, history, or sharing layers.
3. Verify normalized server and project identity, project-root containment, ignored-path behavior, and whether the file is text or binary.
4. Increase `OVERLEAF_CLI_HTTP_TIMEOUT_MS` or `OVERLEAF_CLI_SOCKET_TIMEOUT_MS` only for demonstrated timeout failures.
5. Prefer a minimal local test or fake protocol response over mutating a real Overleaf project during diagnosis.

## Maintain the Source

- Preserve the architecture boundaries described in the reference file: commands orchestrate, APIs transport, sync modules reconcile, and state stores persist invariants.
- Keep code and comments in English.
- Reuse `ProjectContext`, path helpers, local snapshot classification, state storage, and centralized colors instead of rebuilding parallel logic.
- Reject traversal, symlink escapes, invalid OT positions, ambiguous compile artifacts, and unsafe remote names at boundaries.
- Make writes atomic when persisting credentials, project binding, hashes, tracked paths, or cached merge bases.
- Add regression tests for each bug. Run `npm test`, `git diff --check`, `npm audit --json`, CLI help/version smoke tests, and an isolated `npm pack` install for dependency or packaging changes.
- Preserve the patched Overleaf Socket.IO client and bundled compatible `ws` version unless replacing the legacy protocol stack with a verified end-to-end alternative.

Report what changed, which checks passed, and any unverified live-server behavior. Never claim that private Overleaf endpoints are stable without an integration test against the intended server.
