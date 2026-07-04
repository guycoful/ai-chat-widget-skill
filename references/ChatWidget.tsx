import { useState, useEffect, useRef, useCallback } from "react";
import { MessageCircle, X, Send, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

const EDGE_FN_URL =
  "https://vuvavjmbvdqnwtleudqh.supabase.co/functions/v1/chat-respond";

const LS_CONV_KEY = "chat_conversation_id";
const LS_NAME_KEY = "chat_visitor_name";

type Message = {
  id: string;
  role: "visitor" | "ai" | "admin";
  content: string;
  created_at: string;
};

const ChatWidget = () => {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(() =>
    localStorage.getItem(LS_CONV_KEY)
  );
  const [visitorName, setVisitorName] = useState<string>(
    () => localStorage.getItem(LS_NAME_KEY) || ""
  );
  const [humanNeeded, setHumanNeeded] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [greeted, setGreeted] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSeenCountRef = useRef(0);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  // Show greeting when first opened
  useEffect(() => {
    if (open && !greeted && messages.length === 0) {
      setMessages([
        {
          id: "greeting",
          role: "ai",
          content: "היי! אני העוזר הדיגיטלי של גיא כהן. איך אפשר לעזור?",
          created_at: new Date().toISOString(),
        },
      ]);
      setGreeted(true);
    }
  }, [open, greeted, messages.length]);

  // Load existing messages if we have a conversationId
  useEffect(() => {
    if (!conversationId) return;

    const loadMessages = async () => {
      const { data, error } = await supabase
        .from("chat_messages" as any)
        .select("id, role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (!error && data && (data as any[]).length > 0) {
        const loaded = (data as any[]).map((m: any) => ({
          id: m.id,
          role: m.role as Message["role"],
          content: m.content,
          created_at: m.created_at,
        }));
        setMessages(loaded);
        setGreeted(true);
        lastSeenCountRef.current = loaded.length;
      }
    };

    loadMessages();
  }, [conversationId]);

  // Poll for new admin messages every 10 seconds
  useEffect(() => {
    if (!conversationId) return;

    const poll = setInterval(async () => {
      const { data, error } = await supabase
        .from("chat_messages" as any)
        .select("id, role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (!error && data) {
        const fetched = (data as any[]).map((m: any) => ({
          id: m.id,
          role: m.role as Message["role"],
          content: m.content,
          created_at: m.created_at,
        }));

        if (fetched.length > lastSeenCountRef.current) {
          setMessages(fetched);

          // Count new admin messages since last seen
          if (!open) {
            const newAdminMsgs = fetched
              .slice(lastSeenCountRef.current)
              .filter((m) => m.role === "admin");
            if (newAdminMsgs.length > 0) {
              setUnreadCount((prev) => prev + newAdminMsgs.length);
            }
          }

          lastSeenCountRef.current = fetched.length;
        }
      }
    }, 10000);

    return () => clearInterval(poll);
  }, [conversationId, open]);

  // Clear unread when opening
  useEffect(() => {
    if (open) {
      setUnreadCount(0);
    }
  }, [open]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setInput("");

    // Optimistically add visitor message
    const optimisticMsg: Message = {
      id: `temp-${Date.now()}`,
      role: "visitor",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const res = await fetch(EDGE_FN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          message: text,
          visitorName: visitorName || "אנונימי",
        }),
      });

      if (!res.ok) throw new Error("Edge function error");

      const json = await res.json();

      // Persist conversationId
      if (json.conversationId && json.conversationId !== conversationId) {
        setConversationId(json.conversationId);
        localStorage.setItem(LS_CONV_KEY, json.conversationId);
      }

      if (visitorName) {
        localStorage.setItem(LS_NAME_KEY, visitorName);
      }

      // Add AI reply
      if (json.reply) {
        const aiMsg: Message = {
          id: `ai-${Date.now()}`,
          role: "ai",
          content: json.reply,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, aiMsg]);
        lastSeenCountRef.current += 2; // visitor + ai
      }

      if (json.humanNeeded) {
        setHumanNeeded(true);
      }
    } catch {
      // Show error message
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "ai",
          content: "סליחה, משהו השתבש. נסו שוב בעוד רגע.",
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }, [input, sending, conversationId, visitorName]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString("he-IL", {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  };

  const [teaserDismissed, setTeaserDismissed] = useState(false);

  // Closed state - bubble + teaser
  if (!open) {
    return (
      <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
        {/* Teaser bubble */}
        {!teaserDismissed && (
          <div className="relative bg-white rounded-2xl rounded-br-sm shadow-lg px-4 py-3 max-w-[220px] text-right animate-fade-in">
            <button
              onClick={(e) => { e.stopPropagation(); setTeaserDismissed(true); }}
              className="absolute top-1 left-1 w-5 h-5 rounded-full bg-gray-200 hover:bg-gray-300 flex items-center justify-center transition-colors"
              aria-label="סגור"
            >
              <X className="w-3 h-3 text-gray-500" />
            </button>
            <p className="text-gray-800 text-sm font-heebo leading-relaxed">
              היי! יש לך שאלה על שירותי AI לעסקים ?
            </p>
          </div>
        )}

        {/* Chat button */}
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 bg-blue-primary text-white rounded-full pl-4 pr-3 py-3 shadow-lg hover:bg-blue-primary/90 transition-all duration-200"
          aria-label="פתח צ'אט"
        >
          {unreadCount > 0 && (
            <span className="w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center font-bold">
              {unreadCount}
            </span>
          )}
          <span className="text-sm font-heebo font-medium">שוחחו עם גיא</span>
          <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center">
            <MessageCircle className="w-5 h-5 text-white" />
          </div>
        </button>
      </div>
    );
  }

  // Open state - chat window
  return (
    <div
      dir="rtl"
      className="fixed bottom-4 right-4 z-50 w-80 sm:w-96 h-[500px] flex flex-col rounded-xl overflow-hidden shadow-2xl border border-purple-700/20"
    >
      {/* Header */}
      <div className="bg-navy-dark px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-blue-primary flex items-center justify-center">
            <MessageCircle className="w-4 h-4 text-white" />
          </div>
          <div>
            <h3 className="text-white font-medium text-sm font-heebo">
              Guy Cohen AI
            </h3>
            <p className="text-gray-400 text-xs">עוזר דיגיטלי</p>
          </div>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-gray-400 hover:text-white transition-colors p-1"
          aria-label="סגור צ'אט"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Human needed badge */}
      {humanNeeded && (
        <div className="bg-purple-700/20 px-4 py-2 text-center shrink-0">
          <p className="text-purple-300 text-xs font-heebo">
            גיא יחזור אליך בקרוב
          </p>
        </div>
      )}

      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-navy-dark/95 px-3 py-4 space-y-3"
      >
        {messages.map((msg) => {
          const isVisitor = msg.role === "visitor";
          const isAdmin = msg.role === "admin";

          return (
            <div
              key={msg.id}
              className={cn(
                "flex",
                isVisitor ? "justify-start" : "justify-end"
              )}
            >
              <div
                className={cn(
                  "max-w-[80%] rounded-xl px-3 py-2 text-sm font-heebo",
                  isVisitor &&
                    "bg-blue-primary text-white rounded-br-sm",
                  !isVisitor &&
                    !isAdmin &&
                    "bg-navy-light text-gray-100 rounded-bl-sm",
                  isAdmin &&
                    "bg-green-700/30 text-green-100 rounded-bl-sm border border-green-600/30"
                )}
              >
                {isAdmin && (
                  <span className="text-[10px] text-green-400 font-medium block mb-0.5">
                    גיא
                  </span>
                )}
                <p className="whitespace-pre-wrap leading-relaxed">
                  {msg.content}
                </p>
                <span
                  className={cn(
                    "text-[10px] mt-1 block",
                    isVisitor ? "text-blue-200/60" : "text-gray-500"
                  )}
                >
                  {formatTime(msg.created_at)}
                </span>
              </div>
            </div>
          );
        })}

        {/* Typing indicator */}
        {sending && (
          <div className="flex justify-end">
            <div className="bg-navy-light rounded-xl px-4 py-3 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:0ms]" />
              <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:150ms]" />
              <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        )}
      </div>

      {/* Name input (shown once before first message) */}
      {!conversationId && messages.length <= 1 && (
        <div className="bg-navy-dark border-t border-purple-700/20 px-3 py-2 shrink-0">
          <input
            type="text"
            value={visitorName}
            onChange={(e) => setVisitorName(e.target.value)}
            placeholder="השם שלך (לא חובה)"
            className="w-full bg-navy-light/50 border border-purple-700/20 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:border-blue-primary/50 font-heebo"
          />
        </div>
      )}

      {/* Input bar */}
      <div className="bg-navy-dark border-t border-purple-700/20 px-3 py-2 flex items-center gap-2 shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="כתבו הודעה..."
          disabled={sending}
          className="flex-1 bg-navy-light/50 border border-purple-700/20 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:border-blue-primary/50 font-heebo disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || sending}
          className={cn(
            "w-9 h-9 rounded-lg flex items-center justify-center transition-colors shrink-0",
            input.trim() && !sending
              ? "bg-blue-primary text-white hover:bg-blue-primary/90"
              : "bg-navy-light/50 text-gray-500 cursor-not-allowed"
          )}
          aria-label="שלח הודעה"
        >
          {sending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4 rotate-180" />
          )}
        </button>
      </div>
    </div>
  );
};

export default ChatWidget;
