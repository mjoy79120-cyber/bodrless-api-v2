/**
 * BODRLESS WIDGET v2 (FIXED)
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const agencyKey = req.query.key || 'bodrless-test-key';
  const agencyName = req.query.name || 'Your Travel Agent';
  const apiBase = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';

  res.setHeader('Content-Type', 'application/javascript');

  res.send(`
(function() {

  function initWidget() {

    // ── STYLES ──────────────────────────────────────────────
    var style = document.createElement('style');
    style.innerHTML = \`
      #bodrless-widget * {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      #bodrless-trigger-btn {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        background: #1A1A2E;
        color: white;
        border: none;
        border-radius: 50px;
        padding: 14px 28px;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 4px 20px rgba(26,26,46,0.3);
      }

      #bodrless-chat {
        display: none;
        position: fixed;
        z-index: 99999;
        background: white;
        flex-direction: column;
        overflow: hidden;
        bottom: 24px;
        right: 24px;
        width: 390px;
        height: 580px;
        border-radius: 20px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      }

      #bodrless-chat.open { display: flex; }

      @media (max-width: 480px) {
        #bodrless-chat {
          bottom: 0;
          right: 0;
          left: 0;
          width: 100%;
          height: 92vh;
          border-radius: 20px 20px 0 0;
        }
      }

      #bodrless-header {
        background: #1A1A2E;
        color: white;
        padding: 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      #bodrless-messages {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .b-msg {
        max-width: 85%;
        padding: 10px 14px;
        border-radius: 14px;
        font-size: 13px;
      }

      .b-msg.user {
        background: #1A1A2E;
        color: white;
        align-self: flex-end;
      }

      .b-msg.bot {
        background: #F5F7FA;
      }

      #bodrless-input-area {
        padding: 12px;
        border-top: 1px solid #eee;
        display: flex;
        gap: 8px;
      }

      #bodrless-input {
        flex: 1;
        padding: 10px;
        border-radius: 20px;
        border: 1px solid #ddd;
      }

      #bodrless-send {
        background: #1A1A2E;
        color: white;
        border: none;
        border-radius: 50%;
        width: 40px;
        height: 40px;
      }
    \`;

    document.head.appendChild(style);

    // ── HTML ────────────────────────────────────────────────
    var container = document.createElement('div');
    container.id = 'bodrless-widget';

    container.innerHTML = \`
      <div id="bodrless-chat">
        <div id="bodrless-header">
          <div>
            <h3>\${agencyName}</h3>
            <p>Plan your trip instantly</p>
          </div>
          <button id="bodrless-close">✕</button>
        </div>

        <div id="bodrless-messages"></div>

        <div id="bodrless-input-area">
          <input id="bodrless-input" placeholder="Where do you want to go?" />
          <button id="bodrless-send">➤</button>
        </div>
      </div>
    \`;

    // ✅ FIX: safe mount
    function mountWidget() {
      if (!document.body) {
        return setTimeout(mountWidget, 50);
      }
      document.body.appendChild(container);
    }
    mountWidget();

    var chat = document.getElementById('bodrless-chat');
    var messages = document.getElementById('bodrless-messages');
    var input = document.getElementById('bodrless-input');

    function openChat() {
      chat.classList.add('open');
    }

    function closeChat() {
      chat.classList.remove('open');
    }

    document.getElementById('bodrless-close').onclick = closeChat;

    // ── SAFE TRIGGER FIX ──
    var existingTrigger = document.getElementById('bodrless-trigger');

    function mountButton(btn) {
      if (!document.body) {
        return setTimeout(() => mountButton(btn), 50);
      }
      document.body.appendChild(btn);
    }

    if (existingTrigger) {
      existingTrigger.addEventListener('click', openChat);
    } else {
      var btn = document.createElement('button');
      btn.id = 'bodrless-trigger-btn';
      btn.innerText = 'Plan Your Trip ✈️';

      mountButton(btn);

      btn.addEventListener('click', openChat);
    }

    function addMsg(type, text) {
      var div = document.createElement('div');
      div.className = 'b-msg ' + type;
      div.innerHTML = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function sendMessage() {
      var text = input.value.trim();
      if (!text) return;

      addMsg('user', text);
      input.value = '';

      fetch('${apiBase}/api/trips/orchestrate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': '${agencyKey}'
        },
        body: JSON.stringify({ prompt: text })
      })
      .then(res => res.json())
      .then(data => {
        if (data.packages) {
          data.packages.slice(0,3).forEach(pkg => {
            var div = document.createElement('div');
            div.className = 'b-msg bot';
            div.innerHTML = '<b>' + (pkg.hotel?.name || 'Hotel') + '</b>';
            messages.appendChild(div);
          });
        } else {
          addMsg('bot','Try adding more details.');
        }
      })
      .catch(() => addMsg('bot','Something went wrong'));
    }

    document.getElementById('bodrless-send').onclick = sendMessage;
    input.onkeypress = e => { if (e.key === 'Enter') sendMessage(); };

  }

  initWidget();

})();
  `);
});

module.exports = router;
