# סוכן בדיקת זמינות לחניון לילה חורשת טל

הסוכן הזה בודק כל יום זמינות במערכת ההזמנות של רשות הטבע והגנים עבור:

- חניון: חניון לילה חורשת טל
- תאריכים: 21/05/2026 עד 23/05/2026
- הרכב: 2 מבוגרים, 1 ילד, 1 פעוט

הוא משתמש ב־Playwright, כלומר בדפדפן Chromium אמיתי, ולכן הוא עמיד יותר מאשר סקרייפינג רגיל.

## מה הוא עושה

1. פותח את עמוד ההזמנה הישיר של חורשת טל.
2. מנסה למלא תאריכים וכמות אורחים.
3. מחפש כפתורים/טקסטים שמסמנים זמינות, כמו `הוסף לסל`, `לתשלום`, `בחר`, `פנוי`.
4. מחפש טקסטים שמסמנים חוסר זמינות, כמו `אין זמינות`, `אין מקומות`, `אזלו המקומות`, `מלא`.
5. אם יש אינדיקציה לזמינות — שולח התראה בטלגרם או במייל.
6. בכל ריצה שומר צילום מסך ו־HTML לתיקיית `artifacts`, כדי שאפשר יהיה לדבג.

> חשוב: הסוכן לא מבצע הזמנה ולא עוקף תשלום/קאפצ׳ה/כניסה לחשבון. הוא רק בודק ומתריע.

## התקנה מקומית

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm run check
```

להרצה עם דפדפן פתוח:

```bash
SHOW_BROWSER=1 npm run check
```

## הפעלה אוטומטית ב־GitHub Actions

1. צרי Repository חדש ב־GitHub.
2. העלי אליו את כל הקבצים בתיקייה הזו.
3. לכי ל־Settings → Secrets and variables → Actions → New repository secret.
4. הוסיפי סודות לטלגרם או מייל.

### התראת Telegram

מומלץ, הכי פשוט.

1. צרי בוט דרך `@BotFather`.
2. קבלי `TELEGRAM_BOT_TOKEN`.
3. קבלי את ה־chat id שלך, למשל דרך `@userinfobot`.
4. הגדירי ב־GitHub Secrets:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`

### התראת Email

הגדירי:
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `EMAIL_FROM`
- `EMAIL_TO`

## בדיקה ידנית

ב־GitHub:
Actions → Check Parks Campground Availability → Run workflow

לאחר הריצה:
- אם יש התראה — תקבלי אותה בטלגרם/מייל.
- אם אין, אפשר לפתוח את artifact בשם `parks-debug-artifacts` ולראות צילום מסך של האתר בזמן הבדיקה.

## התאמות

ערכי את `config.json` כדי לשנות חניון, תאריכים או הרכב.

```json
{
  "target": {
    "campgroundName": "חניון לילה חורשת טל",
    "productUrl": "https://fe.sales.parks.org.il/product-page/20",
    "checkIn": "2026-05-21",
    "checkOut": "2026-05-23",
    "adults": 2,
    "children": 1,
    "toddlers": 1
  }
}
```

## אם האתר משתנה

האתר הוא אפליקציה דינמית, ולכן ייתכן שמדי פעם שמות הכפתורים/השדות ישתנו. במקרה כזה:
1. הריצי `SHOW_BROWSER=1 npm run check`.
2. בדקי מה מופיע במסך.
3. עדכני ב־`config.json` את מילות הזמינות/חוסר הזמינות.
4. אם צריך, עדכני את פונקציות `fillDateInputs` או `setGuests` ב־`monitor.js`.
