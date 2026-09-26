# Verification and compatibility

What is tested automatically, what is verified by hand, and the Tin Can contract.

[← back to the README](../README.md)

## Verification

```sh
npm test
npm run build
npm run test:contract
```

The ordinary suite requires tmux, node-pty, POSIX `ps`/`lsof`, and Python 3 for
real file locks in the fake Codex executable. It uses isolated runtime homes and
no model APIs. It skips the four explicitly invoked compatibility cases.

The verified contract baseline is the Tin Can named by `tincan_version` in the
frozen fixture, `test/fixtures/canonical-id.json`. That field is the single place
recording which release the vendored copies describe, and both `RELEASING.md` and
`publish.yml` derive their pin from it. The suite spawns an installed binary as
an MCP subprocess, compares durable IDs, and verifies delivery to fake runtimes
through both terminal hosts. A missing binary or missing durable field fails the
test. For reproducible verification, install that exact release outside Muster —
derived here too, rather than typed, so this command cannot name a release the
fixture has moved past:

```sh
contract_dir=$(mktemp -d)
ver=$(node -p "require('./test/fixtures/canonical-id.json').tincan_version")
npm install --prefix "$contract_dir" --no-save "@brutalsystems/tincan@$ver"
MUSTER_TINCAN_BIN="$contract_dir/node_modules/.bin/tincan" npm run test:contract
```

Verification uses that published release installed in an isolated temporary
directory. No Tin Can source edits are made.
Fixture version metadata alone does not indicate address-format drift: compare
the case arrays. Those arrays cover naming only, not peer-list membership or
state semantics. Upgrades require separate compatibility verification; passing
fixture hashes alone does not establish compatibility. The tests locate the
launched peer by canonical ID and compare its durable ID; they do not assert a
total peer count, exclude same-runtime peers, or assert Tin Can's busy state.
`CONTRACT_PROVENANCE.md` records both types of integrity checks.

One-time live probes are separate from the automated suite. Both runtimes
launched and answered an initial prompt with the versions listed above; Claude
used a directory already trusted by its operator. `npm test` does not run
real models.

## Tin Can compatibility

Muster has no Tin Can build or runtime dependency. Each tool implements the
written address contract independently. Vendored mechanics carry source-commit
headers and the original MIT license in `TINCAN_LICENSE`.

Addresses belong to running sessions and can expire or collide. Store
`thread_id` / `session_id`, and re-resolve through Tin Can's `peers` before
sending instead of caching a launch address. Canonical IDs are not unique keys.

One OpenCode behaviour is worth knowing if you deliver to a session yourself
rather than through Tin Can. A message posted to the v2
`/api/session/{id}/prompt` of a **TUI-hosted** session is admitted with a 200
and an `admittedSeq`, schedules a turn, and then dies with
`ModelUnavailableError` naming the session's own model — while the TUI resolves
that same model in the same process. A session hosted by `opencode serve` does
not do this, and the v1 `/session/{id}/prompt_async` route does not either.
Tin Can 0.6.0 delivers over v1, so nothing here depends on the v2 path.

The failure is silent from the caller's side: a success response, nothing
written into the session, and the only trace a line in OpenCode's own log. The
investigation, what it did and did not establish, and why it was not filed
upstream are recorded in
[CONTRACT_PROVENANCE.md](./CONTRACT_PROVENANCE.md).
The frozen cases intentionally preserve Tin Can's known naming defects.

Codex `idle` means reachable and not known to be busy, not guaranteed free.
The querying app-server can report `notLoaded` for a live thread; Muster maps
that to `idle`. Claude state comes from its session registry.

OpenCode peers expose a durable `session_id` and loopback-only `server_url` so a
future Tin Can adapter has a stable integration seam. Tin Can does not yet send
to OpenCode through Muster: choosing native OpenCode messaging versus A2A, and
updating Tin Can for that transport, are explicitly deferred follow-up work.
