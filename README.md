# Usage bar

A Claude Code mod that puts a slim bar above the prompt showing:

- **5-hour and weekly usage**: percent used, a color bar (green, then amber from 70%, red from 90%), and when each one resets. Any other limit the app reports (a new window, a spend limit) gets its own segment automatically.
- **Prompt cache**: warm or cold, a countdown to cold, and how much of the last request was served from cache when it was only partly reused.
- **Where the cache TTL comes from**: `reported` (the app said so at a model switch), `detected` (learned from your own pauses), `set` (your setting) or `default` (1h, until there's evidence). Click the tag to see why.

It works in the Claude desktop app's Code tab and in the terminal.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-bar --marketplace ahmed-waheed91/usage-bar
```

Or from a shell:

```bash
claude plugin install usage-bar --marketplace ahmed-waheed91/usage-bar
```

Answer `y` to add the marketplace, then pick the user scope so it loads in every session, desktop app included. In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ahmed-waheed91/usage-bar`, then **Add plugin**.

To update later: `claude plugin update usage-bar`.

## How it stays accurate

- The countdown restarts on **every** model request in the main conversation, including each step of a long tool run. Subagents have their own caches and don't reset it.
- `/compact`, `/clear` and switching models empty the cache, so the bar turns cold at once instead of counting down to a time that no longer means anything.
- The TTL is learned per model and plan: a request after a long pause that still reads the cache proves the TTL is longer than that pause; one that comes back cold bounds it from above. Evidence that contradicts what was learned is dropped, so if the provider changes its TTL the bar follows.
- Usage numbers update only when this session gets a response. Your other computers share the same limits, so readings older than two minutes say "as of 12m ago" and dim once they pass your stale setting. A window whose reset time has passed shows "reset · awaiting update" instead of the old percent.
- If the app ever sends data in a shape the mod doesn't recognize, the bar says "no data" and toasts once, instead of showing a wrong number.
- The cache countdown is an estimate: the server can drop a cache early under load. A cold reply corrects it.

## Commands

- `/usagebar`: shows exactly what the mod is reading from the app: each limit, cache numbers, the TTL and the evidence behind it, and the app version. Paste this when reporting a problem.
- `/usagebar reset`: forgets the learned TTL on this computer.

## Settings

In `/config` (or `pluginConfigs.usage-bar.options` in `~/.claude/settings.json`):

| Setting | Default | What it does |
| --- | --- | --- |
| `ttlOverride` | `auto` | `auto` learns the TTL; or a fixed duration such as `5m`, `1h`, `30m` |
| `warnPercent` | `70` | Bars turn amber at this percent |
| `dangerPercent` | `90` | Bars turn red at this percent |
| `toastPercents` | `80,95` | Toast when a limit crosses these; empty for none |
| `cacheToast` | `true` | Toast when the cache has under a minute left |
| `staleMinutes` | `15` | Dim usage readings older than this |
| `showLimits` | `true` | Show the usage segments |
| `showCache` | `true` | Show the cache segment |

## Development

```bash
claude plugin validate .
claude plugin test .
```

The same two commands run on every push in GitHub Actions. The mod uses Claude Code's early-access hooks API, which can change between releases; if the bar stops working after an app update, run `/usagebar` and open an issue with its output.
