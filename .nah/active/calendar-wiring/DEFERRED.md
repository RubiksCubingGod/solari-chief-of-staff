# Deferred

- Per-person reminder hour. The scan holds reminders until 09:00 on the person's clock (`REMINDER_SEND_FROM_HOUR`); a column on `users` would let them choose. Deferred from `daily-scan-reminders`.
- Re-arming a `skipped_unbound` reminder when the person binds a chat inside the same window. Today the skip is final for that day and the next day's reminders go out normally. Deferred from `daily-scan-reminders`.
- A bot process entry point (`scripts/bot.mjs`) that polls Telegram in production; the worker sends without listening. Owned by `telegram-roundtrip`.
