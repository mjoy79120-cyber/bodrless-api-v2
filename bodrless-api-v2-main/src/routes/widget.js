const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {

  // FORCE REAL AGENCY
  const agencyKey =
    req.query.key || "epic-travels";

  const agencyName =
    req.query.name || "Epic Travels";

  const apiBase =
    process.env.API_BASE_URL ||
    "https://bodrless-api-v2.onrender.com";

  res.setHeader(
    "Content-Type",
    "application/javascript"
  );

  res.send(`

(function () {

  function initWidget() {

    if (!document.body) {

      setTimeout(initWidget, 50);

      return;
    }

    if (
      document.getElementById(
        "bodrless-widget-root"
      )
    ) return;

    // ─────────────────────────────
    // STYLES
    // ─────────────────────────────
    const style =
      document.createElement("style");

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

        box-shadow:
          0 10px 40px rgba(0,0,0,0.2);

        font-family: Arial;
      }

      #bodrless-chat.open {
        display: flex;
      }

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

      .user {

        background: #1A1A2E;
        color: white;

        margin-left: auto;
      }

      .bot {

        background: #f1f1f1;
      }

      .package {

        background: white;

        border: 1px solid #eee;

        padding: 12px;

        border-radius: 10px;

        margin: 10px 0;
      }

      .price {

        color: #E07B39;

        font-weight: bold;

        font-size: 18px;
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

    // ─────────────────────────────
    // HTML
    // ─────────────────────────────
    const root =
      document.createElement("div");

    root.id =
      "bodrless-widget-root";

    root.innerHTML = \`

      <div id="bodrless-chat">

        <div
          style="
            background:#1A1A2E;
            color:#fff;
            padding:12px;
            font-weight:bold;
          "
        >
          \${"${agencyName}"}
        </div>

        <div id="bodrless-messages"></div>

        <div id="bodrless-input-area">

          <input
            id="bodrless-input"
            placeholder="Where do you want to go?"
          />

          <button id="bodrless-send">
            ➤
          </button>

        </div>

      </div>
    \`;

    document.body.appendChild(root);

    const chat =
      document.getElementById(
        "bodrless-chat"
      );

    const input =
      document.getElementById(
        "bodrless-input"
      );

    const messages =
      document.getElementById(
        "bodrless-messages"
      );

    // ─────────────────────────────
    // FLOAT BUTTON
    // ─────────────────────────────
    const btn =
      document.createElement("button");

    btn.id =
      "bodrless-trigger";

    btn.innerText =
      "Plan Trip ✈️";

    document.body.appendChild(btn);

    btn.onclick = () => {

      chat.classList.add("open");

      input.focus();
    };

    // ─────────────────────────────
    // MESSAGE
    // ─────────────────────────────
    function addMsg(text, type) {

      const div =
        document.createElement("div");

      div.className =
        "msg " + type;

      div.innerText = text;

      messages.appendChild(div);

      messages.scrollTop =
        messages.scrollHeight;
    }

    // ─────────────────────────────
    // PACKAGE CARD
    // ─────────────────────────────
    function addPackage(p, i) {

      const div =
        document.createElement("div");

      div.className =
        "package";

      const transportPrice =
        p?.transport?.price || 0;

      const hotelPrice =
        p?.hotel?.pricePerNight || 0;

      const nights =
        p?.summary?.nights || 1;

      const transferPrice =
        p?.transfers?.price || 0;

      const total =

        p?.summary?.totalPrice ||

        (
          transportPrice +

          (hotelPrice * nights) +

          transferPrice
        );

      div.innerHTML = \`

        <b>
          Package \${i + 1}
        </b>

        <br/><br/>

        ✈️
        \${

          p?.transport?.airline ||

          p?.transport?.providerName ||

          "Transport"
        }

        <br/>

        🏨
        \${

          p?.hotel?.name ||

          "Hotel"
        }

        <br/>

        🚗
        \${

          p?.transfers?.provider ||

          "Transfer"
        }

        <br/><br/>

        👥
        \${

          p?.summary?.passengers || 1

        } travellers

        <br/>

        🌙
        \${

          p?.summary?.nights || 1

        } nights

        <br/><br/>

        <span class="price">
          $ \${Math.round(total)}
        </span>

        <br/>

        <small>
          $ \${

            p?.summary?.pricePerPerson || 0

          } per person
        </small>

        <button class="book">
          Book Now
        </button>

      \`;

      messages.appendChild(div);

      messages.scrollTop =
        messages.scrollHeight;
    }

    // ─────────────────────────────
    // SEND
    // ─────────────────────────────
    async function send() {

      const text =
        input.value.trim();

      if (!text) return;

      addMsg(text, "user");

      input.value = "";

      try {

        console.log(
          "USING AGENCY:",
          "${agencyKey}"
        );

        const res = await fetch(

          "${apiBase}/api/trips/orchestrate",

          {

            method: "POST",

            headers: {

              "Content-Type":
                "application/json",

              "x-api-key":
                "${agencyKey}"
            },

            body: JSON.stringify({

              prompt: text,

              agencyId:
                "${agencyKey}",

              channelType:
                "widget"
            })
          }
        );

        const data =
          await res.json();

        console.log(
          "FULL RESPONSE:",
          data
        );

        const packages =

          data?.packages ||

          data?.data?.packages ||

          data?.results ||

          [];

        console.log(
          "PACKAGES:",
          packages
        );

        if (
          !Array.isArray(packages) ||

          !packages.length
        ) {

          addMsg(
            "No matching packages found.",
            "bot"
          );

          return;
        }

        addMsg(
          \`Found \${packages.length} trip option(s) 👇\`,
          "bot"
        );

        packages
          .slice(0, 4)
          .forEach((p, i) => {

            addPackage(p, i);
          });

      } catch (e) {

        console.log(
          "WIDGET ERROR:",
          e
        );

        addMsg(
          "Unable to load trips right now.",
          "bot"
        );
      }
    }

    // SEND BUTTON
    document
      .getElementById(
        "bodrless-send"
      )
      .onclick = send;

    // ENTER KEY
    input.addEventListener(
      "keypress",
      function(e) {

        if (e.key === "Enter") {
          send();
        }
      }
    );

    console.log(
      "[BODRLESS] widget loaded"
    );
  }

  if (
    document.readyState === "loading"
  ) {

    document.addEventListener(
      "DOMContentLoaded",
      initWidget
    );

  } else {

    initWidget();
  }

})();
  `);
});

module.exports = router;