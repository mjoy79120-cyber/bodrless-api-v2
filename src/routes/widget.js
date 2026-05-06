const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const agencyKey = req.query.key || 'bodrless-test-key';
  const agencyName = req.query.name || 'Your Travel Agent';
  const apiBase = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';

  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
(function() {

  var style = document.createElement('style');
  style.innerHTML = \`
    #bodrless-widget * { box-sizing: border-box; font-family: -apple-system, Arial; }

    #bodrless-chat {
      display:none; position:fixed; z-index:99999;
      bottom:24px; right:24px; width:390px; height:580px;
      background:white; border-radius:20px;
      box-shadow:0 20px 60px rgba(0,0,0,0.2);
      flex-direction:column; overflow:hidden;
    }
    #bodrless-chat.open { display:flex; }

    @media (max-width:480px){
      #bodrless-chat { width:100%; height:92vh; bottom:0; right:0; left:0; }
    }

    #bodrless-header {
      background:#1A1A2E; color:white;
      padding:16px; display:flex;
      justify-content:space-between; align-items:center;
    }
    #bodrless-header h3 { margin:0; font-size:15px; }
    #bodrless-header p { margin:2px 0 0; font-size:12px; opacity:0.7; }

    #bodrless-messages {
      flex:1; overflow-y:auto; padding:16px;
      display:flex; flex-direction:column; gap:10px;
    }

    .b-msg { max-width:85%; padding:10px 14px; border-radius:14px; font-size:13px; }
    .b-msg.bot { background:#F5F7FA; }
    .b-msg.user { background:#1A1A2E; color:white; align-self:flex-end; }

    .b-package {
      border:1px solid #E2E8F0;
      border-radius:12px; padding:12px;
    }

    .b-book-btn {
      width:100%; margin-top:10px;
      background:#E07B39; color:white;
      border:none; border-radius:8px;
      padding:10px; cursor:pointer;
    }

    #bodrless-input-area {
      padding:12px; border-top:1px solid #eee;
      display:flex; gap:8px;
    }
    #bodrless-input {
      flex:1; padding:10px; border-radius:20px;
      border:1px solid #ddd;
    }
    #bodrless-send {
      background:#1A1A2E; color:white;
      border:none; border-radius:50%;
      width:40px; height:40px; cursor:pointer;
    }

    #bodrless-trigger-btn {
      position:fixed; bottom:24px; right:24px;
      background:#1A1A2E; color:white;
      border:none; border-radius:50px;
      padding:12px 20px; cursor:pointer;
      z-index:99997;
    }
  \`;
  document.head.appendChild(style);

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
  document.body.appendChild(container);

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

  // Trigger logic (SAFE)
  var existingTrigger = document.getElementById('bodrless-trigger');
  if (existingTrigger) {
    existingTrigger.addEventListener('click', openChat);
  } else {
    var btn = document.createElement('button');
    btn.id = 'bodrless-trigger-btn';
    btn.innerText = 'Plan Your Trip ✈️';
    document.body.appendChild(btn);
    btn.onclick = openChat;
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
          div.className = 'b-package';
          div.innerHTML = \`
            <div><b>\${pkg.hotel?.name || 'Hotel'}</b></div>
            <div>$\${pkg.summary?.pricePerPerson || ''} per person</div>
            <button class="b-book-btn">Book via WhatsApp</button>
          \`;

          div.querySelector('.b-book-btn').onclick = function() {
            window.open('https://wa.me/', '_blank');
          };

          messages.appendChild(div);
        });
      } else {
        addMsg('bot', 'Try adding more details like destination and budget.');
      }
    })
    .catch(() => addMsg('bot','Something went wrong'));
  }

  document.getElementById('bodrless-send').onclick = sendMessage;
  input.onkeypress = e => { if (e.key === 'Enter') sendMessage(); };

})();
  `);
});

module.exports = router;
