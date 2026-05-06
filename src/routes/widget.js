const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const agencyKey = req.query.key || 'bodrless-test-key';
  const agencyName = req.query.name || 'Your Travel Agent';
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
        padding: 10px;
        border-radius: 10px;
        margin: 8px 0;
      }

      .price {
        color: #E07B39;
        font-weight: bold;
      }

      .book {
        background: #1A1A2E;
        color: white;
        border: none;
        padding: 8px;
        width: 100%;
        margin-top: 8px;
        border-radius: 6px;
        cursor: pointer;
      }

      #bodrless-input-area {
        display: flex;
        border-top: 1px solid #eee;
      }

      #bodrless-input {
        flex: 1;
        padding: 10px;
        border: none;
        outline: none;
      }

      #bodrless-send {
        background: #1A1A2E;
        color: white;
        border: none;
        padding: 10px 14px;
        cursor: pointer;
      }
    \`;

    document.head.appendChild(style);

    // ───── HTML ─────
    const root = document.createElement("div");
    root.id = "bodrless-widget-root";
    root.innerHTML = \`
      <div id="bodrless-chat">
        <div style="background:#1A1A2E;color:#fff;padding:12px;">
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

      const total =
        (p.summary?.totalPrice ||
        (p.transport?.price || 0) +
        (p.hotel?.pricePerNight || 0) * (p.summary?.nights || 3) +
        (p.transfers?.price || 0));

      div.innerHTML = \`
        <b>Package \${i + 1}</b><br/><br/>

        ✈️ Transport: \${p.transport?.provider || "Flight"}<br/>
        🏨 Hotel: \${p.hotel?.name || "Hotel"}<br/>
        🚗 Transfers: Included<br/><br/>

        <span class="price">$ \${total}</span> per person<br/>

        <button class="book">Book Now</button>
      \`;

      messages.appendChild(div);
    }

    async function send() {
      const text = input.value.trim();
      if (!text) return;

      addMsg(text, "user");
      input.value = "";

      try {
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
        console.log("[BODRLESS]", data);

        const packages = data.packages || [];

        if (!packages.length) {
          addMsg("No packages found", "bot");
          return;
        }

        addMsg("Here are your trip packages 👇", "bot");

        packages.slice(0, 4).forEach((p, i) => addPackage(p, i));

      } catch (e) {
        console.log(e);
        addMsg("Error loading packages", "bot");
      }
    }

    document.getElementById("bodrless-send").onclick = send;

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
