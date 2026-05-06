router.get('/', (req, res) => {
  const agencyKey = req.query.key || 'bodrless-test-key';
  const agencyName = req.query.name || 'Your Travel Agent';
  const apiBase = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';

  res.setHeader('Content-Type', 'application/javascript');

  res.send(`
(function () {

  console.log("[BODRLESS] widget loading...");

  function initWidget() {

    if (!document.body) {
      console.log("[BODRLESS] body not ready, retrying...");
      setTimeout(initWidget, 50);
      return;
    }

    // prevent double init
    if (document.getElementById("bodrless-widget")) return;

    // ── STYLE ───────────────────────────────
    var style = document.createElement('style');
    style.innerHTML = \`
      #bodrless-widget * {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, Arial;
      }

      #bodrless-chat {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 380px;
        height: 560px;
        background: #fff;
        border-radius: 16px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        display: none;
        flex-direction: column;
        z-index: 999999;
        overflow: hidden;
      }

      #bodrless-chat.open { display: flex; }

      #bodrless-trigger-btn {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 999998;
        background: #1A1A2E;
        color: white;
        border: none;
        border-radius: 999px;
        padding: 14px 20px;
        cursor: pointer;
      }

      #bodrless-messages {
        flex: 1;
        overflow-y: auto;
        padding: 12px;
      }

      .msg { margin: 8px 0; padding: 10px; border-radius: 10px; max-width: 85%; }
      .bot { background: #f1f1f1; }
      .user { background: #1A1A2E; color: white; margin-left: auto; }
    \`;
    document.head.appendChild(style);

    // ── HTML ───────────────────────────────
    var root = document.createElement("div");
    root.id = "bodrless-widget";
    root.innerHTML = \`
      <div id="bodrless-chat">
        <div style="padding:12px;background:#1A1A2E;color:white">
          ${agencyName}
        </div>

        <div id="bodrless-messages"></div>

        <div style="display:flex;border-top:1px solid #eee">
          <input id="bodrless-input" style="flex:1;padding:10px;border:none" placeholder="Type..." />
          <button id="bodrless-send">➤</button>
        </div>
      </div>
    \`;

    document.body.appendChild(root);

    var chat = document.getElementById("bodrless-chat");
    var input = document.getElementById("bodrless-input");
    var messages = document.getElementById("bodrless-messages");

    function openChat() {
      chat.classList.add("open");
    }

    function closeChat() {
      chat.classList.remove("open");
    }

    // ── FLOATING BUTTON ALWAYS SHOWS ──
    var btn = document.createElement("button");
    btn.id = "bodrless-trigger-btn";
    btn.innerText = "Plan Your Trip ✈️";
    document.body.appendChild(btn);

    btn.onclick = openChat;

    console.log("[BODRLESS] floating button mounted");

    // optional inline trigger
    var inline = document.getElementById("bodrless-trigger");
    if (inline) inline.onclick = openChat;

    document.getElementById("bodrless-send").onclick = send;

    function addMsg(text, type) {
      var div = document.createElement("div");
      div.className = "msg " + type;
      div.innerText = text;
      messages.appendChild(div);
    }

    function send() {
      var text = input.value.trim();
      if (!text) return;

      addMsg(text, "user");
      input.value = "";

      fetch("${apiBase}/api/trips/orchestrate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "${agencyKey}"
        },
        body: JSON.stringify({ prompt: text })
      })
      .then(r => r.json())
      .then(data => {
        addMsg("Got it — building your trip...", "bot");
      })
      .catch(() => addMsg("Error connecting", "bot"));
    }

  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initWidget);
  } else {
    initWidget();
  }

})();
  `);
});
