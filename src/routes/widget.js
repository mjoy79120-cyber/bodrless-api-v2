const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const agencyKey = req.query.key || 'accessible-travels';
  const agencyName = req.query.name || 'Accessible Travels';
  const apiBase = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  const widgetCode = '(function () {\n' +
  'function initWidget() {\n' +
  'if (!document.body) { setTimeout(initWidget, 50); return; }\n' +
  'if (document.getElementById("bodrless-widget-root")) return;\n' +
  'var sessionKey = "bodrless_session_" + "' + agencyKey + '";\n' +
  'if (!sessionStorage.getItem(sessionKey)) {\n' +
  '  var uuid = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "sess_" + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);\n' +
  '  sessionStorage.setItem(sessionKey, uuid);\n' +
  '}\n' +
  'var currentSessionId = sessionStorage.getItem(sessionKey);\n' +
  'var style = document.createElement("style");\n' +
  'style.innerHTML = [":root{--et-navy:#1E2A5E;--et-red:#C0392B;--et-white:#FFFFFF;--et-cream:#F8F9FC;--et-border:#E4E8F0;--et-muted:#8892A4;--et-green:#27ae60;}", "#bodrless-chat{position:fixed;bottom:90px;right:24px;width:390px;height:630px;background:var(--et-cream);z-index:999999;display:none;flex-direction:column;border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(30,42,94,0.18);font-family:Arial,sans-serif;}", "#bodrless-chat.open{display:flex;}", "@keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:0.6;}30%{transform:translateY(-6px);opacity:1;}}", "#et-header{background:var(--et-navy);padding:14px 18px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;border-bottom:3px solid var(--et-red);}", "#et-header-left{display:flex;align-items:center;gap:12px;}", "#et-logo-wrap{width:42px;height:42px;background:white;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;}", "#et-logo-wrap img{width:38px;height:38px;object-fit:contain;}", "#et-header-text h3{font-size:15px;color:white;margin:0 0 2px 0;}", "#et-header-text h3 span{color:var(--et-red);}", "#et-header-text p{font-size:10px;color:rgba(255,255,255,0.6);margin:0;letter-spacing:0.8px;text-transform:uppercase;}", "#et-close{background:rgba(255,255,255,0.1);border:none;color:white;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:13px;}", "#bodrless-messages{flex:1;padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;}", ".msg{padding:10px 14px;border-radius:14px;max-width:85%;font-size:13px;line-height:1.5;}", ".user{background:var(--et-navy);color:white;margin-left:auto;border-bottom-right-radius:4px;}", ".bot{background:var(--et-white);color:var(--et-navy);border:1px solid var(--et-border);border-bottom-left-radius:4px;}", ".typing{background:var(--et-white);border:1px solid var(--et-border);padding:12px 16px;border-radius:14px;display:flex;gap:5px;align-items:center;width:fit-content;}", ".typing span{width:7px;height:7px;background:var(--et-navy);border-radius:50%;animation:bounce 1.2s infinite;}", ".typing span:nth-child(2){animation-delay:0.2s;background:var(--et-red);}", ".typing span:nth-child(3){animation-delay:0.4s;}", ".et-welcome{background:linear-gradient(135deg,#1E2A5E 0%,#2d3f82 100%);border-radius:16px;padding:16px;color:white;border-left:4px solid #C0392B;}", ".et-welcome h4{font-size:14px;margin:0 0 6px 0;}", ".et-welcome p{font-size:12px;margin:0 0 12px 0;color:rgba(255,255,255,0.7);line-height:1.5;}", ".et-suggestions{display:flex;flex-wrap:wrap;gap:6px;}", ".et-suggestion{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.9);padding:5px 10px;border-radius:20px;font-size:11px;cursor:pointer;}", ".package{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;overflow:visible;height:auto;box-shadow:0 2px 10px rgba(30,42,94,0.07);margin-bottom:8px;}", ".pkg-header{background:var(--et-navy);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-radius:14px 14px 0 0;}", ".pkg-title{color:white;font-size:13px;font-weight:600;}", ".pkg-route{background:var(--et-red);color:white;font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}", ".pkg-body{padding:12px 14px;display:flex;flex-direction:column;height:auto;}", ".pkg-row{display:flex;flex-direction:column;padding:8px 0;border-bottom:1px dashed var(--et-border);}", ".pkg-row:last-child{border-bottom:none;}", ".pkg-label{font-size:10px;font-weight:700;color:var(--et-red);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;}", ".pkg-name{font-size:13px;font-weight:600;color:var(--et-navy);margin-bottom:2px;}", ".pkg-sub{font-size:11px;color:var(--et-muted);line-height:1.4;}", ".pkg-footer{padding:10px 14px;background:var(--et-cream);display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--et-border);height:auto;border-radius:0 0 14px 14px;}", ".pkg-price{font-size:20px;font-weight:700;color:var(--et-navy);line-height:1;}", ".pkg-price small{font-size:10px;color:var(--et-muted);display:block;font-weight:400;margin-top:2px;}", ".book{background:var(--et-red);color:white;border:none;padding:9px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;}", ".book:disabled{opacity:0.7;cursor:not-allowed;}", "#bodrless-input-area{display:flex;border-top:1px solid var(--et-border);background:var(--et-white);padding:10px 12px;gap:8px;flex-shrink:0;}", "#bodrless-input{flex:1;padding:10px 14px;border:1.5px solid var(--et-border);border-radius:20px;outline:none;font-size:13px;background:var(--et-cream);color:var(--et-navy);}", "#bodrless-input:focus{border-color:var(--et-navy);}", "#bodrless-input::placeholder{color:var(--et-muted);font-size:12px;}", "#bodrless-send{background:var(--et-navy);color:white;border:none;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}", "#bodrless-trigger{position:fixed;bottom:24px;right:24px;z-index:999998;background:var(--et-navy);color:white;border:none;padding:13px 20px;border-radius:999px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(30,42,94,0.35);border-left:3px solid var(--et-red);display:block !important;}", ".name-form{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;padding:14px;margin-top:8px;}", ".name-form p{font-size:12px;color:var(--et-navy);margin:0 0 10px 0;font-weight:500;}", ".name-input{width:100%;padding:9px 12px;border:1.5px solid var(--et-border);border-radius:10px;outline:none;font-size:12px;color:var(--et-navy);box-sizing:border-box;margin-bottom:10px;}", ".confirm-btn{background:var(--et-navy);color:white;border:none;padding:9px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;width:100%;}"].join("");\n' +
  'document.head.appendChild(style);\n' +
  'var root = document.createElement("div");\n' +
  'root.id = "bodrless-widget-root";\n' +
  'var chatDiv = document.createElement("div");\n' +
  'chatDiv.id = "bodrless-chat";\n' +
  'var header = document.createElement("div");\n' +
  'header.id = "et-header";\n' +
  'var headerLeft = document.createElement("div");\n' +
  'headerLeft.id = "et-header-left";\n' +
  'var logoWrap = document.createElement("div");\n' +
  'logoWrap.id = "et-logo-wrap";\n' +
  'var logoImg = document.createElement("img");\n' +
  'logoImg.src = "https://epictravels.co.ke/apple-touch-icon.png";\n' +
  'logoImg.alt = "' + agencyName + '";\n' +
  'logoImg.onerror = function() { this.parentNode.innerText = "ET"; };\n' +
  'logoWrap.appendChild(logoImg);\n' +
  'var headerText = document.createElement("div");\n' +
  'headerText.id = "et-header-text";\n' +
  'headerText.innerHTML = "<h3><span>' + agencyName + '</span></h3><p>Accessible Travel Specialist</p>";\n' +
  'headerLeft.appendChild(logoWrap);\n' +
  'headerLeft.appendChild(headerText);\n' +
  'var closeBtn = document.createElement("button");\n' +
  'closeBtn.id = "et-close";\n' +
  'closeBtn.innerText = "X";\n' +
  'header.appendChild(headerLeft);\n' +
  'header.appendChild(closeBtn);\n' +
  'var messages = document.createElement("div");\n' +
  'messages.id = "bodrless-messages";\n' +
  'var inputArea = document.createElement("div");\n' +
  'inputArea.id = "bodrless-input-area";\n' +
  'var input = document.createElement("input");\n' +
  'input.id = "bodrless-input";\n' +
  'input.placeholder = "Where would you like to go?";\n' +
  'var sendBtn = document.createElement("button");\n' +
  'sendBtn.id = "bodrless-send";\n' +
  'sendBtn.innerText = "Send";\n' +
  'inputArea.appendChild(input);\n' +
  'inputArea.appendChild(sendBtn);\n' +
  'chatDiv.appendChild(header);\n' +
  'chatDiv.appendChild(messages);\n' +
  'chatDiv.appendChild(inputArea);\n' +
  'root.appendChild(chatDiv);\n' +
  'document.body.appendChild(root);\n' +
  'var triggerBtn = document.createElement("button");\n' +
  'triggerBtn.id = "bodrless-trigger";\n' +
  'triggerBtn.innerText = "Plan Your Trip";\n' +
  'document.body.appendChild(triggerBtn);\n' +
  'var welcomeShown = false;\n' +
  'triggerBtn.onclick = function() { chatDiv.classList.add("open"); input.focus(); if (!welcomeShown) { welcomeShown = true; showWelcome(); } };\n' +
  'closeBtn.onclick = function() { chatDiv.classList.remove("open"); };\n' +
  'function showWelcome() {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "et-welcome";\n' +
  '  var h4 = document.createElement("h4");\n' +
  '  h4.innerText = "Welcome to ' + agencyName + '";\n' +
  '  var p = document.createElement("p");\n' +
  '  p.innerText = "Tell me your dream destination and I will find the perfect package.";\n' +
  '  var suggestionsDiv = document.createElement("div");\n' +
  '  suggestionsDiv.className = "et-suggestions";\n' +
  '  var suggestions = ["Nairobi to Zanzibar","Cape Town 5 nights","Masai Mara Safari","Kigali Rwanda","Cairo Egypt"];\n' +
  '  suggestions.forEach(function(s) {\n' +
  '    var btn = document.createElement("span");\n' +
  '    btn.className = "et-suggestion";\n' +
  '    btn.innerText = s;\n' +
  '    btn.onclick = function() { input.value = s; send(); };\n' +
  '    suggestionsDiv.appendChild(btn);\n' +
  '  });\n' +
  '  div.appendChild(h4);\n' +
  '  div.appendChild(p);\n' +
  '  div.appendChild(suggestionsDiv);\n' +
  '  messages.appendChild(div);\n' +
  '}\n' +
  'function addMsg(text, type) {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "msg " + type;\n' +
  '  div.innerText = text;\n' +
  '  messages.appendChild(div);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +
  'function showTyping() {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "typing";\n' +
  '  div.id = "et-typing";\n' +
  '  div.innerHTML = "<span></span><span></span><span></span>";\n' +
  '  messages.appendChild(div);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +
  'function hideTyping() {\n' +
  '  var t = document.getElementById("et-typing");\n' +
  '  if (t) t.remove();\n' +
  '}\n' +
  'function makeRow(label, name, sub) {\n' +
  '  var row = document.createElement("div");\n' +
  '  row.className = "pkg-row";\n' +
  '  var labelEl = document.createElement("div");\n' +
  '  labelEl.className = "pkg-label";\n' +
  '  labelEl.innerText = label;\n' +
  '  var nameEl = document.createElement("div");\n' +
  '  nameEl.className = "pkg-name";\n' +
  '  nameEl.innerText = name;\n' +
  '  var subEl = document.createElement("div");\n' +
  '  subEl.className = "pkg-sub";\n' +
  '  subEl.innerText = sub;\n' +
  '  row.appendChild(labelEl);\n' +
  '  row.appendChild(nameEl);\n' +
  '  row.appendChild(subEl);\n' +
  '  return row;\n' +
  '}\n' +
  'function showNameForm(p, bookBtn) {\n' +
  '  var existing = document.getElementById("et-name-form");\n' +
  '  if (existing) existing.remove();\n' +
  '  var form = document.createElement("div");\n' +
  '  form.className = "name-form";\n' +
  '  form.id = "et-name-form";\n' +
  '  form.innerHTML = "<p>Please enter your name to confirm booking:</p><input class=\\"name-input\\" placeholder=\\"Your full name\\" type=\\"text\\"><button class=\\"confirm-btn\\">Confirm Booking</button>";\n' +
  '  var nameInput = form.querySelector(".name-input");\n' +
  '  var confirmBtn = form.querySelector(".confirm-btn");\n' +
  '  confirmBtn.onclick = function() {\n' +
  '    var guestName = nameInput.value.trim();\n' +
  '    if (!guestName) { nameInput.style.borderColor = "#C0392B"; return; }\n' +
  '    confirmBtn.innerText = "Processing...";\n' +
  '    confirmBtn.disabled = true;\n' +
  '    fetch("' + apiBase + '/api/trips/book", {\n' +
  '      method: "POST",\n' +
  '      headers: { "Content-Type": "application/json" },\n' +
  '      body: JSON.stringify({ agencyId: "' + agencyKey + '", guestName: guestName, passengers: p.summary && p.summary.passengers ? p.summary.passengers : 1, package: p })\n' +
  '    })\n' +
  '    .then(function(r) { return r.json(); })\n' +
  '    .then(function(data) {\n' +
  '      form.remove();\n' +
  '      bookBtn.innerText = "Booked!";\n' +
  '      bookBtn.style.background = "#27ae60";\n' +
  '      bookBtn.disabled = true;\n' +
  '      addMsg("Booking confirmed for " + guestName + "! Ref: " + data.bookingRef + ".", "bot");\n' +
  '    });\n' +
  '  };\n' +
  '  messages.appendChild(form);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +
  'function addPackage(p, i) {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "package";\n' +
  '  var transport = p.transport || {};\n' +
  '  var type = (transport.type || "flight").toLowerCase();\n' +
  '  var label = type === "bus" ? "Bus / Ground" : "Flight";\n' +
  '  var provider = transport.provider || transport.airline || "N/A";\n' +
  '  var origin = transport.origin || "N/A";\n' +
  '  var dest = transport.destination || "N/A";\n' +
  '  var dep = transport.departureTime || transport.departure_time || "TBC";\n' +
  '  var arr = transport.arrivalTime || transport.arrival_time || "TBC";\n' +
  '  var total = p.summary && p.summary.totalPrice ? Math.round(p.summary.totalPrice) : 0;\n' +
  '  div.innerHTML = \'<div class="pkg-header"><span class="pkg-title">Option \' + (i + 1) + \'</span><span class="pkg-route">\' + origin + \' to \' + dest + \'</span></div>\' +\n' +
  '                  \'<div class="pkg-body"></div><div class="pkg-footer"><div class="pkg-price">$ \' + total + \'</div><button class="book">Book Now</button></div>\';\n' +
  '  var body = div.querySelector(".pkg-body");\n' +
  '  body.appendChild(makeRow(label, provider, origin + " to " + dest + " | " + dep + " - " + arr));\n' +
  '  body.appendChild(makeRow("Hotel", p.hotel ? p.hotel.name : "N/A", (p.hotel ? p.hotel.location : "N/A")));\n' +
  '  div.querySelector(".book").onclick = function() { showNameForm(p, this); };\n' +
  '  messages.appendChild(div);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +
  'function send() {\n' +
  '  var text = input.value.trim();\n' +
  '  if (!text) return;\n' +
  '  addMsg(text, "user");\n' +
  '  input.value = "";\n' +
  '  showTyping();\n' +
  '  fetch("' + apiBase + '/api/trips/orchestrate", {\n' +
  '    method: "POST",\n' +
  '    headers: { "Content-Type": "application/json", "x-api-key": "' + agencyKey + '" },\n' +
  '    body: JSON.stringify({ prompt: text, agencyId: "' + agencyKey + '", channelType: "widget", userSessionId: currentSessionId })\n' +
  '  })\n' +
  '  .then(function(res) { return res.json(); })\n' +
  '  .then(function(data) {\n' +
  '    hideTyping();\n' +
  '    if (data && data.text) { addMsg(data.text, "bot"); }\n' +
  '    if (data.packages) { data.packages.forEach(addPackage); }\n' +
  '  })\n' +
  '  .catch(function() { hideTyping(); addMsg("Error loading trips.", "bot"); });\n' +
  '}\n' +
  'sendBtn.onclick = send;\n' +
  'input.addEventListener("keypress", function(e) { if (e.key === "Enter") send(); });\n' +
  '}\n' +
  'if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", initWidget); } else { initWidget(); }\n' +
  '})();\n';

  res.send(widgetCode);
});

module.exports = router;