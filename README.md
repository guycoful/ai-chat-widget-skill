# ai-chat-widget 💬

**סקיל ל-Claude Code שמוסיף צ'אטבוט AI עובד לכל אתר תוך 20 דקות — bubble widget בעברית RTL, שמירת שיחות ב-Supabase, ו-Edge Function עם Claude Haiku.**

הבעיה שהסקיל פותר: לקוח אומר "תוסיף לי צ'אטבוט לאתר" — בלי הסקיל זה שעות של הגדרות מפוזרות. עם הסקיל זה checklist ברור, קוד מוכן, וצ'אטבוט חי בסוף.

---

## שתי שיטות פריסה 🚀

| שיטה | מתאים ל | זמן |
|------|---------|-----|
| **Embed Script** — 2 תגיות `<script>` | WordPress, Wix, Squarespace, כל HTML | ~10 דק' |
| **React Component** — קומפוננט מוכן | React + Vite + Supabase | ~20 דק' |

שתי השיטות משתמשות באותה Edge Function ואותה DB.

---

## ארכיטקטורה

```
[Widget — JS או React] → [Supabase Edge Function: chat-respond] → [Claude Haiku API]
         ↕                              ↕
  [localStorage]           [Supabase DB: conversations + messages]
                                        ↕
                              [Admin Panel /admin/chat]
```

**Stack:** Supabase (Edge Functions + PostgreSQL) + Anthropic Claude Haiku + Vanilla JS / React 18 + Vite

---

## שימוש

```
/ai-chat-widget
```

הסקיל שואל על סוג האתר ומנחה שלב-שלב.

---

## מה מקבלים

- **`SKILL.md`** — הוראות מלאות לשתי השיטות כולל Checklist לפני deploy
- **`references/embed-widget.js`** — סקריפט vanilla JS מוכן (270 שורות, IIFE, CSS מבודד עם prefix `aicw-`)
- **`references/ChatWidget.tsx`** — קומפוננט React מוכן עם RTL, typing indicator, unread count
- **SQL migrations** — טבלות `chat_conversations` + `chat_messages` עם RLS
- **Edge Function template** — Deno TypeScript, קורא ל-Claude, שומר לDB, מזהה handoff לנציג

---

## הגדרת ה-Embed Script

```html
<script>
  window.AIChatConfig = {
    edgeFnUrl: "https://YOUR_PROJECT.supabase.co/functions/v1/chat-respond",
    businessName: "שם העסק",
    greeting: "היי! איך אפשר לעזור ?",
    teaser: "יש לך שאלה ?",
    primaryColor: "#2563eb"
  };
</script>
<script src="https://cdn.jsdelivr.net/gh/guycoful/ai-chat-widget-skill@main/references/embed-widget.js"></script>
```

---

## עלויות

| רכיב | עלות |
|------|------|
| Supabase Free | ₪0 |
| Claude Haiku | ~₪0.05 לשיחה |
| Vercel / GitHub Pages | ₪0 |
| **סה"כ לעסק קטן** | ~₪20–50/חודש |

---

## מבנה הריפו

```
ai-chat-widget/
├── SKILL.md                     # הסקיל המלא — שתי שיטות + SQL + Edge Function
├── README.md                    # קובץ זה
└── references/
    ├── ChatWidget.tsx           # קומפוננט React מוכן להעתקה
    └── embed-widget.js          # סקריפט JS עצמאי לכל אתר
```

---

## רישיון

MIT
