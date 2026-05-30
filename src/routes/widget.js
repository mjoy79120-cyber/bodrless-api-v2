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

    if (!document.body) { setTimeout(initWidget, 50); return; }
    if (document.getElementById("bodrless-widget-root")) return;

    const style = document.createElement("style");
    style.innerHTML = [
      '@import url("https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=Lora:wght@600&display=swap");',
      ':root {',
      '  --et-navy: #1E2A5E;',
      '  --et-red: #C0392B;',
      '  --et-white: #FFFFFF;',
      '  --et-cream: #F8F9FC;',
      '  --et-border: #E4E8F0;',
      '  --et-muted: #8892A4;',
      '}',
      '#bodrless-chat {',
      '  position: fixed; bottom: 90px; right: 24px;',
      '  width: 390px; height: 630px;',
      '  background: var(--et-cream);',
      '  z-index: 999999;',
      '  display: none; flex-direction: column;',
      '  border-radius: 20px; overflow: hidden;',
      '  box-shadow: 0 20px 60px rgba(30,42,94,0.18), 0 0 0 1px rgba(30,42,94,0.1);',
      '  font-family: Montserrat, sans-serif;',
      '}',
      '#bodrless-chat.open { display: flex; animation: slideUp 0.3s ease; }',
      '@keyframes slideUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }',
      '@keyframes fadeUp { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }',
      '@keyframes bounce { 0%,60%,100% { transform:translateY(0); opacity:0.6; } 30% { transform:translateY(-6px); opacity:1; } }',
      '#et-header {',
      '  background: var(--et-navy); padding: 14px 18px;',
      '  display: flex; align-items: center; justify-content: space-between;',
      '  flex-shrink: 0; border-bottom: 3px solid var(--et-red);',
      '}',
      '#et-header-left { display: flex; align-items: center; gap: 12px; }',
      '#et-logo-wrap {',
      '  width: 42px; height: 42px; background: white;',
      '  border-radius: 10px; display: flex; align-items: center;',
      '  justify-content: center; overflow: hidden; flex-shrink: 0;',
      '}',
      '#et-logo-wrap img { width: 38px; height: 38px; object-fit: contain; }',
      '#et-header-text h3 { font-family: Lora,serif; font-size: 15px; color: white; margin: 0 0 2px 0; }',
      '#et-header-text h3 span { color: var(--et-red); }',
      '#et-header-text p { font-size: 10px; color: rgba(255,255,255,0.6); margin: 0; letter-spacing: 0.8px; text-transform: uppercase; }',
      '#et-close { background: rgba(255,255,255,0.1); border: none; color: white; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; font-size: 13px; transition: background 0.2s; }',
      '#et-close:hover { background: var(--et-red); }',
      '#bodrless-messages { flex: 1; padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; scrollbar-width: thin; }',
      '.msg { padding: 10px 14px; border-radius: 14px; max-width: 85%; font-size: 12.5px; line-height: 1.5; animation: fadeUp 0.25s ease; }',
      '.user { background: var(--et-navy); color: white; margin-left: auto; border-bottom-right-radius: 4px; }',
      '.bot { background: var(--et-white); color: var(--et-navy); border: 1px solid var(--et-border); border-bottom-left-radius: 4px; }',
      '.typing { background: var(--et-white); border: 1px solid var(--et-border); padding: 12px 16px; border-radius: 14px; display: flex; gap: 5px; align-items: center; width: fit-content; }',
      '.typing span { width: 7px; height: 7px; background: var(--et-navy); border-radius: 50%; animation: bounce 1.2s infinite; }',
      '.typing span:nth-child(2) { animation-delay: 0.2s; background: var(--et-red); }',
      '.typing span:nth-child(3) { animation-delay: 0.4s; }',
      '.et-welcome { background: linear-gradient(135deg, var(--et-navy) 0%, #2d3f82 100%); border-radius: 16px; padding: 16px; color: white; border-left: 4px solid var(--et-red); }',
      '.et-welcome h4 { font-family: Lora,serif; font-size: 14px; margin: 0 0 6px 0; }',
      '.et-welcome p { font-size: 11.5px; margin: 0 0 12px 0; color: rgba(255,255,255,0.7); line-height: 1.5; }',
      '.et-suggestions { display: flex; flex-wrap: wrap; gap: 6px; }',
      '.et-suggestion { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2); color: rgba(255,255,255,0.9); padding: 5px 10px; border-radius: 20px; font-size: 11px; cursor: pointer; transition: all 0.2s; font-family: Montserrat,sans-serif; }',
      '.et-suggestion:hover { background: var(--et-red); border-color: var(--et-red); color: white; }',
      '.package { background: var(--et-white); border: 1px solid var(--et-border); border-radius: 14px; overflow: hidden; animation: fadeUp 0.3s ease; box-shadow: 0 2px 10px rgba(30,42,94,0.07); }',
      '.pkg-header { background: var(--et-navy); padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; }',
      '.pkg-title { font-family: Lora,serif; color: white; font-size: 13px; }',
      '.pkg-route { background: var(--et-red); color: white; font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 20px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.pkg-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 0; }',
      '.pkg-row { display: flex; align-items: flex-start; gap: 10px; font-size: 12px; color: var(--et-navy); padding: 8px 0; border-bottom: 1px dashed var(--et-border); }',
      '.pkg-row:last-child { border-bottom: none; }',
      '.pkg-icon { font-size: 15px; width: 22px; flex-shrink: 0; }',
      '.pkg-detail strong { display: block; font-weight: 600; font-size: 12px; margin-bottom: 2px; color: var(--et-navy); }',
      '.pkg-detail small { color: var(--et-muted); font-size: 11px; line-height: 1.4; }',
      '.pkg-footer { padding: 10px 14px; background: var(--et-cream); display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--et-border); }',
      '.pkg-price { font-family: Lora,serif; color: var(--et-navy); font-size: 20px; font-weight: 600; line-height: 1; }',
      '.pkg-price small { font-family: Montserrat,sans-serif; font-size: 10px; color: var(--et-muted); display: block; font-weight: 400; margin-top: 2px; }',
      '.book { background: var(--et-red); color: white; border: none; padding: 9px 18px; border-radius: 20px; cursor: pointer; font-size: 12px; font-weight: 600; font-family: Montserrat,sans-serif; transition: all 0.2s; }',
      '.book:hover { background: #a93226; transform: translateY(-1px); }',
      '#bodrless-input-area { display: flex; border-top: 1px solid var(--et-border); background: var(--et-white); padding: 10px 12px; gap: 8px; flex-shrink: 0; }',
      '#bodrless-input { flex: 1; padding: 10px 14px; border: 1.5px solid var(--et-border); border-radius: 20px; outline: none; font-size: 12.5px; font-family: Montserrat,sans-serif; background: var(--et-cream); color: var(--et-navy); transition: border-color 0.2s; }',
      '#bodrless-input:focus { border-color: var(--et-navy); }',
      '#bodrless-input::placeholder { color: var(--et-muted); font-size: 12px; }',
      '#bodrless-send { background: var(--et-navy); color: white; border: none; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; font-size: 15px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; flex-shrink: 0; }',
      '#bodrless-send:hover { background: var(--et-red); transform: scale(1.08); }',
      '#bodrless-trigger { position: fixed; bottom: 24px; right: 24px; z-index: 999998; background: var(--et-navy); color: white; border: none; padding: 13px 20px; border-radius: 999px; cursor: pointer; font-family: Montserrat,sans-serif; font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(30,42,94,0.35); transition: all 0.2s; display: flex; align-items: center; gap: 8px; border-left: 3px solid var(--et-red); }',
      '#bodrless-trigger:hover { transform: translateY(-2px); box-shadow: 0 12px 32px rgba(30,42,94,0.45); }',
    ].join('');

    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = "bodrless-widget-root";

    const chatDiv = document.createElement("div");
    chatDiv.id = "bodrless-chat";

    // Header
    const header = document.createElement("div");
    header.id = "et-header";

    const headerLeft = document.createElement("div");
    headerLeft.id = "et-header-left";

    const logoWrap = document.createElement("div");
    logoWrap.id = "et-logo-wrap";
    const logoImg = document.createElement("img");
    logoImg.src = "https://epictravels.co.ke/apple-touch-icon.png";
    logoImg.alt = "Epic Travels";
    logoImg.onerror = function() { this.parentNode.innerHTML = "✈️"; };
    logoWrap.appendChild(logoImg);

    const headerText = document.createElement("div");
    headerText.id = "et-header-text";
    headerText.innerHTML = '<h3><span>Epic</span> Travels Kenya</h3><p>Premium Travel Specialist</p>';

    headerLeft.appendChild(logoWrap);
    headerLeft.appendChild(headerText);

    const closeBtn = document.createElement("button");
    closeBtn.id = "et-close";
    closeBtn.innerText = "✕";

    header.appendChild(headerLeft);
    header.appendChild(closeBtn);

    // Messages
    const messages = document.createElement("div");
    messages.id = "bodrless-messages";

    // Input area
    const inputArea = document.createElement("div");
    inputArea.id = "bodrless-input-area";

    const input = document.createElement("input");
    input.id = "bodrless-input";
    input.placeholder = "Where would you like to go?";

    const sendBtn = document.createElement("button");
    sendBtn.id = "bodrless-send";
    sendBtn.innerText = "➤";

    inputArea.appendChild(input);
    inputArea.appendChild(sendBtn);

    chatDiv.appendChild(header);
    chatDiv.appendChild(messages);
    chatDiv.appendChild(inputArea);
    root.appendChild(chatDiv);
    document.body.appendChild(root);

    // Trigger button
    const triggerBtn = document.createElement("button");
    triggerBtn.id = "bodrless-trigger";
    triggerBtn.innerHTML = "✈️ Plan Your Trip";
    document.body.appendChild(triggerBtn);

    let welcomeShown = false;

    triggerBtn.onclick = function() {
      chatDiv.classList.add("open");
      input.focus();
      if (!welcomeShown) { welcomeShown = true; showWelcome(); }
    };

    closeBtn.onclick = function() { chatDiv.classList.remove("open"); };

    function showWelcome() {
      const div = document.createElement("div");
      div.className = "et-welcome";

      const h4 = document.createElement("h4");
      h4.innerText = "Welcome to Epic Travels 🌍";

      const p = document.createElement("p");
      p.innerText = "Tell me your dream destination and I'll find the perfect package — flights, hotels and transfers included.";

      const suggestionsDiv = document.createElement("div");
      suggestionsDiv.className = "et-suggestions";

      const suggestions = [
        "Nairobi to Zanzibar",
        "Cape Town 5 nights",
        "Masai Mara Safari",
        "Kigali Rwanda",
        "Cairo Egypt"
      ];

      suggestions.forEach(function(s) {
        const btn = document.createElement("span");
        btn.className = "et-suggestion";
        btn.innerText = s;
        btn.onclick = function() { input.value = s; send(); };
        suggestionsDiv.appendChild(btn);
      });

      div.appendChild(h4);
      div.appendChild(p);
      div.appendChild(suggestionsDiv);
      messages.appendChild(div);
    }

    function addMsg(text, type) {
      const div = document.createElement("div");
      div.className = "msg " + type;
      div.innerText = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function showTyping() {
      const div = document.createElement("div");
      div.className = "typing";
      div.id = "et-typing";
      div.innerHTML = "<span></span><span></span><span></span>";
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function hideTyping() {
      const t = document.getElementById("et-typing");
      if (t) t.remove();
    }

    function addPackage(p, i) {
      const div = document.createElement("div");
      div.className = "package";

      const total = p.summary && p.summary.totalPrice ? p.summary.totalPrice :
        (p.transport && p.transport.price ? p.transport.price : 0) +
        ((p.hotel && p.hotel.pricePerNight ? p.hotel.pricePerNight : 0) * (p.summary && p.summary.nights ? p.summary.nights : 3)) +
        (p.transfers && p.transfers.price ? p.transfers.price : 0);

      const airline = p.transport && p.transport.airline ? p.transport.airline : "Flight";
      const flightFrom = p.transport && p.transport.origin ? p.transport.origin : "TBC";
      const flightTo = p.transport && p.transport.destination ? p.transport.destination : "TBC";
      const depTime = p.transport && p.transport.departureTime ? p.transport.departureTime : "TBC";
      const arrTime = p.transport && p.transport.arrivalTime ? p.transport.arrivalTime : "TBC";
      const hotelName = p.hotel && p.hotel.name ? p.hotel.name : "Hotel";
      const hotelLoc = p.hotel && p.hotel.location ? p.hotel.location : "TBC";
      const hotelRating = p.hotel && p.hotel.rating ? p.hotel.rating : "N/A";
      const hotelPPN = p.hotel && p.hotel.pricePerNight ? p.hotel.pricePerNight : 0;
      const nights = p.summary && p.summary.nights ? p.summary.nights : 1;
      const passengers = p.summary && p.summary.passengers ? p.summary.passengers : 1;
      const ppp = p.summary && p.summary.pricePerPerson ? p.summary.pricePerPerson : 0;
      const route = p.summary && p.summary.route ? p.summary.route : flightFrom + " → " + flightTo;
      const hasTransfer = p.transfers && p.transfers.provider;
      const transferProvider = hasTransfer ? p.transfers.provider : "";
      const transferVehicle = hasTransfer && p.transfers.vehicleType ? p.transfers.vehicleType : "Car";
      const transferPrice = hasTransfer && p.transfers.price ? p.transfers.price : 0;

      // Header
      const pkgHeader = document.createElement("div");
      pkgHeader.className = "pkg-header";
      const pkgTitle = document.createElement("span");
      pkgTitle.className = "pkg-title";
      pkgTitle.innerText = "Option " + (i + 1);
      const pkgRoute = document.createElement("span");
      pkgRoute.className = "pkg-route";
      pkgRoute.innerText = route;
      pkgHeader.appendChild(pkgTitle);
      pkgHeader.appendChild(pkgRoute);

      // Body
      const pkgBody = document.createElement("div");
      pkgBody.className = "pkg-body";

      // Flight row
      const flightRow = document.createElement("div");
      flightRow.className = "pkg-row";
      const flightIcon = document.createElement("span");
      flightIcon.className = "pkg-icon";
      flightIcon.innerText = "✈️";
      const flightDetail = document.createElement("div");
      flightDetail.className = "pkg-detail";
      const flightStrong = document.createElement("strong");
      flightStrong.innerText = airline;
      const flightSmall = document.createElement("small");
      flightSmall.innerText = flightFrom + " → " + flightTo + " | Departs " + depTime + " · Arrives " + arrTime;
      flightDetail.appendChild(flightStrong);
      flightDetail.appendChild(flightSmall);
      flightRow.appendChild(flightIcon);
      flightRow.appendChild(flightDetail);

      // Hotel row
      const hotelRow = document.createElement("div");
      hotelRow.className = "pkg-row";
      const hotelIcon = document.createElement("span");
      hotelIcon.className = "pkg-icon";
      hotelIcon.innerText = "🏨";
      const hotelDetail = document.createElement("div");
      hotelDetail.className = "pkg-detail";
      const hotelStrong = document.createElement("strong");
      hotelStrong.innerText = hotelName;
      const hotelSmall = document.createElement("small");
      hotelSmall.innerText = hotelLoc + " · " + nights + " nights · $" + hotelPPN + "/night · Rating: " + hotelRating + "/5";
      hotelDetail.appendChild(hotelStrong);
      hotelDetail.appendChild(hotelSmall);
      hotelRow.appendChild(hotelIcon);
      hotelRow.appendChild(hotelDetail);

      pkgBody.appendChild(flightRow);
      pkgBody.appendChild(hotelRow);

      // Transfer row
      if (hasTransfer) {
        const transferRow = document.createElement("div");
        transferRow.className = "pkg-row";
        const transferIcon = document.createElement("span");
        transferIcon.className = "pkg-icon";
        transferIcon.innerText = "🚗";
        const transferDetail = document.createElement("div");
        transferDetail.className = "pkg-detail";
        const transferStrong = document.createElement("strong");
        transferStrong.innerText = transferProvider;
        const transferSmall = document.createElement("small");
        transferSmall.innerText = transferVehicle + " · $" + transferPrice;
        transferDetail.appendChild(transferStrong);
        transferDetail.appendChild(transferSmall);
        transferRow.appendChild(transferIcon);
        transferRow.appendChild(transferDetail);
        pkgBody.appendChild(transferRow);
      }

      // Footer
      const pkgFooter = document.createElement("div");
      pkgFooter.className = "pkg-footer";
      const pkgPrice = document.createElement("div");
      pkgPrice.className = "pkg-price";
      pkgPrice.innerText = "$" + Math.round(total);
      const pkgPriceSub = document.createElement("small");
      pkgPriceSub.innerText = "$" + ppp + "/person · " + passengers + " traveller(s)";
      pkgPrice.appendChild(pkgPriceSub);
      const bookBtn = document.createElement("button");
      bookBtn.className = "book";
      bookBtn.innerText = "Book Now";
      pkgFooter.appendChild(pkgPrice);
      pkgFooter.appendChild(bookBtn);

      div.appendChild(pkgHeader);
      div.appendChild(pkgBody);
      div.appendChild(pkgFooter);
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    async function send() {
      const text = input.value.trim();
      if (!text) return;

      addMsg(text, "user");
      input.value = "";
      showTyping();

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
        hideTyping();

        const packages = data && data.packages ? data.packages : [];

        if (!packages.length) {
          addMsg("I couldn't find packages for that request. Try specifying destination, number of people and nights.", "bot");
          return;
        }

        addMsg("I found " + packages.length + " great option(s) for you 👇", "bot");
        packages.slice(0, 4).forEach(function(p, i) { addPackage(p, i); });

      } catch (e) {
        hideTyping();
        addMsg("Unable to load trips right now. Please try again.", "bot");
      }
    }

    sendBtn.onclick = send;
    input.addEventListener("keypress", function(e) { if (e.key === "Enter") send(); });

    console.log("[BODRLESS] Epic Travels widget loaded");
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
