import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";
import net from "net";
import tls from "tls";

const config = JSON.parse(await fs.readFile("config.json", "utf8"));
const artifactsDir = "artifacts";
await fs.mkdir(artifactsDir, { recursive: true });

const now = new Date().toISOString().replace(/[:.]/g, "-");
const screenshotPath = path.join(artifactsDir, `run-${now}.png`);
const htmlPath = path.join(artifactsDir, `run-${now}.html`);

const target = config.target;
const headless = process.env.SHOW_BROWSER === "1" ? false : config.behavior.headless;

function ddmmyyyy(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function prettyTarget() {
  return `${target.campgroundName}, ${ddmmyyyy(target.checkIn)}-${ddmmyyyy(target.checkOut)}, ${target.adults} מבוגרים, ${target.children} ילד, ${target.toddlers} פעוט`;
}

async function clickIfVisible(page, selectorsOrText, options = {}) {
  for (const item of selectorsOrText) {
    try {
      const locator = item.startsWith("text=") || item.startsWith("role=") || item.startsWith("//") || item.startsWith("css=")
        ? page.locator(item)
        : page.getByText(item, { exact: false });
      const count = await locator.count();
      if (count > 0 && await locator.first().isVisible({ timeout: 1200 }).catch(() => false)) {
        await locator.first().click({ timeout: 5000, ...options }).catch(async () => {
          await locator.first().click({ timeout: 5000, force: true, ...options });
        });
        await page.waitForTimeout(800);
        return true;
      }
    } catch {}
  }
  return false;
}

async function fillDateInputs(page) {
  const checkInIso = target.checkIn;
  const checkOutIso = target.checkOut;
  const checkInDisplay = ddmmyyyy(target.checkIn);
  const checkOutDisplay = ddmmyyyy(target.checkOut);

  const inputs = await page.locator("input").all();
  const visibleInputs = [];
  for (const input of inputs) {
    if (await input.isVisible().catch(() => false)) visibleInputs.push(input);
  }

  // First try native date inputs.
  let dateLike = [];
  for (const input of visibleInputs) {
    const type = await input.getAttribute("type").catch(() => "");
    const placeholder = await input.getAttribute("placeholder").catch(() => "");
    const aria = await input.getAttribute("aria-label").catch(() => "");
    const name = await input.getAttribute("name").catch(() => "");
    const meta = `${type} ${placeholder} ${aria} ${name}`;
    if (/date|תאריך|כניסה|יציאה|from|to|start|end/i.test(meta)) {
      dateLike.push(input);
    }
  }

  if (dateLike.length >= 2) {
    await dateLike[0].fill(checkInIso).catch(async () => dateLike[0].fill(checkInDisplay));
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(500);
    await dateLike[1].fill(checkOutIso).catch(async () => dateLike[1].fill(checkOutDisplay));
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(1000);
    return true;
  }

  // Common fallback: click date placeholders and type dates.
  const clickedStart = await clickIfVisible(page, ["תאריך כניסה", "כניסה", "מועד הגעה", "הגעה", "בחר תאריך"]);
  if (clickedStart) {
    await page.keyboard.type(checkInDisplay, { delay: 30 });
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(500);
  }

  const clickedEnd = await clickIfVisible(page, ["תאריך יציאה", "יציאה", "מועד עזיבה", "עזיבה"]);
  if (clickedEnd) {
    await page.keyboard.type(checkOutDisplay, { delay: 30 });
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(500);
  }

  return clickedStart || clickedEnd;
}

async function adjustQuantityNearText(page, labelRegex, desired) {
  // Tries to find a row/card containing the label and click + until the desired number appears.
  const candidates = await page.locator("body *").filter({ hasText: labelRegex }).all();
  for (const c of candidates.slice(0, 20)) {
    if (!(await c.isVisible().catch(() => false))) continue;
    const text = await c.innerText().catch(() => "");
    if (text.length > 300) continue;

    const plus = c.locator("button").filter({ hasText: /^\+|הוסף|plus/i });
    const minus = c.locator("button").filter({ hasText: /^-|הסר|minus/i });
    const buttons = await c.locator("button").all();

    // Reset down a few times if possible.
    for (let i = 0; i < 6; i++) {
      if (await minus.count().catch(() => 0)) await minus.first().click().catch(() => {});
    }

    for (let i = 0; i < desired; i++) {
      if (await plus.count().catch(() => 0)) {
        await plus.first().click().catch(() => {});
      } else if (buttons.length) {
        // Usually the rightmost/last button is plus in RTL quantity widgets.
        await buttons[buttons.length - 1].click().catch(() => {});
      }
      await page.waitForTimeout(250);
    }
    return true;
  }
  return false;
}

async function setGuests(page) {
  await clickIfVisible(page, ["אורחים", "משתתפים", "הרכב", "כמות", "מבקרים"]);
  await adjustQuantityNearText(page, /מבוגר|מבוגרים/, target.adults);
  await adjustQuantityNearText(page, /ילד|ילדים/, target.children);
  await adjustQuantityNearText(page, /פעוט|פעוטות|תינוק/, target.toddlers);
  await page.waitForTimeout(1000);
}

function classify(text) {
  const normalized = text.replace(/\s+/g, " ");
  const positives = config.availabilitySignals.positive.filter(s => normalized.includes(s));
  const negatives = config.availabilitySignals.negative.filter(s => normalized.includes(s));

  // Strong negative if no availability wording appears.
  if (negatives.length && !positives.includes("הוסף לסל") && !positives.includes("לתשלום")) {
    return { available: false, confidence: "high", positives, negatives };
  }

  // Strong positive if purchase/cart/checkout-like wording appears and page doesn't say no availability.
  const strongPositive = positives.some(s => ["הוסף לסל", "לתשלום", "תשלום", "בחר"].includes(s));
  if (strongPositive && !negatives.length) {
    return { available: true, confidence: "high", positives, negatives };
  }

  // Ambiguous positive: price or availability words with no obvious sold-out signal.
  if (positives.length && !negatives.length) {
    return { available: true, confidence: "medium", positives, negatives };
  }

  return { available: false, confidence: "low", positives, negatives };
}

async function notify(message) {
  const tasks = [];

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    tasks.push(fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message })
    }).then(r => r.text()));
  }

  if (process.env.SMTP_HOST && process.env.EMAIL_TO && process.env.EMAIL_FROM) {
    tasks.push(sendMail({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.EMAIL_FROM,
      to: process.env.EMAIL_TO,
      subject: "ייתכן שהתפנה מקום בחניון לילה",
      body: message
    }));
  }

  if (tasks.length === 0) {
    console.log("No notification env vars configured. Message would be:\n" + message);
    return;
  }

  await Promise.allSettled(tasks);
}

function smtpRead(socket) {
  return new Promise(resolve => socket.once("data", d => resolve(d.toString())));
}

async function smtpCommand(socket, cmd) {
  socket.write(cmd + "\r\n");
  return smtpRead(socket);
}

async function sendMail({ host, port, user, pass, from, to, subject, body }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, async () => {
      try {
        await smtpRead(socket);
        await smtpCommand(socket, `EHLO localhost`);
        await smtpCommand(socket, `STARTTLS`);

        const secure = tls.connect({ socket, servername: host }, async () => {
          try {
            await smtpCommand(secure, `EHLO localhost`);
            if (user && pass) {
              await smtpCommand(secure, `AUTH LOGIN`);
              await smtpCommand(secure, Buffer.from(user).toString("base64"));
              await smtpCommand(secure, Buffer.from(pass).toString("base64"));
            }
            await smtpCommand(secure, `MAIL FROM:<${from}>`);
            await smtpCommand(secure, `RCPT TO:<${to}>`);
            await smtpCommand(secure, `DATA`);
            secure.write(`From: ${from}\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`);
            await smtpRead(secure);
            await smtpCommand(secure, `QUIT`);
            secure.end();
            resolve();
          } catch (e) { reject(e); }
        });
      } catch (e) { reject(e); }
    });
    socket.on("error", reject);
  });
}

async function main() {
  const browser = await chromium.launch({ headless, slowMo: config.behavior.slowMoMs || 0 });
  const context = await browser.newContext({
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    viewport: { width: 1440, height: 1100 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.behavior.timeoutMs || 45000);

  console.log(`Checking: ${prettyTarget()}`);
  await page.goto(target.productUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // Cookie/accessibility/pop-up dismissals.
  await clickIfVisible(page, ["אישור", "מסכים", "קבל", "סגור", "הבנתי", "לא תודה"]);

  await fillDateInputs(page);
  await setGuests(page);

  // Trigger search/continue steps. Repeat because some flows show quantity, then availability, then packages.
  for (let i = 0; i < 3; i++) {
    const clicked = await clickIfVisible(page, [
      "בדיקת זמינות",
      "חפש",
      "חיפוש",
      "המשך",
      "להמשך",
      "הזמן",
      "להזמנה",
      "בחר",
      "הוסף לסל"
    ]);
    if (!clicked) break;
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1800);
  }

  const text = await page.locator("body").innerText({ timeout: 15000 }).catch(() => "");
  const html = await page.content();
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fs.writeFile(htmlPath, html, "utf8");

  const result = classify(text);
  console.log(JSON.stringify({
    target: prettyTarget(),
    result,
    screenshotPath,
    htmlPath,
    checkedAt: new Date().toISOString()
  }, null, 2));

  if (result.available) {
    await notify(
`נראה שהתפנה מקום או שיש אינדיקציה לזמינות בחניון לילה.

יעד: ${prettyTarget()}
רמת ביטחון: ${result.confidence}
סימנים חיוביים: ${result.positives.join(", ") || "לא זוהו"}
סימנים שליליים: ${result.negatives.join(", ") || "לא זוהו"}

כניסה להזמנה:
${target.productUrl}

מומלץ להיכנס מיד ולאמת ידנית לפני שהמקום נתפס.`
    );
  }

  await browser.close();

  // Exit 0 always, so GitHub Actions daily run won't look failed unless the script crashed.
}

main().catch(async (err) => {
  console.error(err);
  await notify(`בדיקת זמינות נכשלה עבור ${prettyTarget()}:\n${err.stack || err.message}`);
  process.exit(1);
});
