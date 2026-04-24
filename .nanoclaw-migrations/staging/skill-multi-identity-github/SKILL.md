---
name: multi-identity-github
description: Authenticate to GitHub as the right identity based on repo owner. Uses four tokens (GH_TOKEN_JSBOIGE, GH_TOKEN_JSBOIGEECE, GH_TOKEN_JSBOIGEEPF, GH_TOKEN_JSBOIGEEPITA) from env. Call before any `gh` action on a repo whose owner is not the current logged-in user. Logs out after to avoid credential leakage.
---

# Multi-identity GitHub

This skill teaches the agent to switch `gh` CLI authentication to the correct GitHub account based on the target repo's owner. The user maintains four GitHub identities, each with its own PAT stored as an env var.

## When to use

Before any `gh` subcommand (`gh pr create`, `gh issue comment`, `gh repo view`, etc.) that targets a repo NOT owned by the currently logged-in user. Skip this skill for read-only operations on public repos where auth doesn't matter.

## Mapping

| Repo owner | Env var | Notes |
|------------|---------|-------|
| `jsboige` | `GH_TOKEN_JSBOIGE` | Default / personal account |
| `jsboige-ece` | `GH_TOKEN_JSBOIGEECE` | ECE professional |
| `jsboige-epf` | `GH_TOKEN_JSBOIGEEPF` | EPF professional |
| `jsboige-epita` | `GH_TOKEN_JSBOIGEEPITA` | EPITA professional |

Legacy `GH_TOKEN` without suffix: treat as alias for `GH_TOKEN_JSBOIGE`.

## Procedure

1. Determine the target repo owner:
   ```bash
   OWNER=$(gh repo view <owner>/<repo> --json owner -q .owner.login)
   # Or from context: the `owner/repo` in the URL / argument
   ```

2. Look up the token:
   ```bash
   case "$OWNER" in
     jsboige) TOKEN="$GH_TOKEN_JSBOIGE" ;;
     jsboige-ece) TOKEN="$GH_TOKEN_JSBOIGEECE" ;;
     jsboige-epf) TOKEN="$GH_TOKEN_JSBOIGEEPF" ;;
     jsboige-epita) TOKEN="$GH_TOKEN_JSBOIGEEPITA" ;;
     *) echo "Unknown owner $OWNER — stopping"; exit 1 ;;
   esac
   ```

3. Check if already logged in as that user:
   ```bash
   CURRENT_USER=$(gh api user --jq .login 2>/dev/null || echo "")
   if [ "$CURRENT_USER" = "$OWNER" ]; then
     echo "Already authenticated as $OWNER — skipping switch"
   else
     echo "$TOKEN" | gh auth login --hostname github.com --with-token
   fi
   ```

4. Do your `gh` operations.

5. **Always clean up** after done with the non-default identity:
   ```bash
   if [ "$OWNER" != "jsboige" ]; then
     gh auth logout --hostname github.com --user "$OWNER" 2>/dev/null || true
   fi
   ```

## Pitfalls

- **Token scope**: each token must have at least `repo` + `workflow` scope for the target repo. If a token is missing a scope, `gh` returns 404 or 403 — check with `gh auth status`.
- **Multi-account state**: `gh` supports multiple accounts since v2.40 via `gh auth switch`. If you see "switched account" errors, use `gh auth switch --user <login>` instead of re-logging.
- **Env var missing**: if the relevant `GH_TOKEN_*` env var is unset (e.g., new install forgot to set it), print the missing var and ask the user to set it before continuing.

## Verification

After auth switch, verify:
```bash
gh api user --jq '.login'  # should match $OWNER
```
