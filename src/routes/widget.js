const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const agencyKey  = req.query.key  || 'epic-travels';
  const agencyName = req.query.name || 'Epic Travels';
  const apiBase    = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  const widgetCode = '(function () {\n' +
  'function initWidget() {\n' +
  'if (!document.body) { setTimeout(initWidget, 50); return; }\n' +
  'if (document.getElementById("bodrless-widget-root")) return;\n' +

  'var conversationHistory = [];\n' +
  'var previousParams = null;\n' +
  'var sessionId = null;\n' +

  'var style = document.createElement("style");\n' +
  'style.innerHTML = [":root{--et-navy:#1E2A5E;--et-red:#C0392B;--et-white:#FFFFFF;--et-cream:#F8F9FC;--et-border:#E4E8F0;--et-muted:#8892A4;--et-green:#27ae60;}",\n' +
  '"#bodrless-chat{position:fixed;bottom:90px;right:24px;width:390px;height:630px;background:var(--et-cream);z-index:999999;display:none;flex-direction:column;border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(30,42,94,0.18);font-family:Arial,sans-serif;}",\n' +
  '"#bodrless-chat.open{display:flex;}",\n' +
  '"@keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:0.6;}30%{transform:translateY(-6px);opacity:1;}}",\n' +
  '"#et-header{background:var(--et-navy);padding:14px 18px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;border-bottom:3px solid var(--et-red);}",\n' +
  '"#et-header-left{display:flex;align-items:center;gap:12px;}",\n' +
  '"#et-logo-wrap{width:42px;height:42px;background:white;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;}",\n' +
  '"#et-logo-wrap img{width:38px;height:38px;object-fit:contain;}",\n' +
  '"#et-header-text h3{font-size:15px;color:white;margin:0 0 2px 0;}",\n' +
  '"#et-header-text h3 span{color:var(--et-red);}",\n' +
  '"#et-header-text p{font-size:10px;color:rgba(255,255,255,0.6);margin:0;letter-spacing:0.8px;text-transform:uppercase;}",\n' +
  '"#et-close{background:rgba(255,255,255,0.1);border:none;color:white;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:13px;}",\n' +
  '"#bodrless-messages{flex:1;padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;}",\n' +
  '".msg{padding:10px 14px;border-radius:14px;max-width:85%;font-size:13px;line-height:1.5;}",\n' +
  '".user{background:var(--et-navy);color:white;margin-left:auto;border-bottom-right-radius:4px;}",\n' +
  '".bot{background:var(--et-white);color:var(--et-navy);border:1px solid var(--et-border);border-bottom-left-radius:4px;}",\n' +
  '".typing{background:var(--et-white);border:1px solid var(--et-border);padding:12px 16px;border-radius:14px;display:flex;gap:5px;align-items:center;width:fit-content;}",\n' +
  '".typing span{width:7px;height:7px;background:var(--et-navy);border-radius:50%;animation:bounce 1.2s infinite;}",\n' +
  '".typing span:nth-child(2){animation-delay:0.2s;background:var(--et-red);}",\n' +
  '".typing span:nth-child(3){animation-delay:0.4s;}",\n' +
  '".et-welcome{background:linear-gradient(135deg,#1E2A5E 0%,#2d3f82 100%);border-radius:16px;padding:16px;color:white;border-left:4px solid #C0392B;}",\n' +
  '".et-welcome h4{font-size:14px;margin:0 0 6px 0;}",\n' +
  '".et-welcome p{font-size:12px;margin:0 0 12px 0;color:rgba(255,255,255,0.7);line-height:1.5;}",\n' +
  '".et-suggestions{display:flex;flex-wrap:wrap;gap:6px;}",\n' +
  '".et-suggestion{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.9);padding:5px 10px;border-radius:20px;font-size:11px;cursor:pointer;}",\n' +
  '".package{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;overflow:visible;height:auto;box-shadow:0 2px 10px rgba(30,42,94,0.07);margin-bottom:8px;}",\n' +
  '".pkg-header{background:var(--et-navy);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-radius:14px 14px 0 0;}",\n' +
  '".pkg-title{color:white;font-size:13px;font-weight:600;}",\n' +
  '".pkg-route{background:var(--et-red);color:white;font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",\n' +
  '".pkg-body{padding:12px 14px;display:flex;flex-direction:column;height:auto;}",\n' +
  '".pkg-row{display:flex;flex-direction:column;padding:8px 0;border-bottom:1px dashed var(--et-border);}",\n' +
  '".pkg-row:last-child{border-bottom:none;}",\n' +
  '".pkg-label{font-size:10px;font-weight:700;color:var(--et-red);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;}",\n' +
  '".pkg-name{font-size:13px;font-weight:600;color:var(--et-navy);margin-bottom:2px;}",\n' +
  '".pkg-sub{font-size:11px;color:var(--et-muted);line-height:1.4;}",\n' +
  '".pkg-footer{padding:10px 14px;background:var(--et-cream);display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--et-border);height:auto;border-radius:0 0 14px 14px;}",\n' +
  '".pkg-price{font-size:20px;font-weight:700;color:var(--et-navy);line-height:1;}",\n' +
  '".pkg-price small{font-size:10px;color:var(--et-muted);display:block;font-weight:400;margin-top:2px;}",\n' +
  '".book{background:var(--et-red);color:white;border:none;padding:9px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;}",\n' +
  '".book:disabled{opacity:0.7;cursor:not-allowed;}",\n' +
  '"#bodrless-input-area{display:flex;border-top:1px solid var(--et-border);background:var(--et-white);padding:10px 12px;gap:8px;flex-shrink:0;}",\n' +
  '"#bodrless-input{flex:1;padding:10px 14px;border:1.5px solid var(--et-border);border-radius:20px;outline:none;font-size:13px;background:var(--et-cream);color:var(--et-navy);}",\n' +
  '"#bodrless-input:focus{border-color:var(--et-navy);}",\n' +
  '"#bodrless-input::placeholder{color:var(--et-muted);font-size:12px;}",\n' +
  '"#bodrless-send{background:var(--et-navy);color:white;border:none;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}",\n' +
  '"#bodrless-trigger{position:fixed;bottom:24px;right:24px;z-index:999998;background:var(--et-navy);color:white;border:none;padding:13px 20px;border-radius:999px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(30,42,94,0.35);border-left:3px solid var(--et-red);}",\n' +
  '".name-form{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;padding:14px;margin-top:8px;}",\n' +
  '".name-form p{font-size:12px;color:var(--et-navy);margin:0 0 10px 0;font-weight:500;}",\n' +
  '".name-input{width:100%;padding:9px 12px;border:1.5px solid var(--et-border);border-radius:10px;outline:none;font-size:12px;color:var(--et-navy);box-sizing:border-box;margin-bottom:10px;}",\n' +
  '".confirm-btn{background:var(--et-navy);color:white;border:none;padding:9px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;width:100%;}"\n' +
  '].join("");\n' +
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
  'headerText.innerHTML = "<h3><span>' + agencyName + '</span></h3><p>Premium Travel Specialist</p>";\n' +
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
  '  p.innerText = "Tell me your dream destination and I will find the perfect package - flights, hotels and transfers included.";\n' +
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

  'function fmtTime(iso) {\n' +
  '  if (!iso) return "TBC";\n' +
  '  try {\n' +
  '    var d = new Date(iso);\n' +
  '    if (isNaN(d)) return iso;\n' +
  '    return d.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" });\n' +
  '  } catch(e) { return iso; }\n' +
  '}\n' +

  'function fmtPrice(n) {\n' +
  '  return "KES " + (Math.round(Number(n) || 0)).toLocaleString();\n' +
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
  '  var formP = document.createElement("p");\n' +
  '  formP.innerText = "Please enter your name to confirm booking:";\n' +
  '  var nameInput = document.createElement("input");\n' +
  '  nameInput.className = "name-input";\n' +
  '  nameInput.placeholder = "Your full name";\n' +
  '  nameInput.type = "text";\n' +
  '  var confirmBtn = document.createElement("button");\n' +
  '  confirmBtn.className = "confirm-btn";\n' +
  '  confirmBtn.innerText = "Confirm Booking";\n' +
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
  '      addMsg("Booking confirmed for " + guestName + "! Ref: " + data.bookingRef + ". You will receive confirmation shortly.", "bot");\n' +
  '      messages.scrollTop = messages.scrollHeight;\n' +
  '    })\n' +
  '    .catch(function() { confirmBtn.innerText = "Failed - Try Again"; confirmBtn.disabled = false; });\n' +
  '  };\n' +
  '  form.appendChild(formP);\n' +
  '  form.appendChild(nameInput);\n' +
  '  form.appendChild(confirmBtn);\n' +
  '  messages.appendChild(form);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '  nameInput.focus();\n' +
  '}\n' +

  // ── addPackage: only show sections that exist ──
  'function addPackage(p, i) {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "package";\n' +
  '  div.style.height = "auto";\n' +
  '  var transport       = p.transport       || null;\n' +
  '  var returnTransport = p.returnTransport || null;\n' +
  '  var hotel     = p.hotel     || null;\n' +
  '  var transfers = p.transfers || null;\n' +
  '  var summary   = p.summary   || {};\n' +
  '  var currency  = (transport && transport.currency) || "KES";\n' +
  '  var total     = Math.round(summary.totalPrice || 0);\n' +
  '  var ppp       = Math.round(summary.pricePerPerson || 0);\n' +
  '  var nights    = summary.nights    || 0;\n' +
  '  var passengers = summary.passengers || 1;\n' +
  '  var route     = summary.route || ((transport && transport.origin ? transport.origin : "TBC") + " to " + (transport && transport.destination ? transport.destination : "TBC"));\n' +

  '  var pkgHeader = document.createElement("div");\n' +
  '  pkgHeader.className = "pkg-header";\n' +
  '  var pkgTitle = document.createElement("span");\n' +
  '  pkgTitle.className = "pkg-title";\n' +
  '  pkgTitle.innerText = "Option " + (i + 1);\n' +
  '  var pkgRoute = document.createElement("span");\n' +
  '  pkgRoute.className = "pkg-route";\n' +
  '  pkgRoute.innerText = route;\n' +
  '  pkgHeader.appendChild(pkgTitle);\n' +
  '  pkgHeader.appendChild(pkgRoute);\n' +

  '  var pkgBody = document.createElement("div");\n' +
  '  pkgBody.className = "pkg-body";\n' +
  '  pkgBody.style.height = "auto";\n' +

  // Outbound flight/bus
  '  if (transport) {\n' +
  '    var isbus = (transport.transportType || "").toLowerCase() === "bus";\n' +
  '    var tLabel = isbus ? "Outbound Bus" : "Outbound Flight";\n' +
  '    var tName  = transport.airline || transport.provider || "TBC";\n' +
  '    var tSub   = (transport.origin || "TBC") + " \u2192 " + (transport.destination || "TBC") +\n' +
  '                 " | " + fmtTime(transport.departureTime) + " - " + fmtTime(transport.arrivalTime);\n' +
  '    if (transport.stops) tSub += " | " + transport.stops;\n' +
  '    if (transport.cabinClass) tSub += " | " + transport.cabinClass;\n' +
  '    tSub += " | " + fmtPrice(transport.price);\n' +
  '    pkgBody.appendChild(makeRow(tLabel, tName, tSub));\n' +
  '  }\n' +

  // Return flight/bus
  '  if (returnTransport) {\n' +
  '    var isRetBus = (returnTransport.transportType || "").toLowerCase() === "bus";\n' +
  '    var rtLabel = isRetBus ? "Return Bus" : "Return Flight";\n' +
  '    var rtName  = returnTransport.airline || returnTransport.provider || "TBC";\n' +
  '    var rtSub   = (returnTransport.origin || "TBC") + " \u2192 " + (returnTransport.destination || "TBC") +\n' +
  '                  " | " + fmtTime(returnTransport.departureTime) + " - " + fmtTime(returnTransport.arrivalTime);\n' +
  '    if (returnTransport.stops) rtSub += " | " + returnTransport.stops;\n' +
  '    rtSub += " | " + fmtPrice(returnTransport.price);\n' +
  '    pkgBody.appendChild(makeRow(rtLabel, rtName, rtSub));\n' +
  '  }\n' +

  // Hotel — only if present
  '  if (hotel) {\n' +
  '    var stars = hotel.stars ? Array(Math.min(Math.round(hotel.stars), 5) + 1).join("\u2605") : "";\n' +
  '    var hName = (hotel.name || "TBC") + (stars ? " " + stars : "");\n' +
  '    var hSub  = (hotel.location || "TBC");\n' +
  '    if (nights > 0) hSub += " | " + nights + " nights | " + fmtPrice(hotel.pricePerNight) + "/night";\n' +
  '    if (hotel.rating) hSub += " | Rating: " + hotel.rating + "/5";\n' +
  '    if (hotel.mealPlan) hSub += " | " + hotel.mealPlan;\n' +
  '    pkgBody.appendChild(makeRow("Hotel", hName, hSub));\n' +
  '  }\n' +

  // Transfer — only if present
  '  if (transfers && transfers.provider) {\n' +
  '    pkgBody.appendChild(makeRow("Transfer", transfers.provider, (transfers.vehicleType || "Car") + " | " + fmtPrice(transfers.price)));\n' +
  '  }\n' +

  '  var pkgFooter = document.createElement("div");\n' +
  '  pkgFooter.className = "pkg-footer";\n' +
  '  pkgFooter.style.height = "auto";\n' +
  '  var pkgPrice = document.createElement("div");\n' +
  '  pkgPrice.className = "pkg-price";\n' +
  '  pkgPrice.innerText = fmtPrice(total);\n' +
  '  var pkgPriceSub = document.createElement("small");\n' +
  '  pkgPriceSub.innerText = fmtPrice(ppp) + "/person | " + passengers + " traveller(s)";\n' +
  '  pkgPrice.appendChild(pkgPriceSub);\n' +
  '  var bookBtn = document.createElement("button");\n' +
  '  bookBtn.className = "book";\n' +
  '  bookBtn.innerText = "Book Now";\n' +
  '  bookBtn.onclick = function() { showNameForm(p, bookBtn); };\n' +
  '  pkgFooter.appendChild(pkgPrice);\n' +
  '  pkgFooter.appendChild(bookBtn);\n' +
  '  div.appendChild(pkgHeader);\n' +
  '  div.appendChild(pkgBody);\n' +
  '  div.appendChild(pkgFooter);\n' +
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
  '    body: JSON.stringify({\n' +
  '      prompt: text,\n' +
  '      agencyId: "' + agencyKey + '",\n' +
  '      channelType: "widget",\n' +
  '      sessionId: sessionId,\n' +
  '      conversationHistory: conversationHistory,\n' +
  '      previousParams: previousParams\n' +
  '    })\n' +
  '  })\n' +
  '  .then(function(res) { return res.json(); })\n' +
  '  .then(function(data) {\n' +
  '    hideTyping();\n' +
  '    if (data.sessionId) sessionId = data.sessionId;\n' +
  '    if (data.tripParams) previousParams = data.tripParams;\n' +
  '    if (data.conversationHistory) conversationHistory = data.conversationHistory;\n' +
  '    var packages = data && data.packages ? data.packages : [];\n' +
  '    if (!packages.length) {\n' +
  '      addMsg("No packages found. Try specifying destination, number of people and nights.", "bot");\n' +
  '      return;\n' +
  '    }\n' +
  '    var intent = data.intent || {};\n' +
  '    var responseMsg = "I found " + packages.length + " option(s) for you:";\n' +
  '    if (intent.isFollowUp) {\n' +
  '      var adj = intent.adjustments || {};\n' +
  '      if (adj.budget === "low") responseMsg = "Here are more affordable options:";\n' +
  '      else if (adj.budget === "luxury") responseMsg = "Here are the premium options:";\n' +
  '      else if (adj.budget === "mid") responseMsg = "Here are mid-range options:";\n' +
  '      else if (adj.nights) responseMsg = "Here are options for " + adj.nights + " nights:";\n' +
  '      else if (adj.mealPlan === "all_inclusive") responseMsg = "Here are all-inclusive options:";\n' +
  '      else if (adj.mealPlan === "bed_and_breakfast") responseMsg = "Here are options with breakfast included:";\n' +
  '      else if (adj.mealPlan === "full_board") responseMsg = "Here are full board options:";\n' +
  '      else if (adj.seatPreference) responseMsg = "Here are options with " + adj.seatPreference + " seat:";\n' +
  '      else if (adj.passengers) responseMsg = "Here are options for " + adj.passengers + " traveller(s):";\n' +
  '      else responseMsg = "Here are the updated options:";\n' +
  '    }\n' +
  '    addMsg(responseMsg, "bot");\n' +
  '    packages.slice(0, 4).forEach(function(p, i) { addPackage(p, i); });\n' +
  '  })\n' +
  '  .catch(function(e) {\n' +
  '    hideTyping();\n' +
  '    console.log("Widget error:", e);\n' +
  '    addMsg("Unable to load trips right now. Please try again.", "bot");\n' +
  '  });\n' +
  '}\n' +

  'sendBtn.onclick = send;\n' +
  'input.addEventListener("keypress", function(e) { if (e.key === "Enter") send(); });\n' +
  'console.log("[BODRLESS] Widget loaded for: ' + agencyKey + '");\n' +
  '}\n' +
  'if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", initWidget); } else { initWidget(); }\n' +
  '})();\n';

  res.send(widgetCode);
});

module.exports = router;