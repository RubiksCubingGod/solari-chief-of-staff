/**
 * Placeholder surface for the bot package, which will own the grammY Telegram bot.
 *
 * `MODULE_ID` exists so the package has a public export before its real one
 * lands: importing it exercises the workspace link, the package `exports` map,
 * and the build output, so a broken toolchain fails a test rather than
 * surfacing later as a confusing resolution error.
 */
export const MODULE_ID = '@chief-of-staff/bot' as const;
