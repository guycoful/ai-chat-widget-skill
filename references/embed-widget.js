(function () {
  "use strict";

  var cfg = window.AIChatConfig || {};
  var EDGE_FN_URL = cfg.edgeFnUrl || "";
  var BUSINESS_NAME = cfg.businessName || "שירות לקוחות";
  var GREETING = cfg.greeting || "היי! איך אפשר לעזור ?";
  var TEASER = cfg.teaser || "יש לך שאלה ?";
  var PRIMARY_COLOR = cfg.primaryColor || "#2563eb";
  var STORAGE_KEY = "aicw_conversation_id";

  // ---- State ----
  var conversationId = localStorage.getItem(STORAGE_KEY) || null;
  var isOpen = false;
  var isTeaserVisible = true;
  var pollInterval = null;
  var lastMessageCount = 0;

  // ---- CSS injection ----
  var style = document.createElement("style");
  style.textContent = [
    ".aicw-bubble{position:fixed;bottom:24px;right:24px;z-index:99999;cursor:pointer;}",
    ".aicw-btn{width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,0.22);transition:transform .2s;background:" + PRIMARY_COLOR + ";}",
    ".aicw-btn:hover{transform:scale(1.08);}",
    ".aicw-btn svg{width:28px;height:28px;fill:#fff;}",
    ".aicw-teaser{position:absolute;bottom:66px;right:0;background:#fff;border:1px solid #e5e7eb;border-radius:12px 12px 4px 12px;padding:8px 14px;white-space:nowrap;font-size:14px;color:#374151;box-shadow:0 2px 8px rgba(0,0,0,0.10);direction:rtl;font-family:Arial,sans-serif;}",
    ".aicw-teaser-close{margin-left:8px;cursor:pointer;color:#9ca3af;font-size:13px;vertical-align:middle;}",
    ".aicw-window{position:fixed;bottom:96px;right:24px;width:340px;height:480px;background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.18);display:flex;flex-direction:column;z-index:99999;overflow:hidden;direction:rtl;font-family:Arial,sans-serif;}",
    ".aicw-header{padding:14px 16px;display:flex;align-items:center;justify-content:space-between;color:#fff;background:" + PRIMARY_COLOR + ";}",
    ".aicw-header-title{font-weight:bold;font-size:15px;}",
    ".aicw-header-close{background:none;border:none;color:#fff;cursor:pointer;font-size:20px;line-height:1;padding:0;}",
    ".aicw-messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f9fafb;}",
    ".aicw-msg{max-width:82%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.5;word-break:break-word;}",
    ".aicw-msg-ai{background:#fff;border:1px solid #e5e7eb;color:#1f2937;align-self:flex-end;border-bottom-right-radius:4px;}",
    ".aicw-msg-visitor{background:" + PRIMARY_COLOR + ";color:#fff;align-self:flex-start;border-bottom-left-radius:4px;}",
    ".aicw-typing{display:flex;gap:5px;padding:10px 13px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;border-bottom-right-radius:4px;align-self:flex-end;width:56px;}",
    ".aicw-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af;animation:aicw-bounce 1.2s infinite;}",
    ".aicw-dot:nth-child(2){animation-delay:.2s;}",
    ".aicw-dot:nth-child(3){animation-delay:.4s;}",
    "@keyframes aicw-bounce{0%,80%,100%{transform:translateY(0);}40%{transform:translateY(-7px);}}",
    ".aicw-input-row{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff;align-items:flex-end;}",
    ".aicw-input{flex:1;border:1px solid #d1d5db;border-radius:10px;padding:9px 12px;font-size:14px;resize:none;outline:none;direction:rtl;font-family:Arial,sans-serif;min-height:38px;max-height:100px;overflow-y:auto;}",
    ".aicw-input:focus{border-color:" + PRIMARY_COLOR + ";}",
    ".aicw-send{width:38px;height:38px;border-radius:50%;border:none;background:" + PRIMARY_COLOR + ";cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
    ".aicw-send:disabled{opacity:.5;cursor:default;}",
    ".aicw-send svg{width:18px;height:18px;fill:#fff;}",
    "@media(max-width:400px){.aicw-window{right:8px;left:8px;width:auto;bottom:88px;}}",
  ].join("");
  document.head.appendChild(style);

  // ---- DOM build ----
  var root = document.createElement("div");
  root.className = "aicw-bubble";

  // Teaser
  var teaser = document.createElement("div");
  teaser.className = "aicw-teaser";
  teaser.innerHTML = TEASER + '<span class="aicw-teaser-close" title="סגור">&#x2715;</span>';

  // Button
  var btn = document.createElement("button");
  btn.className = "aicw-btn";
  btn.setAttribute("aria-label", "פתח צ'אט");
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';

  root.appendChild(teaser);
  root.appendChild(btn);

  // Chat window
  var win = document.createElement("div");
  win.className = "aicw-window";
  win.style.display = "none";

  var header = document.createElement("div");
  header.className = "aicw-header";
  header.innerHTML = '<span class="aicw-header-title">' + escapeHtml(BUSINESS_NAME) + '</span>' +
    '<button class="aicw-header-close" aria-label="סגור">&#x2715;</button>';

  var messages = document.createElement("div");
  messages.className = "aicw-messages";

  var inputRow = document.createElement("div");
  inputRow.className = "aicw-input-row";

  var input = document.createElement("textarea");
  input.className = "aicw-input";
  input.placeholder = "כתוב הודעה...";
  input.rows = 1;

  var sendBtn = document.createElement("button");
  sendBtn.className = "aicw-send";
  sendBtn.setAttribute("aria-label", "שלח");
  sendBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';

  inputRow.appendChild(input);
  inputRow.appendChild(sendBtn);

  win.appendChild(header);
  win.appendChild(messages);
  win.appendChild(inputRow);

  document.body.appendChild(root);
  document.body.appendChild(win);

  // ---- Greeting message ----
  appendMessage("ai", GREETING);

  // ---- Helpers ----
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function appendMessage(role, text) {
    var msg = document.createElement("div");
    msg.className = "aicw-msg aicw-msg-" + role;
    msg.textContent = text;
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
    lastMessageCount++;
    return msg;
  }

  function showTyping() {
    var el = document.createElement("div");
    el.className = "aicw-typing";
    el.innerHTML = '<div class="aicw-dot"></div><div class="aicw-dot"></div><div class="aicw-dot"></div>';
    el.id = "aicw-typing-indicator";
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  function removeTyping() {
    var el = document.getElementById("aicw-typing-indicator");
    if (el) el.parentNode.removeChild(el);
  }

  function setSendDisabled(val) {
    sendBtn.disabled = val;
    input.disabled = val;
  }

  // ---- Send message ----
  function sendMessage() {
    var text = input.value.trim();
    if (!text || sendBtn.disabled) return;

    input.value = "";
    input.style.height = "";
    appendMessage("visitor", text);
    setSendDisabled(true);
    var typing = showTyping();

    var body = { message: text, visitorName: "אנונימי" };
    if (conversationId) body.conversationId = conversationId;

    fetch(EDGE_FN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        removeTyping();
        if (data.conversationId && !conversationId) {
          conversationId = data.conversationId;
          localStorage.setItem(STORAGE_KEY, conversationId);
        }
        appendMessage("ai", data.reply || "קיבלתי את הודעתך.");
        setSendDisabled(false);
        input.focus();
        startPolling();
      })
      .catch(function () {
        removeTyping();
        appendMessage("ai", "סליחה, הייתה שגיאה. תנסה שוב.");
        setSendDisabled(false);
      });
  }

  // ---- Polling for new messages ----
  function startPolling() {
    if (pollInterval || !conversationId) return;
    pollInterval = setInterval(fetchNewMessages, 10000);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function fetchNewMessages() {
    if (!conversationId) return;
    // Re-send empty ping to get latest — edge fn returns stored history
    // Lightweight: just refetch last message via a GET to avoid duplicate inserts
    // We use a separate lightweight endpoint convention: query param mode
    fetch(EDGE_FN_URL + "?conversationId=" + conversationId + "&poll=1", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.messages) return;
        var newMsgs = data.messages.slice(lastMessageCount - 1); // offset by greeting
        newMsgs.forEach(function (m) {
          if (m.role === "ai" || m.role === "admin") {
            appendMessage("ai", m.content);
          }
        });
      })
      .catch(function () { /* silent polling failure */ });
  }

  // ---- Toggle open/close ----
  function openChat() {
    isOpen = true;
    win.style.display = "flex";
    teaser.style.display = "none";
    isTeaserVisible = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    input.focus();
    if (conversationId) startPolling();
  }

  function closeChat() {
    isOpen = false;
    win.style.display = "none";
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';
    stopPolling();
  }

  // ---- Events ----
  btn.addEventListener("click", function () {
    if (isOpen) closeChat(); else openChat();
  });

  header.querySelector(".aicw-header-close").addEventListener("click", function (e) {
    e.stopPropagation();
    closeChat();
  });

  teaser.querySelector(".aicw-teaser-close").addEventListener("click", function (e) {
    e.stopPropagation();
    teaser.style.display = "none";
    isTeaserVisible = false;
  });

  sendBtn.addEventListener("click", sendMessage);

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  input.addEventListener("input", function () {
    this.style.height = "";
    this.style.height = Math.min(this.scrollHeight, 100) + "px";
  });

  // Auto-hide teaser after 8 seconds
  setTimeout(function () {
    if (isTeaserVisible && !isOpen) {
      teaser.style.display = "none";
    }
  }, 8000);

})();
