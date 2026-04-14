/**
 * CLI: manual TikTok login and save storageState (same idea as root createSession.js).
 * Run: npx tsx scripts/createSession.ts
 */
import { launchChromium } from "../lib/playwrightLaunch";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

(async () => {
  const browser = await launchChromium("interactive");

  const context = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1366, height: 768 },
  });

  const page = await context.newPage();

  await page.goto("https://www.tiktok.com/login");

  console.log("Log in slowly, behave like a human, then press ENTER in this terminal to save session.");

  process.stdin.once("data", async () => {
    await context.storageState({
      path: "storage/cookies/testAccount.json",
    });

    console.log("Session saved to storage/cookies/testAccount.json");

    await browser.close();
    process.exit(0);
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
