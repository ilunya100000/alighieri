const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const appUrl = process.env.CLASSCOMPASS_URL || 'http://127.0.0.1:4173';
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('401 (Unauthorized)')) errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auth-screen:not([hidden])');
  await page.screenshot({ path: 'auth-preview.png', fullPage: true });
  await page.click('[data-auth-tab="register"]');
  await page.fill('#register-name', 'Визуальный тест');
  await page.fill('#register-username', `visual_${Date.now()}`);
  await page.fill('#register-password', 'visual-password');
  await page.click('#register-form button[type="submit"]');
  await page.waitForSelector('.homework-item');
  await page.screenshot({ path: 'desktop-preview.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.bottom-nav [data-route="schedule"]').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'mobile-preview.png', fullPage: true });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('OK: интерфейс открылся без ошибок на ПК и мобильном размере');
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
