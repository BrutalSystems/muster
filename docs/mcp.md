# MCP servers and plugins

Optional tools for launched agents, and installing Muster's own MCP server.

[← back to the README](../README.md)

## Optional tools for launched agents

MCP servers are optional. Muster does not require or install Tin Can (or any
other MCP server). Register only servers you want launched agents to use in
`~/.muster/config.toml`. For example, to use an already-installed Tin Can:

```toml
# Optional personal defaults for sessions. Omit to keep launches MCP-free.
default_mcp = ["tincan"]

[mcp_servers.tincan]
command = "tincan"
tools = ["peers", "send_peer", "message_log"]
required = false
```

Then any runtime can use it:

```sh
muster run codex --mcp tincan --prompt 'Coordinate with the other agent'
muster run claude --mcp tincan --prompt 'Coordinate with the other agent'
muster run opencode --mcp tincan --permissions auto --sandbox workspace-write \
  --prompt 'Coordinate'
muster run codex --no-mcp --prompt 'Work without external tools'
```

A plugin is named either by `path` or by an `npm` specifier, never both. A path
becomes a file URL; a specifier is passed through untouched for OpenCode to
resolve and install:

```toml
[plugins.tincan]
npm = "@brutalsystems/tincan-opencode"

[plugins.local-thing]
path = "~/.config/opencode/plugin/local-thing.ts"
```

Prefer `npm` where the plugin is published — but not because it avoids a stale
copy. Both routes keep one. A copied file goes stale in silence: the package
updates, the copy does not, and the old code keeps running against whatever it
was built for. A specifier keeps its copy somewhere less obvious. OpenCode
resolves the specifier once, writes a generated `package.json` pinning the
resolved version alongside a lockfile, and caches that under the range it was
asked for:

```sh
~/.cache/opencode/packages/@brutalsystems/tincan-opencode@latest
```

Publishing a new version does not change that directory and nothing warns, so
the stale plugin keeps running and keeps reporting. Deleting it forces
re-resolution on the next launch:

```sh
rm -rf ~/.cache/opencode/packages/@brutalsystems/tincan-opencode@latest
```

Muster passes the specifier through untouched, so pin a version where the
staleness should be deliberate and visible in config rather than implicit in a
cache. OpenCode keys a pinned specifier to its own directory, leaving the
`@latest` copy alone:

```toml
[plugins.tincan]
npm = "@brutalsystems/tincan-opencode@0.7.1"
```

A specifier needs the package to declare an entry point OpenCode's loader
actually reads. It looks for `exports["./server"]` and falls back to `main`; it
does not read `exports["."]`. A package declaring only the latter is fetched,
its `package.json` is read, the session runs — and the plugin never executes,
with nothing logged. If a specifier-named plugin appears to do nothing, check
the package's entry points before looking anywhere else.

Either way, confirm what is actually loaded. `muster doctor` checks every
path-configured plugin against the package it came from:

```sh
muster doctor --format human
```

```
tincan @brutalsystems/tincan-opencode
  Status: stale — copy predates 0.7.2, published 2026-09-21
  Path: /Users/you/.config/opencode/plugin/tincan.ts

1 stale plugin. Replace path with npm = "@brutalsystems/tincan-opencode" in [plugins.tincan], or re-copy the file.
```

The copied file carries no version of its own, so the check compares its mtime
against the registry's publish time for the current release. That means a file
re-copied recently reads as current even when its contents are old: doctor
under-reports and never cries wolf. It exits 1 when anything is stale, and an
unreachable registry is reported as such rather than failing the command.

Muster knows the packages for the plugins it ships with. Name anything else,
or override the default, with `published`:

```toml
[plugins.mine]
path = "~/src/mine.ts"
published = "@acme/mine-opencode"
```

Plugins named by `npm` are not checked: they keep no copy of their own, and
clearing OpenCode's cache above is that remedy instead. For what a running
session loaded rather than what is on disk, the records still carry the version:

```sh
grep plugin_version ~/.tincan/peers/opencode/ses_*.json
tincan --version
```

Registering Muster itself is the one case to think twice about. A definition
whose command runs `muster mcp` gives every session that selects it `run`,
`list`, `stop` and `output` — launch authority, held by an agent rather than by
you. Put it in `default_mcp` and every session muster launches can launch more,
which is the propagation the child restrictions above exist to prevent;
`max_concurrent` caps simultaneous launches but does not stop a tree forming.
Nothing in Muster refuses this, so the restraint has to be yours. If you want
an orchestrating agent, give exactly that one session an explicit
`--mcp muster` and leave `default_mcp` alone. See "MCP installation" below for
the same stance applied to a runtime's own shared configuration.

`--mcp NAME` is repeatable and **replaces** personal defaults. `--no-mcp` clears
them and cannot be combined with `--mcp`. MCP `run` takes `mcp: ["tincan"]`;
`mcp: []` disables all servers. Omitted selection uses `default_mcp` for sessions.
Tasks have no defaults, but accept an explicit selection.

Definitions support either `command` plus optional `args`, `env`, and `env_vars`
for stdio, or `url` plus optional `bearer_token_env_var` for Streamable HTTP.
`tools` is a required nonempty list of exact tool names. Use `env_vars` and
`bearer_token_env_var` to reference credentials in the launch environment;
credentials are not written to launch logs. HTTP OAuth setup shared across
runtimes, plugin/app tools, MCP resources and prompts are outside this interface.
Server and tool names must contain only letters, digits, underscores or hyphens.
Relative stdio commands run from the requested working directory; prefer an
absolute executable path or a command on PATH.

Before agent launch, Muster initializes each selected server and checks its tool
catalog. No tool is called during preflight. An explicit `--mcp` selection is
required: a missing server, missing credential, or missing configured tool fails
that launch. Defaults are optional unless their definition sets `required = true`;
an unavailable optional default is skipped with `mcp_warnings`. Each preflight is
bounded by `startup_timeout_sec` (default 10, maximum 60) and the launch deadline.
JSON results and `list` report selected logical names in `mcp`; human output shows
`MCP:` and any warnings. These describe launch configuration, not continuous
server health.

Codex receives isolated definitions, using a fresh runtime name when an inherited
server has the same name, and its native tool allowlist. Claude receives a private
Muster stdio connection that filters both tool discovery and calls; newly added
upstream tools cannot bypass the selection. Only selected tools are preapproved.
OpenCode disables inherited definitions and tool families in its verified
per-launch overlay, then enables only selected definitions. A launch that
selects MCP servers omits the wildcard `*` permission entry and names the
built-in tools it denies instead: in OpenCode a `*` entry suppresses MCP tools
outright, and an explicit allow for the tool does not restore them. The
built-in list is fixed, so a tool added by a future OpenCode release would not
be denied by it; launches that select no MCP server keep the wildcard. With no plugins
selected it also uses `--pure` and pins an empty plugin list, so inherited
plugins do not enter the child process. Selecting a plugin with `--plugin`
necessarily relaxes that: OpenCode merges project-local plugin discovery into
any non-empty plugin list, so the child also loads whatever plugins the target
repository ships. It globs both spellings — `.opencode/plugin` and
`.opencode/plugins` — so auditing only one of them misses half of what a
repository can load. Select plugins only for repositories trusted with that.
`--plugin NAME` is repeatable and replaces whatever plugins the configuration
selects by default, rather than adding to them; `--no-plugin` selects none and
is how a launch gets the `--pure` treatment above when the configuration would
otherwise have chosen some. Both apply to OpenCode only.
Claude connection specifications are stored with owner-only permissions under
`~/.muster/mcp`, removed on stop, task completion, or when `list` observes an ended
session. MCP server access is separate from filesystem sandbox permissions: a
selected external tool may have its own write or network capabilities.

## MCP installation

Installed deliberately, in the one session that should hold spawn authority —
never at user scope.

Muster exposes `run`, `list`, `stop`, and `output` over stdio. `mcp` starts the
server, and so does no arguments when stdin is not a terminal — which is what an
MCP client provides. Typing `muster` at a terminal prints the usage text and a
short status instead, because a server waiting for JSON-RPC on stdin is
indistinguishable from a hang. `muster mcp` starts the server either way, so it
can still be driven by hand to debug it. Diagnostics go to stderr, never protocol stdout.
Schemas match the CLI (`args` is the array of optional runtime arguments).

For a single Codex session, use per-invocation configuration:

```sh
codex -c 'mcp_servers.muster.command="node"' \
  -c 'mcp_servers.muster.args=["/absolute/path/to/muster/dist/muster.js","mcp"]'
```

For a single Claude session:

```sh
claude --mcp-config '{"mcpServers":{"muster":{"command":"node","args":["/absolute/path/to/muster/dist/muster.js","mcp"]}}}'
```

Do not add Muster to `~/.codex/config.toml`, Claude's user-scope MCP registry,
or another shared configuration that grants launch authority to every agent.
The same applies to Muster's own `[mcp_servers]`: a definition that runs
`muster mcp`, selected by `default_mcp`, grants that authority to every session
Muster launches.
