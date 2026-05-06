/**
 * BODRLESS WIDGET v2
 * ─────────────────────────────────────────────────────────────
 * Mobile friendly embeddable chat widget.
 * Two modes:
 * 1. Floating button — default
 * 2. Inline button — agency adds their own button with id="bodrless-trigger"
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

  // ── STYLES ──────────────────────────────────────────────
  var style = document.createElement('style');
  style.innerHTML = \`
    #bodrless-widget * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    /* ── TRIGGER BUTTON ── */
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
      transition: all 0.2s;
      letter-spacing: 0.3px;
    }
    #bodrless-trigger-btn:hover {
      background: #E07B39;
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(224,123,57,0.4);
    }
    #bodrless-trigger-btn span.icon { font-size: 20px; }

    /* ── OVERLAY (mobile fullscreen) ── */
    #bodrless-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 99998;
      backdrop-filter: blur(2px);
    }
    #bodrless-overlay.open { display: block; }

    /* ── CHAT PANEL ── */
    #bodrless-chat {
      display: none;
      position: fixed;
      z-index: 99999;
      background: white;
      flex-direction: column;
      overflow: hidden;

      /* Desktop */
      bottom: 24px;
      right: 24px;
      width: 390px;
      height: 580px;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.2);
    }
    #bodrless-chat.open { display: flex; }

    /* Mobile — fullscreen */
    @media (max-width: 480px) {
      #bodrless-chat {
        bottom: 0 !important;
        right: 0 !important;
        left: 0 !important;
        width: 100% !important;
        height: 92vh !important;
        border-radius: 20px 20px 0 0 !important;
      }
    }

    /* ── HEADER ── */
    #bodrless-header {
      background: linear-gradient(135deg, #1A1A2E 0%, #2E3A5C 100%);
      color: white;
      padding: 18px 20px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    #bodrless-header-left { display: flex; align-items: center; gap: 12px; }
    #bodrless-header-icon {
      width: 40px; height: 40px;
      background: rgba(255,255,255,0.15);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
    }
    #bodrless-header h3 { margin: 0; font-size: 15px; font-weight: 700; }
    #bodrless-header p { margin: 2px 0 0; font-size: 12px; opacity: 0.7; }
    #bodrless-close {
      background: rgba(255,255,255,0.15);
      border: none; color: white;
      width: 32px; height: 32px;
      border-radius: 50%; cursor: pointer;
      font-size: 16px; display: flex;
      align-items: center; justify-content: center;
      transition: background 0.2s;
    }
    #bodrless-close:hover { background: rgba(255,255,255,0.3); }

    /* ── STATUS BAR ── */
    #bodrless-status {
      background: #E07B39;
      color: white;
      text-align: center;
      font-size: 12px;
      padding: 6px;
      flex-shrink: 0;
    }

    /* ── MESSAGES ── */
    #bodrless-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      -webkit-overflow-scrolling: touch;
    }

    .b-msg {
      max-width: 88%;
      padding: 11px 14px;
      border-radius: 16px;
      font-size: 13.5px;
      line-height: 1.5;
      animation: fadeIn 0.2s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    .b-msg.bot {
      background: #F5F7FA;
      color: #1E293B;
      border-radius: 4px 16px 16px 16px;
      align-self: flex-start;
    }
    .b-msg.user {
      background: #1A1A2E;
      color: white;
      border-radius: 16px 4px 16px 16px;
      align-self: flex-end;
    }

    /* ── PACKAGE CARDS ── */
    .b-package {
      background: white;
      border: 1px solid #E2E8F0;
      border-radius: 14px;
      padding: 14px;
      margin: 4px 0;
      width: 100%;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    .b-package-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .b-package-label {
      background: #1A1A2E;
      color: white;
      font-size: 10px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 20px;
      letter-spacing: 0.5px;
    }
    .b-package-price {
      color: #E07B39;
      font-weight: 800;
      font-size: 16px;
    }
    .b-package-price span {
      font-size: 11px;
      color: #94A3B8;
      font-weight: 400;
    }
    .b-package-detail {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      color: #475569;
      margin: 5px 0;
    }
    .b-package-detail .icon { font-size: 14px; }
    .b-book-btn {
      width: 100%;
      background: linear-gradient(135deg, #E07B39, #C8611F);
      color: white;
      border: none;
      border-radius: 10px;
      padding: 11px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 10px;
      transition: opacity 0.2s;
    }
    .b-book-btn:hover { opacity: 0.9; }

    /* ── CHIPS ── */
    #bodrless-chips {
      padding: 8px 12px 4px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      flex-shrink: 0;
    }
    .b-chip {
      background: #F0F4FF;
      color: #1A1A2E;
      border: 1px solid #DDEEFF;
      border-radius: 20px;
      padding: 7px 13px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .b-chip:hover { background: #1A1A2E; color: white; border-color: #1A1A2E; }

    /* ── TYPING ── */
    #bodrless-typing {
      display: none;
      padding: 10px 16px;
      align-self: flex-start;
      flex-shrink: 0;
    }
    .b-typing-dots {
      display: flex; gap: 4px; align-items: center;
      background: #F5F7FA;
      padding: 10px 14px;
      border-radius: 16px;
    }
    .b-typing-dots span {
      width: 7px; height: 7px;
      background: #94A3B8;
      border-radius: 50%;
      animation: bounce 1.2s infinite;
    }
    .b-typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .b-typing-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-6px); }
    }

    /* ── INPUT ── */
    #bodrless-input-area {
      padding: 12px 14px;
      border-top: 1px solid #F1F5F9;
      display: flex;
      gap: 8px;
      align-items: center;
      flex-shrink: 0;
      background: white;
    }
    #bodrless-input {
      flex: 1;
      border: 1.5px solid #E2E8F0;
      border-radius: 24px;
      padding: 11px 18px;
      font-size: 13.5px;
      outline: none;
      transition: border-color 0.2s;
      background: #FAFAFA;
    }
    #bodrless-input:focus {
      border-color: #1A1A2E;
      background: white;
    }
    #bodrless-input::placeholder { color: #94A3B8; }
    #bodrless-send {
      background: #1A1A2E;
      color: white;
      border: none;
      border-radius: 50%;
      width: 42px;
      height: 42px;
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.2s;
    }
    #bodrless-send:hover { background: #E07B39; }

    /* ── FOOTER ── */
    .b-powered {
      text-align: center;
      font-size: 10px;
      color: #CBD5E1;
      padding: 6px;
      flex-shrink: 0;
    }
    .b-powered a {
      color: #94A3B8;
      text-decoration: none;
    }
  \`;
  document.head.appendChild(style);

  // ── HTML ────────────────────────────────────────────────
  var container = document.createElement('div');
  container.id = 'bodrless-widget';
  container.innerHTML = \`
    <div id="bodrless-overlay"></div>

    <div id="bodrless-chat">
      <div id="bodrless-header">
        <div id="bodrless-header-left">
          <div id="bodrless-header-icon">✈️</div>
          <div>
            <h3>Plan Your Trip</h3>
            <p>Instant packages · No forms</p>
          </div>
        </div>
        <button id="bodrless-close">✕</button>
      </div>

      <div id="bodrless-status">
        ⚡ Packages ready in seconds — just type where you want to go
      </div>

      <div id="bodrless-messages"></div>

      <div id="bodrless-typing">
        <div class="b-typing-dots">
          <span></span><span></span><span></span>
        </div>
      </div>

      <div id="bodrless-chips">
        <div class="b-chip">🏖️ Zanzibar beach</div>
        <div class="b-chip">🦁 Safari Mara</div>
        <div class="b-chip">🌴 Mombasa</div>
        <div class="b-chip">✈️ Dubai</div>
        <div class="b-chip">🗼 Bangkok</div>
        <div class="b-chip">🏙️ London</div>
      </div>

      <div id="bodrless-input-area">
        <input
          id="bodrless-input"
          type="text"
          placeholder="Type your destination, budget, dates..."
          autocomplete="off"
        />
        <button id="bodrless-send">➤</button>
      </div>

      <div class="b-powered">
        Powered by <a href="https://bodrless.co" target="_blank">Bodrless</a>
      </div>
    </div>
  \`;
  document.body.appendChild(container);

  // ── DEFAULT FLOATING BUTTON (if no custom trigger exists) ──
  var existingTrigger = document.getElementById('bodrless-trigger');
  if (!existingTrigger) {
    var floatBtn = document.createElement('button');
    floatBtn.id = 'bodrless-trigger-btn';
    floatBtn.innerHTML = '<span class="icon">✈️</span> Start Planning Your Trip';
    floatBtn.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99997;';
    document.body.appendChild(floatBtn);
    floatBtn.onclick = openChat;
  } else {
    existingTrigger.onclick = openChat;
  }

  // ── LOGIC ───────────────────────────────────────────────
  var messages = document.getElementById('bodrless-messages');
  var input = document.getElementById('bodrless-input');
  var typing = document.getElementById('bodrless-typing');
  var chips = document.getElementById('bodrless-chips');
  var chat = document.getElementById('bodrless-chat');
  var overlay = document.getElementById('bodrless-overlay');
  var opened = false;

  function openChat() {
    chat.classList.add('open');
    overlay.classList.add('open');
    input.focus();
    if (!opened) {
      opened = true;
      setTimeout(function() {
        addBotMessage('👋 Hi! I can put together a complete trip for you in seconds.');
        setTimeout(function() {
          addBotMessage('Just tell me where you want to go, how many people and your budget. Or tap one of the options below to get started. 👇');
        }, 600);
      }, 300);
    }
  }

  function closeChat() {
    chat.classList.remove('open');
    overlay.classList.remove('open');
  }

  document.getElementById('bodrless-close').onclick = closeChat;
  overlay.onclick = closeChat;

  // Chips
  chips.querySelectorAll('.b-chip').forEach(function(chip) {
    chip.onclick = function() {
      var text = chip.textContent.replace(/[🏖️🦁🌴✈️🗼🏙️]/g, '').trim();
      input.value = text;
      sendMessage();
    };
  });

  input.onkeypress = function(e) {
    if (e.key === 'Enter') sendMessage();
  };
  document.getElementById('bodrless-send').onclick = sendMessage;

  function addBotMessage(text) {
    var msg = document.createElement('div');
    msg.className = 'b-msg bot';
    msg.innerHTML = text;
    messages.appendChild(msg);
    scrollBottom();
  }

  function addUserMessage(text) {
    var msg = document.createElement('div');
    msg.className = 'b-msg user';
    msg.textContent = text;
    messages.appendChild(msg);
    scrollBottom();
  }

  function scrollBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function formatPackages(packages) {
    var labels = ['Best Value', 'Best Balance', 'Best Experience'];
    var html = '';
    packages.slice(0, 3).forEach(function(pkg, i) {
      var transport = pkg.transport || {};
      var hotel = pkg.hotel || {};
      var summary = pkg.summary || {};
      var price = summary.pricePerPerson || summary.totalPrice || 0;
      html += \`
        <div class="b-package">
          <div class="b-package-header">
            <div class="b-package-label">\${labels[i] || 'Package ' + (i+1)}</div>
            <div class="b-package-price">$\${Math.round(price)} <span>per person</span></div>
          </div>
          <div class="b-package-detail"><span class="icon">✈️</span> \${transport.providerName || transport.provider || 'Flight included'}</div>
          <div class="b-package-detail"><span class="icon">🏨</span> \${hotel.name || 'Hotel included'} ${'⭐'.repeat(Math.min(hotel.stars || 3, 5))}</div>
          <div class="b-package-detail"><span class="icon">🍽️</span> \${hotel.mealPlan || 'Meals included'}</div>
          <div class="b-package-detail"><span class="icon">📅</span> \${summary.nights || 3} nights · \${summary.passengers || 2} guests</div>
          <div class="b-package-detail"><span class="icon">🚗</span> Airport transfer included</div>
          <button class="b-book-btn" onclick="alert('Thank you for your interest! Our agent will contact you shortly to complete your booking.')">
            Book This Package →
          </button>
        </div>
      \`;
    });
    return html;
  }

  function sendMessage() {
    var text = input.value.trim();
    if (!text) return;

    addUserMessage(text);
    input.value = '';
    chips.style.display = 'none';
    typing.style.display = 'block';
    scrollBottom();

    fetch('${apiBase}/api/trips/orchestrate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': '${agencyKey}'
      },
      body: JSON.stringify({
        prompt: text,
        agencyId: '${agencyKey}',
        channelType: 'widget'
      })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      typing.style.display = 'none';

      if (data.packages && data.packages.length > 0) {
        addBotMessage('Here are the best packages I found for you 🎉');

        var pkgContainer = document.createElement('div');
        pkgContainer.style.cssText = 'display:flex;flex-direction:column;gap:10px;width:100%;';
        pkgContainer.innerHTML = formatPackages(data.packages);
        messages.appendChild(pkgContainer);

        setTimeout(function() {
          addBotMessage('Would you like to add early check-in, airport transfer or any special requests? Just ask! 😊');
        }, 500);
      } else {
        addBotMessage('I could not find packages for that. Could you add more details? Try something like: <b>"Nairobi to Zanzibar, 2 people, mid budget, 5 nights"</b>');
      }
      scrollBottom();
    })
    .catch(function() {
      typing.style.display = 'none';
      addBotMessage('Something went wrong. Please try again in a moment. 🙏');
    });
  }

})();
  `);
});

module.exports = router;
