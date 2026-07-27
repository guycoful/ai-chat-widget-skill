---
name: ai-chat-widget
description: >-
  בניית צ'אטבוט AI מלא לאתר React+Vite+Supabase — bubble widget בתחתית המסך, RTL עברית, שמירת שיחות ב-Supabase, Edge Function עם Claude, מידע עסקי הניתן לעריכה בלי redeploy, rate limiting נגד ניצול לרעה, ופאנל אדמין. השתמש בסקיל זה כשמישהו אומר "תוסיף לי צ'אטבוט לאתר", "רוצה בוט בעברית באתר", "ai chat widget", "widget צ'אט", "צ'אטבוט על האתר", או כשצריך לבנות שירות לקוחות אוטומטי שמשתלב באתר React קיים. הסקיל מספק קוד מוכן לשימוש בהתאמה אישית מינימלית.
---

# AI Chat Widget — צ'אטבוט מלא לאתר

סקיל זה מוציא צ'אטבוט AI עובד לאתר React תוך פחות מ-30 דקות. הארכיטקטורה נבדקה בפרודקשן על guycohen-ai.co.il.

**חשוב להבין לפני שמתחילים:** זה לא RAG וקטורי. מידע עסקי (שעות, מחירים, קטלוג) נטען מטבלת `chat_knowledge` בכל בקשה ומצורף ל-system prompt - מספיק לעסק קטן-בינוני עם עד כ-100 פריטי מידע קצרים, לא מתאים לקטלוג גדול/משתנה בזמן אמת. ראה שלב 2.

## ארכיטקטורה

```
[React ChatWidget / embed-widget.js] → [Supabase Edge Function: chat-respond] → [Claude API]
              ↕ (GET: היסטוריה/polling)              ↕                              ↑
        [localStorage: conversationId]      [Supabase DB: conversations + messages    │
                                              + chat_knowledge + chat_rate_limits] ────┘
                                                        ↕
                                              [Admin Panel /admin/chat]
```

**חשוב:** ה-widget (React או embed) אף פעם לא מדבר עם Supabase ישירות. כל קריאה וכתיבה עוברות דרך ה-Edge Function, שמשתמשת ב-service_role key ועוקפת RLS. זה לא רק ניקיון ארכיטקטורה - זה מה שמונע מכל מי שמחזיק את ה-anon key הציבורי (למשל מה-embed script) לקרוא ישירות את כל השיחות של כל הלקוחות. ראה אזהרה בשלב 1.

**Stack:** React 18 + Vite + Tailwind + shadcn/ui + Supabase (DB + Edge Functions) + Claude API (Anthropic)

---

## שלב 1: בסיס נתונים — SQL Migrations

הרץ ב-Supabase SQL Editor:

```sql
-- conversations
CREATE TABLE public.chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'human_needed', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- messages
CREATE TABLE public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('visitor', 'ai', 'admin')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- knowledge base: מידע עסקי (שעות, מחירים, קטלוג) שנטען דינמית לתוך ה-system prompt.
-- לא RAG וקטורי - טעינה מלאה של כל השורות הפעילות בכל בקשה. ראה שלב 2 להסבר.
CREATE TABLE public.chat_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  content TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- rate limiting: כמה הודעות הגיעו מכל IP בכל חלון-שעה, כדי לא לתת לאף אחד לבזבז
-- את יתרת ה-Claude API שלכם. ראה increment_chat_rate_limit למטה.
CREATE TABLE public.chat_rate_limits (
  ip TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL DEFAULT 1,
  PRIMARY KEY (ip, window_start)
);

-- RLS
ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_rate_limits ENABLE ROW LEVEL SECURITY;

-- ⚠️ אין אף policy ל-anon על אף אחת מהטבלאות האלה, בכוונה. ה-widget (React או embed)
-- לעולם לא מדבר עם Supabase ישירות - כל קריאה וכתיבה עוברות דרך ה-Edge Function
-- (chat-respond) שמשתמשת ב-service_role key, שעוקף RLS לגמרי. RLS עם anon USING(true)
-- שהיה כאן בגרסה קודמת של הסקיל היה חור אבטחה אמיתי: כל מי שמחזיק את ה-anon key
-- (שנחשף בכוונה בעמוד ציבורי, כולל בembed script) יכול היה לקרוא/לייצא את כל השיחות
-- של כל הלקוחות אי פעם - שמות, מיילים, תוכן מלא - בקריאת REST אחת בלי אפילו לדעת
-- conversation_id ספציפי. אם התקנתם גרסה קודמת: הריצו מיד
-- `DROP POLICY "public_select_conversations" ON public.chat_conversations;`
-- `DROP POLICY "public_select_messages" ON public.chat_messages;`
-- ואל תחזירו policy כללית ל-anon על הטבלאות האלה.

-- ניהול (עדכון סטטוס, תשובת אדמין) - authenticated בלבד. אותה הערה כמו בsקיל
-- meeting-scheduler: אם ה-Admin Panel (שלב 4) לא באמת מתחבר עם supabase.auth
-- (email+password אמיתי) אלא רק בודק סיסמה קבועה בצד לקוח, ה-policies האלה לא
-- ישרתו אותו בפועל - שדרגו את פאנל הניהול ל-Supabase Auth אמיתי לפני production.
CREATE POLICY "auth_update_conversations" ON public.chat_conversations
  FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth_all_messages" ON public.chat_messages
  FOR ALL TO authenticated USING (true);

CREATE POLICY "auth_manage_knowledge" ON public.chat_knowledge
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- פונקציית עזר ל-rate limiting אטומי (upsert+increment יחיד, לא select-then-update -
-- אותה עקרון כמו התיקון ל-double-booking בsקיל meeting-scheduler).
CREATE OR REPLACE FUNCTION public.increment_chat_rate_limit(p_ip TEXT, p_window_start TIMESTAMPTZ)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_count INT;
BEGIN
  INSERT INTO public.chat_rate_limits (ip, window_start, count)
  VALUES (p_ip, p_window_start, 1)
  ON CONFLICT (ip, window_start)
  DO UPDATE SET count = chat_rate_limits.count + 1
  RETURNING count INTO new_count;
  RETURN new_count;
END;
$$;
```

**איך עורכים מידע עסקי בפועל:** Supabase Dashboard → Table Editor → `chat_knowledge` → הוספת שורה. לדוגמה `topic: "שעות פתיחה"`, `content: "א-ה 9:00-19:00, ו 9:00-14:00"`. אין ממשק ניהול ייעודי בגרסה הבסיסית - עריכה ישירה בטבלה, בלי redeploy ובלי לגעת בקוד.

---

## שלב 2: Edge Function — chat-respond

צור ב-Supabase: Dashboard → Edge Functions → New Function → `chat-respond`, והדבק את הקוד מ-`references/chat-respond-function.ts`.

**מה יש בגרסה הזו שלא היה בגרסה הקודמת:**

1. **Rate limiting אמיתי** - כל בקשת POST בודקת קודם, דרך פונקציית `increment_chat_rate_limit`, כמה הודעות הגיעו מה-IP הזה בשעה הנוכחית. מעל `MAX_MESSAGES_PER_HOUR` (ברירת מחדל 30) - הבקשה נדחית עם 429 לפני שנשלחת קריאה ל-Claude בכלל, אז זה לא רק "לא עונים", זה בפועל חוסך טוקנים. בלי זה, כל אחד שמוצא את `EDGE_FN_URL` יכול לשגר בקשות ישירות (בלי לעבור דרך ה-widget) ולצרוך יתרה בלי הגבלה.
2. **מידע עסקי דינמי מ-`chat_knowledge`** - לפני קריאה ל-Claude, הפונקציה טוענת את כל השורות הפעילות מהטבלה ומצרפת אותן ל-system prompt תחת "מידע עדכני על העסק". זה **לא RAG וקטורי** - אין embeddings, אין חיפוש סמנטי, זו טעינה מלאה של כל הטבלה בכל בקשה. בשביל עסק קטן (שעות, מדיניות, קטלוג של עד כ-100 פריטים קצרים) זה מספיק ופותר את הבעיה המרכזית: אתם מעדכנים מחיר בטבלה ב-Supabase, לא בקוד, ובלי redeploy. אם הקטלוג שלכם גדול או משתנה כל הזמן (מלאי בזמן אמת, מאות SKUs) - זה לא יספיק, תצטרכו שכבת חיפוש אמיתית (pgvector) שלא כלולה כאן.
3. **טיפול ב-GET** (`?conversationId=X`) - מחזיר את היסטוריית ההודעות של שיחה. זה מה שמאפשר ל-widget (React או embed) לטעון/לרענן היסטוריה **בלי** לקרוא ל-Supabase ישירות עם ה-anon key - ראה אזהרת ה-RLS בשלב 1 למעלה, זו הסיבה שהשינוי הזה הכרחי ולא רק "ניקיון קוד".

**ENV Variables** (Supabase Dashboard → Edge Functions → Secrets):
- `ANTHROPIC_API_KEY` — מ-console.anthropic.com
- `SUPABASE_URL` — Project Settings → API
- `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API

---

## שלב 3: React Widget

הוסף את הקובץ `src/components/ChatWidget.tsx` — ראה `references/ChatWidget.tsx` לקוד המלא.

**התאמות מינימליות נדרשות (חפש `***`):**

| שורה | מה לשנות |
|------|----------|
| `EDGE_FN_URL` | החלף `vuvavjmbvdqnwtleudqh` ב-Project Ref של הלקוח |
| greeting content | "היי! אני העוזר של [שם העסק]..." |
| teaser text | "יש לך שאלה על [שירות]?" |
| Header title | "Guy Cohen AI" → שם העסק |
| `bg-blue-primary` | צבע ראשי של העסק |

**חיבור ל-App.tsx:**

```tsx
import ChatWidget from "@/components/ChatWidget";

// בתוך ה-App component, לפני </BrowserRouter>:
<ChatWidget />
```

---

## שלב 4: Admin Panel (אופציונלי)

אם הלקוח רוצה לענות בעצמו על שיחות שדרשו נציג:
- קובץ: `src/pages/AdminChat.tsx`
- Route: `/admin/chat`
- כניסה עם סיסמה
- רשימת שיחות + ענייה ישירה

**⚠️ אם אתם בונים את הקובץ הזה:** תתחברו עם `supabase.auth.signInWithPassword()` אמיתי (משתמש שנוצר ב-Dashboard → Authentication → Users), לא סיסמה קבועה בקוד + localStorage token. ה-policies `auth_update_conversations`/`auth_all_messages` בשלב 1 מוגבלות ל-`TO authenticated` - בלי session אמיתי מ-supabase.auth הן לא ישרתו כלום. אותה נקודה בדיוק שתוקנה בsקיל `meeting-scheduler-skill`, ראה שם דוגמה מלאה ל-`AdminBookings.tsx` עם auth אמיתי אם אתם רוצים תבנית.

---

## Checklist לפני Deploy

- [ ] Migration SQL הורץ ב-Supabase (כולל `chat_knowledge`, `chat_rate_limits`, ופונקציית `increment_chat_rate_limit`)
- [ ] Edge Function נפרסה מ-`references/chat-respond-function.ts` ו-ENV Variables הוגדרו
- [ ] `EDGE_FN_URL` עודכן ל-Project Ref הנכון
- [ ] System prompt הותאם לעסק (שם, תחום, כללים) - הפרטים הספציפיים (מחירים/שעות/קטלוג) נכנסים ל-`chat_knowledge`, לא לקוד
- [ ] נוספה לפחות שורה אחת ב-`chat_knowledge` ונבדק שה-AI משתמש בה בתשובה
- [ ] greeting text ו-teaser text הותאמו
- [ ] Widget מחובר ב-App.tsx
- [ ] בדיקת שיחה מלאה: שלח הודעה → קבל תשובה → בדוק בטבלה ב-Supabase
- [ ] נבדק rate limiting: שליחת יותר מ-`MAX_MESSAGES_PER_HOUR` הודעות מחזירה הודעת "עברת את המכסה" ולא קוראת ל-Claude
- [ ] נבדק: קריאת REST ישירה ל-`chat_messages`/`chat_conversations` עם ה-anon key (בלי לעבור דרך ה-Edge Function) נכשלת - זו הבדיקה שמוודאת שה-RLS fix אכן פעיל

---

---

## שיטה ב: Embed Script (לכל אתר)

שלבים 1-2 (SQL migrations + Edge Function) זהים לחלוטין. רק הפרונטאנד שונה.

**מתאים ל:** WordPress, Wix, Squarespace, Webflow, HTML סטטי — כל אתר שמאפשר הוספת `<script>`.

### הוספה לאתר

הדבק לפני `</body>` בכל דף שרוצים שהווידג'ט יופיע בו:

```html
<script>
  window.AIChatConfig = {
    edgeFnUrl: "https://YOUR_PROJECT_REF.supabase.co/functions/v1/chat-respond",
    businessName: "שם העסק",
    greeting: "היי! איך אפשר לעזור ?",
    teaser: "יש לך שאלה ?",
    primaryColor: "#2563eb"
  };
</script>
<script src="https://YOUR_CDN_OR_HOST/ai-chat-widget.js"></script>
```

### 4 ערכים לשנות

| מפתח | תיאור | דוגמה |
|------|-------|-------|
| `edgeFnUrl` | URL של Edge Function (שלב 2) | `https://abc123.supabase.co/functions/v1/chat-respond` |
| `businessName` | שם שמופיע בכותרת הצ'אט | `"גיא כהן AI"` |
| `greeting` | הודעת פתיחה אוטומטית | `"היי! כאן ניתן לשאול על שירותים ומחירים"` |
| `primaryColor` | צבע כפתור וכותרת (hex) | `"#7c3aed"` |

### איך להגיש את הקובץ

**אפשרות א — Google Drive / Dropbox:** העלה את `embed-widget.js` ושמור קישור ציבורי.

**אפשרות ב — אותו Vercel/Netlify של האתר:** שים את הקובץ ב-`public/ai-chat-widget.js` ואז ה-src הוא `/ai-chat-widget.js`.

**אפשרות ג — jsDelivr (GitHub CDN):** push לרפו ציבורי ב-GitHub, אז:
```
https://cdn.jsdelivr.net/gh/USERNAME/REPO@main/embed-widget.js
```

### מה הווידג'ט עושה

- כפתור bubble צף בפינה ימין-תחתון
- בועת teaser ("יש לך שאלה ?") נעלמת אחרי 8 שניות
- שיחה נשמרת ב-localStorage בין רענונים
- טיפינג אנימציה בזמן המתנה לתשובה
- polling כל 10 שניות לקבלת הודעות מנציג אנושי
- RTL עברית מובנה, ללא תלות בספריות חיצוניות
- CSS מבודד עם prefix `aicw-` — לא מתנגש עם עיצוב האתר

### Checklist לפני Deploy (Embed)

- [ ] שלבים 1-2 בוצעו (SQL + Edge Function, כולל `chat_knowledge`/`chat_rate_limits`)
- [ ] `edgeFnUrl` מצביע לפרויקט הנכון
- [ ] `businessName` ו-`greeting` הותאמו לעסק
- [ ] System prompt בשלב 2 הותאם לעסק, פרטים ספציפיים נמצאים ב-`chat_knowledge`
- [ ] קובץ JS מוגש מ-HTTPS (לא HTTP)
- [ ] בדיקת שיחה מלאה מהאתר של הלקוח, כולל טעינת היסטוריה אחרי רענון דף

---

## עלויות

| רכיב | עלות |
|------|------|
| Supabase Free | ₪0 (עד 500MB DB, 500K edge invocations/חודש) |
| Claude Haiku | ~₪0.05 לשיחה ממוצעת |
| Vercel hosting | ₪0 (Hobby plan) |
| **סה"כ לעסק קטן** | ~₪20-50/חודש |

---

## שמירת פלטים

תמיד שמור קונפיגורציה מותאמת לקובץ:
`outputs/chatbot/[client-name]_chatwidget_config_[YYYY-MM-DD].md`

## Reference Files

- `references/ChatWidget.tsx` — קוד React מלא (מוכן להעתקה)
- `references/embed-widget.js` — סקריפט JS עצמאי לכל אתר
- `references/chat-respond-function.ts` — Edge Function: rate limiting, מידע עסקי דינמי, טיפול ב-GET להיסטוריה/polling
