# Changelog

## 0.1.0 (2026-11-02)

- First release: 5-hour, weekly and any other reported limits; prompt cache warm/cold with countdown and partial-reuse percent.
- Cache TTL from the app's report, learned from pauses, a setting, or a 1h default, with the reason one click away.
- Cache marked cold on `/compact`, `/clear` and model switches; only main-conversation requests refresh it.
- Stale and past-reset readings are flagged; unexpected data shows "no data" with a one-time toast.
- `/usagebar` diagnostics and `/usagebar reset`.
- Toasts at 80% and 95% usage and in the cache's last minute.
