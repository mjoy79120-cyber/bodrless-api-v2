const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const agencyKey = req.query.key || 'epic-travels';
  const agencyName = req.query.name || 'Epic Travels';
  const apiBase = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';

  res.setHeader('Content-Type', 'application/javascript');

  res.send(`
(function () {

  function initWidget() {

    if (!document.body) {
      setTimeout(initWidget, 50);
      return;
    }

    if (document.getElementById("bodrless-widget-root")) return;

    // ───── STYLE ─────
    const style = document.createElement("style");
    style.innerHTML = \`
      #bodrless-chat {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 380px;
        height: 560px;
        background: #fff;
        z-index: 999999;
        display: none;
        flex-direction: column;
        border-radius: 14px;
        overflow: hidden;
        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        font-family: Arial;
      }

      #bodrless-chat.open { display: flex; }

      #bodrless-trigger {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999998;
        background: #1A1A2E;
        color: white;
        border: none;
        padding: 12px 18px;
        border-radius: 999px;
        cursor: pointer;
      }

      #bodrless-messages {
        flex: 1;
        padding: 10px;
        overflow-y: auto;
        font-size: 13px;
        background: #fafafa;
      }

      .msg {
        margin: 8px 0;
        padding: 10px;
        border-radius: 10px;
        max-width: 90%;
      }

      .user { background: #1A1A2E; color: white; margin-left: auto; }
      .bot { background: #f1f1f1; }

      .package {
        background: #fff;
        border: 1px solid #eee;
        padding: 12px;
        border-radius: 10px;
        margin: 10px 0;
      }

      .price {
        color: #E07B39;
        font-weight: bold;
        font-size: 16px;
      }

      .book {
        background: #1A1A2E;
        color: white;
        border: none;
        padding: 10px;
        width: 100%;
        margin-top: 10px;
        border-radius: 6px;
        cursor: pointer;
      }

      #bodrless-input-area {
        display: flex;
        border-top: 1px solid #eee;
      }

      #bodrless-input {
        flex: 1;
        padding: 12px;
        border: none;
        outline: none;
      }

      #bodrless-send {
        background: #1A1A2E;
        color: white;
        border: none;
        padding: 10px 16px;
        cursor: pointer;
      }
    \`;

    document.head.appendChild(style);

    // ───── HTML ─────
    const root = document.createElement("div");
    root.id = "bodrless-widget-root";
    root.innerHTML = \`
      <div id="bodrless-chat">
        <div style="background:#1A1A2E;color:#fff;padding:12px;font-weight:bold;">
          ${agencyName}
        </div>
        <div id="bodrless-messages"></div>
        <div id="bodrless-input-area">
          <input id="bodrless-input" placeholder="Where do you want to go?" />
          <button id="bodrless-send">➤</button>
        </div>
      </div>
    \`;

    document.body.appendChild(root);

    const chat = document.getElementById("bodrless-chat");
    const input = document.getElementById("bodrless-input");
    const messages = document.getElementById("bodrless-messages");

    // ───── FLOAT BUTTON ─────
    const btn = document.createElement("button");
    btn.id = "bodrless-trigger";
    btn.innerText = "Plan Trip ✈️";
    document.body.appendChild(btn);

    btn.onclick = () => {
      chat.classList.add("open");
      input.focus();
    };

    function addMsg(text, type) {
      const div = document.createElement("div");
      div.className = "msg " + type;
      div.innerText = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function addPackage(p, i) {
      const div = document.createElement("div");
      div.className = "package";

      const total = p.summary?.totalPrice ||
        (p.transport?.price || 0) +
        ((p.hotel?.pricePerNight || 0) * (p.summary?.nights || 3)) +
        (p.transfers?.price || 0);

      const hasTransfer = p.transfers?.provider || p.transfers?.vehicleType;

      div.innerHTML = \`
        <b>Package \${i + 1}</b><br/><br/>

        ✈️ <b>Flight:</b> \${p.transport?.airline || "TBC"}<br/>
        📍 \${p.transport?.origin || "TBC"} → \${p.transport?.destination || "TBC"}<br/>
        🕐 Departs: \${p.transport?.departureTime || "TBC"} · Arrives: \${p.transport?.arrivalTime || "TBC"}<br/>
        💰 Flight: $\${p.transport?.price || 0}<br/><br/>

        🏨 <b>Hotel:</b> \${p.hotel?.name || "TBC"}<br/>
        📍 \${p.hotel?.location || "TBC"}<br/>
        ⭐ Rating: \${p.hotel?.rating || "N/A"}/5<br/>
        🌙 \${p.summary?.nights || 1} nights @ $\${p.hotel?.pricePerNight || 0}/night<br/><br/>

        \${hasTransfer ? \`
        🚗 <b>Transfer:</b> \${p.transfers?.provider || "TBC"}<br/>
        🚙 \${p.transfers?.vehicleType || "Car"}<br/>
        💰 Transfer: $\${p.transfers?.price || 0}<br/><br/>
        \` : ''}

        👥 \${p.summary?.passengers || 1} traveller(s) · 🌙 \${p.summary?.nights || 1} nights<br/>
        <span class="price">$\${Math.round(total)}</span> total<br/>
        <small>$\${p.summary?.pricePerPerson || 0} per person</small>

        <button class="book">Book Now</button>
      \`;

      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    async function send() {
      const text = input.value.trim();
      if (!text) return;

      addMsg(text, "user");
      input.value = "";

      addMsg("Searching for packages... ✈️", "bot");

      try {
        console.log("USING AGENCY:", "${agencyKey}");

        const res = await fetch("${apiBase}/api/trips/orchestrate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": "${agencyKey}"
          },
          body: JSON.stringify({
            prompt: text,
            agencyId: "${agencyKey}",
            channelType: "widget"
          })
        });

        const data = await res.json();
        console.log("FULL RESPONSE:", data);

        const packages = data?.packages || [];
        console.log("PACKAGES:", packages);

        // Remove the searching message
        const searching = messages.lastChild;
        if (searching) messages.removeChild(searching);

        if (!Array.isArray(packages) || !packages.length) {
          addMsg("No packages found for your request. Try adding more details like destination, dates and budget.", "bot");
          return;
        }

        addMsg(\`Found \${packages.length} trip option(s) 👇\`, "bot");
        packages.slice(0, 4).forEach((p, i) => addPackage(p, i));

      } catch (e) {
        console.log("WIDGET ERROR:", e);
        addMsg("Unable to load trips right now. Please try again.", "bot");
      }
    }

    document.getElementById("bodrless-send").onclick = send;

    input.addEventListener("keypress", function(e) {
      if (e.key === "Enter") send();
    });

    console.log("[BODRLESS] widget loaded");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initWidget);
  } else {
    initWidget();
  }

})();
  `);
});

module.exports = router;
