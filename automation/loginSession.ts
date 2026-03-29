/**
 * Login session helper - for documentation only.
 * We do NOT implement login automation.
 *
 * To create a storageState file for an account:
 *
 * 1. Run a one-off script (or use browser manually):
 *    npx playwright open https://www.tiktok.com
 * 2. Log in manually in the opened browser.
 * 3. In DevTools or via a small script, save the storage state:
 *    await context.storageState({ path: 'storage/cookies/your-account.json' });
 *
 * Or use this helper script (run with ts-node or from a simple Node script):
 * - Launch browser (headless: false)
 * - Go to TikTok
 * - User logs in manually
 * - On a key press or after delay, save storageState to storage/cookies/<name>.json
 *
 * The upload worker then reuses that file via launch({ context: { storageState: path } }).
 */

export const TIKTOK_LOGIN_URL = "https://www.tiktok.com/login";
