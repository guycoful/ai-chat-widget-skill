// *** קובץ מוכן להעתקה - supabase/functions/chat-respond/index.ts ***
// גרסה מעודכנת: מוסיפה rate limiting אמיתי, "מידע עסקי" הניתן לעריכה בלי redeploy,
// ומטפלת ב-GET (טעינת היסטוריה + polling) - כדי שגם ChatWidget.tsx וגם embed-widget.js
// לא יצטרכו לקרוא ל-Supabase ישירות עם ה-anon key (ראה אזהרת RLS ב-SKILL.md שלב 1).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// *** התאם כאן: תיאור כללי של העסק ואיך לדבר. פרטים ספציפיים (מחירים, קטלוג, שעות) ***
// *** לא נכנסים לכאן - הם נטענים דינמית מטבלת chat_knowledge, ראה למטה. כך אפשר לעדכן ***
// *** מחיר או שעת פתיחה מטבלה ב-Supabase בלי לגעת בקוד ולפרוס מחדש. ***
const SYSTEM_PROMPT_BASE = `אתה העוזר הדיגיטלי של [שם העסק].
תפקידך לענות על שאלות לגבי [תחום העסק], בעברית, קצר וברור.

כללים:
- ענה רק על סמך המידע שסופק לך למטה תחת "מידע עדכני על העסק"
- אם שואלים משהו שאינך יודע או שלא מופיע במידע - אמור "אבדוק ואחזור אליך", אל תמציא
- כשהלקוח מבקש נציג אנושי, ענה עם המילה HUMAN_NEEDED בתחילת התגובה`;

// כמה הודעות (מה-visitor) מותר לשלוח לכל IP בשעה, לפני שנחסום כדי לא לבזבז טוקנים.
// *** התאם למספר שהגיוני לעסק שלך - חנות עם תנועה גבוהה תרצה מספר גבוה יותר ***
const MAX_MESSAGES_PER_HOUR = 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const url = new URL(req.url);

  // ---- GET: טעינת היסטוריה / polling (מחליף קריאה ישירה ל-Supabase מה-widget) ----
  if (req.method === "GET") {
    const conversationId = url.searchParams.get("conversationId");
    if (!conversationId) return jsonResponse({ error: "conversationId required" }, 400);

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (error) return jsonResponse({ error: "failed to load messages" }, 500);
    return jsonResponse({ messages: data || [] });
  }

  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  // ---- Rate limiting לפי IP, לפני שקוראים ל-Claude בכלל ----
  // שימוש בעדכון אטומי יחיד (upsert עם onConflict) כדי למנוע race דומה לזה שתוקן בskill
  // meeting-scheduler: לא select-then-update, אלא פעולה אחת שמחזירה את המצב העדכני.
  //
  // ⚠️ הגבלה מודעת: x-forwarded-for ניתן לזיוף על ידי מי שפונה ישירות ל-Edge Function
  // (בלי לעבור דרך ה-widget/דפדפן אמיתי) - זו הגנה best-effort נגד שימוש מקרי/נאיבי,
  // לא נגד תוקף נחוש שמזייף כותרות ומחליף IP בכל בקשה. לרוב העסקים הקטנים זה מספיק.
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown";

  const windowStart = new Date();
  windowStart.setMinutes(0, 0, 0); // חלון של שעה עגולה, פשוט לניהול

  const { data: rateRow, error: rateError } = await supabase
    .rpc("increment_chat_rate_limit", {
      p_ip: clientIp,
      p_window_start: windowStart.toISOString(),
    });

  // Fail CLOSED, לא open: אם ה-RPC נכשל (בעיה זמנית ב-DB וכו') עדיף לחסום הודעה בודדת
  // מאשר לבטל בשקט את כל הגנת התקציב בלי שום איתות. rateError=null זה המצב התקין היחיד.
  if (rateError) {
    console.error("rate limit check failed:", rateError);
    return jsonResponse({ reply: "שגיאה זמנית, נסה שוב בעוד רגע." }, 500);
  }
  if (rateRow && rateRow > MAX_MESSAGES_PER_HOUR) {
    return jsonResponse(
      { reply: "עברת את מכסת ההודעות לשעה הזו. נסה שוב בעוד קצת, או פנה ישירות בוואטסאפ.", rateLimited: true },
      429
    );
  }

  const { conversationId, message, visitorName } = await req.json();
  if (!message || typeof message !== "string" || message.length > 2000) {
    return jsonResponse({ error: "invalid message" }, 400);
  }

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

  // ---- טעינת "מידע עדכני על העסק" מטבלת chat_knowledge ----
  // זו לא חיפוש וקטורי (RAG אמיתי) - זו טעינה מלאה של כל השורות הפעילות בכל בקשה.
  // מתאים לעסק קטן-בינוני (עד כ-100 שורות קצרות: שעות, מחירים, קטלוג בסיסי).
  // אם הקטלוג שלך גדול/משתנה הרבה (מאות פריטים, מלאי בזמן אמת) - זה לא יספיק,
  // תצטרך שכבת חיפוש אמיתית (pgvector / embeddings) שלא כלולה בסקיל הבסיסי הזה.
  const { data: knowledge } = await supabase
    .from("chat_knowledge")
    .select("topic, content")
    .eq("active", true)
    .order("topic", { ascending: true })
    .limit(100);

  const knowledgeBlock = (knowledge || [])
    .map((k) => `- ${k.topic}: ${k.content}`)
    .join("\n");

  const systemPrompt = knowledgeBlock
    ? `${SYSTEM_PROMPT_BASE}\n\nמידע עדכני על העסק:\n${knowledgeBlock}`
    : SYSTEM_PROMPT_BASE;

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
      system: systemPrompt,
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

  return jsonResponse({ reply, conversationId: convId, humanNeeded });
});
