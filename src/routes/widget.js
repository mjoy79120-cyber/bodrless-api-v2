/**
 * BODRLESS WIDGET
 * ─────────────────────────────────────────────────────────────
 * Embeddable chat widget for agency websites.
 * Agencies add one line of code to their site:
 * <script src="https://bodrless-api-v2.onrender.com/widget.js?key=AGENCY_KEY"></script>
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();

// ── GET /widget.js ───────────────────────────────────────────
// Returns the embeddable widget JavaScript
router.get('/', (req, res) => {
  const agencyKey = req.query.key || 'demo';
  const apiBase = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';

  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
(function() {
  // ── STYLES ──────────────────────────────────────────────
  var style = document.createElement('style');
  style.innerHTML = \`
    #bodrless-widget * { box-sizing: border-box; font-family: Arial, sans-serif; }
    #bodrless-bubble {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      width: 60px; height: 60px; border-radius: 50%;
      background: #1A1A2E; color: white; border: none;
      cursor: pointer; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      display: flex; align-items: center; justify-content: center;
      font-size: 28px; transition: transform 0.2s;
    }
    #bodrless-bubble:hover { transform: scale(1.1); }
    #bodrless-chat {
      position: fixed; bottom: 100px; right: 24px; z-index: 9999;
      width: 370px; height: 550px; border-radius: 16px;
      background: white; box-shadow: 0 8px 40px rgba(0,0,0,0.2);
      display: none; flex-direction: column; overflow: hidden;
    }
    #bodrless-chat.open { display: flex; }
    #bodrless-header {
      background: #1A1A2E; color: white; padding: 16px 20px;
      display: flex; align-items: center; justify-content: space-between;
    }
    #bodrless-header h3 { margin: 0; font-size: 15px; }
    #bodrless-header p { margin: 2px 0 0; font-size: 12px; opacity: 0.7; }
    #bodrless-close {
      background: none; border: none; color: white;
      font-size: 20px; cursor: pointer; padding: 0;
    }
    #bodrless-messages {
      flex: 1; overflow-y: auto; padding: 16px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .bodrless-msg {
      max-width: 85%; padding: 10px 14px;
      border-radius: 12px; font-size: 13px; line-height: 1.5;
    }
    .bodrless-msg.bot {
      background: #F5F7FA; color: #1E293B;
      border-radius: 12px 12px 12px 0;
      align-self: flex-start;
    }
    .bodrless-msg.user {
      background: #1A1A2E; color: white;
      border-radius: 12px 12px 0 12px;
      align-self: flex-end;
    }
    .bodrless-chips {
      display: flex; flex-wrap: wrap; gap: 8px;
      padding: 8px 16px;
    }
    .bodrless-chip {
      background: #F0F4FF; color: #1A1A2E;
      border: 1px solid #DDEEFF; border-radius: 20px;
      padding: 6px 12px; font-size: 12px; cursor: pointer;
      transition: background 0.2s;
    }
    .bodrless-chip:hover { background: #1A1A2E; color: white; }
    .bodrless-package {
      background: #F5F7FA; border-radius: 12px;
      padding: 12px; margin: 4px 0; font-size: 12px;
      border-left: 3px solid #E07B39;
    }
    .bodrless-package h4 { margin: 0 0 6px; color: #1A1A2E; font-size: 13px; }
    .bodrless-package p { margin: 3px 0; color: #64748B; }
    .bodrless-package .price { color: #E07B39; font-weight: bold; font-size: 14px; }
    .bodrless-book-btn {
      background: #E07B39; color: white; border: none;
      border-radius: 8px; padding: 8px 16px; font-size: 12px;
      cursor: pointer; margin-top: 8px; width: 100%;
    }
    #bodrless-input-area {
      padding: 12px 16px; border-top: 1px solid #E2E8F0;
      display: flex; gap: 8px;
    }
    #bodrless-input {
      flex: 1; border: 1px solid #E2E8F0; border-radius: 24px;
      padding: 10px 16px; font-size: 13px; outline: none;
    }
    #bodrless-input:focus { border-color: #1A1A2E; }
    #bodrless-send {
      background: #1A1A2E; color: white; border: none;
      border-radius: 50%; width: 40px; height: 40px;
      cursor: pointer; font-size: 16px; display: flex;
      align-items: center; justify-content: center;
    }
    #bodrless-typing {
      display: none; padding: 8px 16px;
      font-size: 12px; color: #64748B; font-style: italic;
    }
    .bodrless-powered {
      text-align: center; font-size: 10px; color: #94A3B8;
      padding: 4px; border-top: 1px solid #F1F5F9;
    }
  \`;
  document.head.appendChild(style);

  // ── HTML ────────────────────────────────────────────────
  var container = document.createElement('div');
  container.id = 'bodrless-widget';
  container.innerHTML = \`
    <button id="bodrless-bubble" title="Plan a trip instantly">✈️</button>
    <div id="bodrless-chat">
      <div id="bodrless-header">
        <div>
          <h3>Trip Planner</h3>
          <p>Powered by Bodrless</p>
        </div>
        <button id="bodrless-close">✕</button>
      </div>
      <div id="bodrless-messages"></div>
      <div id="bodrless-typing">Finding the best packages for you...</div>
      <div class="bodrless-chips" id="bodrless-chips">
        <div class="bodrless-chip">Zanzibar beach 5 nights</div>
        <div class="bodrless-chip">Safari Masai Mara</div>
        <div class="bodrless-chip">Mombasa weekend</div>
        <div class="bodrless-chip">Dubai 4 nights</div>
        <div class="bodrless-chip">Bangkok 7 nights</div>
      </div>
      <div id="bodrless-input-area">
        <input id="bodrless-input" type="text" placeholder="Where do you want to go?" />
        <button id="bodrless-send">➤</button>
      </div>
      <div class="bodrless-powered">Powered by Bodrless</div>
    </div>
  \`;
  document.body.appendChild(container);

  // ── LOGIC ───────────────────────────────────────────────
  var messages = document.getElementById('bodrless-messages');
  var input = document.getElementById('bodrless-input');
  var typing = document.getElementById('bodrless-typing');
  var chips = document.getElementById('bodrless-chips');
  var chat = document.getElementById('bodrless-chat');
  var bubble = document.getElementById('bodrless-bubble');

  // Toggle chat
  bubble.onclick = function() {
    chat.classList.toggle('open');
    if (chat.classList.contains('open') && messages.children.length === 0) {
      addMessage('bot', 'Hi! Tell me where you want to go and I will put together complete trip packages for you instantly. ✈️');
    }
  };

  document.getElementById('bodrless-close').onclick = function() {
    chat.classList.remove('open');
  };

  // Chips
  chips.querySelectorAll('.bodrless-chip').forEach(function(chip) {
    chip.onclick = function() {
      input.value = chip.textContent;
      sendMessage();
    };
  });

  // Send on enter
  input.onkeypress = function(e) {
    if (e.key === 'Enter') sendMessage();
  };

  document.getElementById('bodrless-send').onclick = sendMessage;

  function addMessage(type, text) {
    var msg = document.createElement('div');
    msg.className = 'bodrless-msg ' + type;
    msg.innerHTML = text;
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  function formatPackages(packages) {
    if (!packages || packages.length === 0) {
      return '<p>Sorry, no packages found. Try a different destination or dates.</p>';
    }
    return packages.map(function(pkg, i) {
      var labels = ['Best Value', 'Best Balance', 'Best Experience'];
      var transport = pkg.transport || {};
      var hotel = pkg.hotel || {};
      var summary = pkg.summary || {};
      return \`
        <div class="bodrless-package">
          <h4>✈️ Option \${i+1} — \${labels[i] || 'Package'}</h4>
          <p>🛫 \${transport.provider || 'Flight included'}</p>
          <p>🏨 \${hotel.name || 'Hotel included'} \${'⭐'.repeat(hotel.stars || 3)}</p>
          <p>🍽️ \${hotel.mealPlan || 'Meals included'}</p>
          <p>📅 \${summary.nights || 3} nights · \${summary.passengers || 2} guests</p>
          <p class="price">💰 $\${summary.pricePerPerson || summary.totalPrice || '---'} per person</p>
          <button class="bodrless-book-btn" onclick="alert('Booking flow coming soon! Contact us to complete your booking.')">Book This Package</button>
        </div>
      \`;
    }).join('');
  }

  function sendMessage() {
    var text = input.value.trim();
    if (!text) return;

    addMessage('user', text);
    input.value = '';
    chips.style.display = 'none';
    typing.style.display = 'block';
    messages.scrollTop = messages.scrollHeight;

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
        addMessage('bot', 'Here are the best packages I found for you:');
        var pkgDiv = document.createElement('div');
        pkgDiv.innerHTML = formatPackages(data.packages);
        messages.appendChild(pkgDiv);
        addMessage('bot', 'Would you like to add early check-in, airport transfer or any special requests?');
      } else {
        addMessage('bot', 'I could not find packages for that request. Could you add more details? For example: destination, number of people and budget.');
      }
      messages.scrollTop = messages.scrollHeight;
    })
    .catch(function() {
      typing.style.display = 'none';
      addMessage('bot', 'Something went wrong. Please try again in a moment.');
    });
  }
})();
  `);
});

module.exports = router;
