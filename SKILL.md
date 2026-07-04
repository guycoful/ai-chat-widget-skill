---
name: ai-chat-widget
description: >-
  בניית צ'אטבוט AI מלא לאתר React+Vite+Supabase — bubble widget בתחתית המסך, RTL עברית, שמירת שיחות ב-Supabase, Edge Function עם Claude, ופאנל אדמין. השתמש בסקיל זה כשמישהו אומר "תוסיף לי צ'אטבוט לאתר", "רוצה בוט בעברית באתר", "ai chat widget", "widget צ'אט", "צ'אטבוט על האתר", או כשצריך לבנות שירות לקוחות אוטומטי שמשתלב באתר React קיים. הסקיל מספק קוד מוכן לשימוש בהתאמה אישית מינימלית.
---

# AI Chat Widget — צ'אטבוט מלא לאתר

סקיל זה מוציא צ'אטבוט AI עובד לאתר React תוך פחות מ-30 דקות. הארכיטקטורה נבדקה בפרודקשן על guycohen-ai.co.il.

## ארכיטקטורה

```
[React ChatWidget] → [Supabase Edge Function: chat-respond] → [Claude API]
       ↕                           ↕
[localStorage]           [Supabase DB: conversations + messages]
                                   ↕
                         [Admin Panel /admin/chat]
```

**Stack:** React 18 + Vite + Tailwind + shadcn/ui + Supabase + Claude API (Anthropic)

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

-- RLS
ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- Allow anonymous reads/inserts (widget needs this without auth)
CREATE POLICY "public_insert_conversations" ON public.chat_conversations
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "public_select_conversations" ON public.chat_conversations
  FOR SELECT TO anon USING (true);

CREATE POLICY "public_insert_messages" ON public.chat_messages
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "public_select_messages" ON public.chat_messages
  FOR SELECT TO anon USING (true);

-- Admin can update (status changes, admin messages)
CREATE POLICY "auth_update_conversations" ON public.chat_conversations
  FOR UPDATE TO authenticated USING (true);

CREATE POLICY "auth_all_messages" ON public.chat_messages
  FOR ALL TO authenticated USING (true);
```

---

## שלב 2: Edge Function — chat-respond

צור ב-Supabase: Dashboard → Edge Functions → New Function → `chat-respond`

```typescript
// supabase/functions/chat-respond/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// *** התאם כאן: system prompt לעסק ***
const SYSTEM_PROMPT = `אתה העוזר הדיגיטלי של [שם העסק].
תפקידך לענות על שאלות לגבי [תחום העסק].

מידע חשוב:
- [כאן שם, שירותים, מחירים, שעות]

כללים:
- ענה תמיד בעברית, קצר וברור
- אם שואלים משהו שאינך יודע, אמור "אבדוק ואחזור אליך"
- כשהלקוח מבקש נציג אנושי, ענה עם המילה HUMAN_NEEDED בתחילת התגובה
- אל תמציא מידע שלא ניתן לך`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { conversationId, message, visitorName } = await req.json();

  // Create or get conversation
  let convId = conversationId;
  if (!convId) {
    const { data: conv } = await supabase
      .from("chat_conversations")
      .insert({ visitor_name: visitorName || "אנונימי" })
      .select("id")
      .single();
    convId = conv!.id;
  }

  // Save visitor message
  await supabase.from("chat_messages").insert({
    conversation_id: convId,
    role: "visitor",
    content: message,
  });

  // Load history (last 20 messages for context)
  const { data: history } = await supabase
    .from("chat_messages")
    .select("role, content")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: true })
    .limit(20);

  const claudeMessages = (history || []).map((m) => ({
    role: m.role === "visitor" ? "user" : "assistant",
    content: m.content,
  }));

  // Call Claude
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: claudeMessages,
    }),
  });

  const claudeData = await claudeRes.json();
  let reply = claudeData.content?.[0]?.text || "סליחה, לא הצלחתי לענות. נסה שוב.";

  // Check for human handoff signal
  const humanNeeded = reply.startsWith("HUMAN_NEEDED");
  if (humanNeeded) {
    reply = reply.replace("HUMAN_NEEDED", "").trim();
    await supabase.from("chat_conversations")
      .update({ status: "human_needed" })
      .eq("id", convId);
  }

  // Save AI reply
  await supabase.from("chat_messages").insert({
    conversation_id: convId,
    role: "ai",
    content: reply,
  });

  return new Response(
    JSON.stringify({ reply, conversationId: convId, humanNeeded }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
```

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
- כניסה עם סיסמה (localStorage token)
- רשימת שיחות + ענייה ישירה

---

## Checklist לפני Deploy

- [ ] Migration SQL הורץ ב-Supabase
- [ ] Edge Function נפרסה ו-ENV Variables הוגדרו
- [ ] `EDGE_FN_URL` עודכן ל-Project Ref הנכון
- [ ] System prompt הותאם לעסק (שם, שירותים, כללים)
- [ ] greeting text ו-teaser text הותאמו
- [ ] Widget מחובר ב-App.tsx
- [ ] בדיקת שיחה מלאה: שלח הודעה → קבל תשובה → בדוק בטבלה ב-Supabase

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

- [ ] שלבים 1-2 בוצעו (SQL + Edge Function)
- [ ] `edgeFnUrl` מצביע לפרויקט הנכון
- [ ] `businessName` ו-`greeting` הותאמו לעסק
- [ ] System prompt בשלב 2 הותאם לעסק
- [ ] קובץ JS מוגש מ-HTTPS (לא HTTP)
- [ ] בדיקת שיחה מלאה מהאתר של הלקוח

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
