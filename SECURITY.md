# Security policy

## Reporting a vulnerability

Please use GitHub's private security-advisory form for this repository. Do not
open a public issue containing a session cookie, CSRF token, password, private
project identifier, server URL with embedded credentials, or document content.

If private reporting is unavailable, open a public issue that contains no
sensitive details and ask the maintainer for a private contact channel.

## Credential handling

An Overleaf session cookie grants access to the same account and projects as
the corresponding browser session. Treat it like a password.

- Supply credentials only through `OVERLEAF_COOKIE`, or through the
  `OVERLEAF_EMAIL` and `OVERLEAF_PASSWORD` pair.
- Do not place credentials in this repository, shell scripts, issue reports,
  screenshots, or `.overleaf-cliignore`.
- The CLI stores authenticated session state in
  `~/.overleaf-cli/config.json`. On POSIX systems, the directory is restricted
  to the current user and the file is written with mode `0600`.
- Revoke the Overleaf session immediately if a credential may have leaked.

The repository ignores common environment, key, certificate, npm-token, and
local Overleaf state files. This reduces accidental commits but is not a
substitute for reviewing staged changes before every push.
