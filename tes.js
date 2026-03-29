const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"]
  });

  const page = await browser.newPage();
  await page.goto("https://google.com");

  console.log("WORKING ✅");

  await browser.close();
})();