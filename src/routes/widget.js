const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const agencyKey  = req.query.key  || 'epic-travels';
  const agencyName = req.query.name || 'Epic Travels';
  const mode       = req.query.mode || 'agency'; // 'hotel_direct' for hotel widgets
  const apiBase    = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';
  const isHotelMode = mode === 'hotel_direct';

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  const widgetCode = '(function () {\n' +
  'function initWidget() {\n' +
  'if (!document.body) { setTimeout(initWidget, 50); return; }\n' +
  'if (document.getElementById("bodrless-widget-root")) return;\n' +

  'var conversationHistory = [];\n' +
  'var previousParams = null;\n' +
  'var sessionId = null;\n' +
  'var isHotelMode = ' + String(isHotelMode) + ';\n' +

  'var STORAGE_KEY = "bodrless_widget_' + agencyKey + '";\n' +
  'var transcript = [];\n' +
  'var hasRestoredHistory = false;\n' +

  'function persistState() {\n' +
  '  try {\n' +
  '    var payload = {\n' +
  '      v: 1,\n' +
  '      savedAt: Date.now(),\n' +
  '      transcript: transcript.slice(-20),\n' +
  '      conversationHistory: conversationHistory,\n' +
  '      previousParams: previousParams,\n' +
  '      sessionId: sessionId\n' +
  '    };\n' +
  '    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));\n' +
  '  } catch (e) {}\n' +
  '}\n' +

  'function loadPersistedState() {\n' +
  '  try {\n' +
  '    var raw = localStorage.getItem(STORAGE_KEY);\n' +
  '    if (!raw) return null;\n' +
  '    var parsed = JSON.parse(raw);\n' +
  '    if (!parsed || parsed.v !== 1) return null;\n' +
  '    var ageMs = Date.now() - (parsed.savedAt || 0);\n' +
  '    if (ageMs > 24 * 60 * 60 * 1000) return null;\n' +
  '    return parsed;\n' +
  '  } catch (e) { return null; }\n' +
  '}\n' +

  'var __restored = loadPersistedState();\n' +
  'if (__restored) {\n' +
  '  conversationHistory = __restored.conversationHistory || [];\n' +
  '  previousParams = __restored.previousParams || null;\n' +
  '  sessionId = __restored.sessionId || null;\n' +
  '  transcript = __restored.transcript || [];\n' +
  '  hasRestoredHistory = transcript.length > 0;\n' +
  '}\n' +

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
  '".dob-row{display:flex;gap:6px;margin-bottom:10px;}",\n' +
  '".dob-row select{flex:1;padding:9px 4px;border:1.5px solid var(--et-border);border-radius:10px;outline:none;font-size:12px;color:var(--et-navy);box-sizing:border-box;background:white;}",\n' +
  '".field-label{font-size:10px;color:var(--et-muted);margin-bottom:4px;font-weight:600;}",\n' +
  '".confirm-btn{background:var(--et-navy);color:white;border:none;padding:9px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;width:100%;}",\n' +
  '".trust-badge{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:10px;font-size:10px;color:var(--et-muted);}",\n' +
  '".trust-badge svg{width:13px;height:13px;flex-shrink:0;}",\n' +
  '".itin-stop{padding:10px 0;border-bottom:1px dashed var(--et-border);}",\n' +
  '".itin-stop:last-child{border-bottom:none;}",\n' +
  '".itin-stop.buffer{opacity:0.85;}",\n' +
  '".itin-stop-title{font-size:12px;font-weight:700;color:var(--et-navy);margin-bottom:4px;}",\n' +
  '".itin-stop-title.buffer{color:var(--et-muted);font-style:italic;}",\n' +
  '".itin-line{font-size:11px;color:var(--et-muted);line-height:1.5;margin-bottom:2px;}",\n' +
  '".itin-connects{font-size:10px;color:var(--et-red);font-style:italic;}",\n' +
  '".price-alert{background:#FFF7E6;border:1px solid #F0C36D;border-radius:12px;padding:12px;margin-top:8px;}",\n' +
  '".price-alert p{font-size:12px;color:#5A4A1A;margin:0 0 10px 0;line-height:1.5;}",\n' +
  '".price-alert .old{text-decoration:line-through;color:var(--et-muted);}",\n' +
  '".price-alert .new{color:var(--et-red);font-weight:700;}",\n' +
  '".price-alert-actions{display:flex;gap:8px;}",\n' +
  '".price-approve{flex:1;background:var(--et-navy);color:white;border:none;padding:9px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;}",\n' +
  '".price-cancel{flex:1;background:white;color:var(--et-navy);border:1.5px solid var(--et-border);padding:9px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;}"\n' +
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
  'headerText.innerHTML = "<h3><span>' + agencyName + '</span></h3><p>' + (isHotelMode ? 'Book Direct' : 'Premium Travel Specialist') + '</p>";\n' +
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
  'input.placeholder = isHotelMode ? "Which property and dates?" : "Where would you like to go?";\n' +
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
  'triggerBtn.innerText = isHotelMode ? "Book a Room" : "Plan Your Trip";\n' +
  'document.body.appendChild(triggerBtn);\n' +
  'var welcomeShown = false;\n' +
  'triggerBtn.onclick = function() { chatDiv.classList.add("open"); input.focus(); if (!welcomeShown) { welcomeShown = true; if (hasRestoredHistory) { replayTranscript(); } else { showWelcome(); } } };\n' +
  'closeBtn.onclick = function() { chatDiv.classList.remove("open"); };\n' +

  'function showWelcome() {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "et-welcome";\n' +
  '  var h4 = document.createElement("h4");\n' +
  '  h4.innerText = "Welcome to ' + agencyName + '";\n' +
  '  var p = document.createElement("p");\n' +
  '  p.innerText = isHotelMode\n' +
  '    ? "Tell me which property you\'d like, your dates and number of guests — I\'ll find the right room instantly."\n' +
  '    : "Tell me your dream destination and I will find the perfect package - flights, hotels and transfers included.";\n' +
  '  var suggestionsDiv = document.createElement("div");\n' +
  '  suggestionsDiv.className = "et-suggestions";\n' +
  '  var suggestions = isHotelMode\n' +
  '    ? ["Stanley Nairobi 3 nights","Whitesands Mombasa 5 nights","Mara Game Camp 2 nights","Honeymoon Mombasa 7 nights","2 nights Nairobi then 3 nights Mara"]\n' +
  '    : ["Nairobi to Zanzibar","Cape Town 5 nights","Masai Mara Safari","Kigali Rwanda","Cairo Egypt"];\n' +
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

  'function replayTranscript() {\n' +
  '  var note = document.createElement("div");\n' +
  '  note.className = "msg bot";\n' +
  '  note.style.fontStyle = "italic";\n' +
  '  note.style.opacity = "0.7";\n' +
  '  note.innerText = "\u2014 Continuing where you left off \u2014";\n' +
  '  messages.appendChild(note);\n' +
  '  for (var ri = 0; ri < transcript.length; ri++) {\n' +
  '    var entry = transcript[ri];\n' +
  '    if (!entry || !entry.type) continue;\n' +
  '    if (entry.type === "user" || entry.type === "bot") {\n' +
  '      addMsg(entry.text || "", entry.type);\n' +
  '    } else if (entry.type === "hotel_packages" && Array.isArray(entry.packages)) {\n' +
  '      entry.packages.slice(0, 4).forEach(function(p, i) { addHotelPackage(p, i); });\n' +
  '    } else if (entry.type === "hotel_itinerary" && entry.pkg) {\n' +
  '      addHotelItinerary(entry.pkg);\n' +
  '    } else if (entry.type === "packages" && Array.isArray(entry.packages)) {\n' +
  '      entry.packages.slice(0, 4).forEach(function(p, i) { addPackage(p, i); });\n' +
  '    } else if (entry.type === "itinerary" && entry.pkg) {\n' +
  '      addItinerary(entry.pkg);\n' +
  '    }\n' +
  '  }\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
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

  'function fmtPrice(n, cur) {\n' +
  '  return (cur || "KES") + " " + (Math.round(Number(n) || 0)).toLocaleString();\n' +
  '}\n' +

  'function titleCase(str) {\n' +
  '  if (!str) return "";\n' +
  '  return String(str).replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });\n' +
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

  'function makeHighlightRow(text, tone) {\n' +
  '  var div = document.createElement("div");\n' +
  '  var bg = tone === "good" ? "#E8F8EE" : tone === "warn" ? "#FFF3E0" : "#EEF1F8";\n' +
  '  var fg = tone === "good" ? "#1B7A3D" : tone === "warn" ? "#B05A00" : "#3A4A7A";\n' +
  '  div.style.background = bg;\n' +
  '  div.style.color = fg;\n' +
  '  div.style.padding = "7px 10px";\n' +
  '  div.style.borderRadius = "8px";\n' +
  '  div.style.fontSize = "11px";\n' +
  '  div.style.fontWeight = "700";\n' +
  '  div.style.marginTop = "6px";\n' +
  '  div.innerText = text;\n' +
  '  return div;\n' +
  '}\n' +

  // ─────────────────────────────────────────────
  // HOTEL DIRECT CARD
  // ─────────────────────────────────────────────
  'function addHotelPackage(p, idx) {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "package";\n' +
  '  div.style.height = "auto";\n' +
  '  var hotel = p.hotel || {};\n' +
  '  var summary = p.summary || {};\n' +
  '  var ancillaries = p.ancillaryServices || [];\n' +
  '  var currency = hotel.currency || summary.currency || "KES";\n' +
  '  var nights = hotel.nights || summary.nights || 1;\n' +
  '  var passengers = summary.passengers || 1;\n' +
  '  var baseTotal = hotel.totalRate || (hotel.pricePerNight * nights) || summary.totalPrice || 0;\n' +
  '  var currentTotal = baseTotal;\n' +
  '  var selectedAncillaries = [];\n' +
  '  var currentMealPlan = hotel.mealPlan || "bed_and_breakfast";\n' +
  '  var mealLabels = { room_only:"Room Only", bed_and_breakfast:"Bed & Breakfast", half_board:"Half Board", full_board:"Full Board", all_inclusive:"All Inclusive" };\n' +
  '  var pkgHeader = document.createElement("div");\n' +
  '  pkgHeader.className = "pkg-header";\n' +
  '  var pkgTitle = document.createElement("span");\n' +
  '  pkgTitle.className = "pkg-title";\n' +
  '  pkgTitle.innerText = "Option " + (idx + 1);\n' +
  '  var pkgRoute = document.createElement("span");\n' +
  '  pkgRoute.className = "pkg-route";\n' +
  '  pkgRoute.innerText = hotel.location || summary.route || "Room";\n' +
  '  pkgHeader.appendChild(pkgTitle);\n' +
  '  pkgHeader.appendChild(pkgRoute);\n' +
  '  var pkgBody = document.createElement("div");\n' +
  '  pkgBody.className = "pkg-body";\n' +
  '  pkgBody.style.height = "auto";\n' +
  // Image
  '  var images = hotel.images || [];\n' +
  '  if (images.length > 0) {\n' +
  '    var img = document.createElement("img");\n' +
  '    img.src = images[0];\n' +
  '    img.alt = hotel.roomType || hotel.name || "Room";\n' +
  '    img.style.cssText = "width:100%;height:160px;object-fit:cover;border-radius:10px;margin-bottom:10px;display:block;";\n' +
  '    img.onerror = function() { this.style.display = "none"; };\n' +
  '    pkgBody.appendChild(img);\n' +
  '  }\n' +
  // Hotel name row
  '  var stars = hotel.stars ? Array(Math.min(Math.round(hotel.stars),5)+1).join("\\u2605") : "";\n' +
  '  pkgBody.appendChild(makeRow("Hotel", (hotel.propertyName || hotel.name || "TBC") + (stars ? " " + stars : ""), hotel.location || hotel.address || ""));\n' +
  // Room row
  '  var roomSub = [];\n' +
  '  if (hotel.bedType) roomSub.push(hotel.bedType);\n' +
  '  if (hotel.view) roomSub.push(hotel.view);\n' +
  '  pkgBody.appendChild(makeRow("Room", hotel.roomType || "Standard Room", roomSub.join(" | ")));\n' +
  // Dates row
  '  pkgBody.appendChild(makeRow("Dates", (hotel.checkIn || "") + " \\u2192 " + (hotel.checkOut || ""), nights + " night" + (nights !== 1 ? "s" : "") + " | " + passengers + " guest(s)"));\n' +
  // Meal plan — dropdown if multiple rates, display if one
  '  var availableRates = hotel.availableRates || [];\n' +
  '  var mealRow = document.createElement("div");\n' +
  '  mealRow.className = "pkg-row";\n' +
  '  var mealLabel = document.createElement("div");\n' +
  '  mealLabel.className = "pkg-label";\n' +
  '  mealLabel.innerText = "Meal Plan";\n' +
  '  mealRow.appendChild(mealLabel);\n' +
  '  if (availableRates.length > 1) {\n' +
  '    var mealSelect = document.createElement("select");\n' +
  '    mealSelect.style.cssText = "flex:1;padding:7px 10px;border:1.5px solid var(--et-border);border-radius:8px;font-size:12px;color:var(--et-navy);background:var(--et-cream);margin-top:4px;";\n' +
  '    availableRates.forEach(function(rate) {\n' +
  '      var opt = document.createElement("option");\n' +
  '      opt.value = rate.ratePlanId;\n' +
  '      opt.setAttribute("data-price", rate.pricePerNight);\n' +
  '      opt.setAttribute("data-meal", rate.mealPlan);\n' +
  '      opt.selected = rate.mealPlan === currentMealPlan;\n' +
  '      opt.innerText = (mealLabels[rate.mealPlan] || rate.mealPlan) + " — " + currency + " " + Math.round(rate.pricePerNight).toLocaleString() + "/night";\n' +
  '      mealSelect.appendChild(opt);\n' +
  '    });\n' +
  '    mealSelect.onchange = function() {\n' +
  '      var opt = mealSelect.options[mealSelect.selectedIndex];\n' +
  '      currentMealPlan = opt.getAttribute("data-meal");\n' +
  '      hotel.ratePlanId = opt.value;\n' +
  '      baseTotal = parseFloat(opt.getAttribute("data-price")) * nights;\n' +
  '      currentTotal = baseTotal + selectedAncillaries.reduce(function(s,a) {\n' +
  '        if (a.priceBasis==="per_person") return s+(a.price*passengers);\n' +
  '        if (a.priceBasis==="per_night") return s+(a.price*nights);\n' +
  '        return s+a.price;\n' +
  '      }, 0);\n' +
  '      var el = document.getElementById("htl-total-"+idx);\n' +
  '      if (el) el.innerText = currency + " " + Math.round(currentTotal).toLocaleString();\n' +
  '    };\n' +
  '    mealRow.appendChild(mealSelect);\n' +
  '  } else {\n' +
  '    var mealDisplay = document.createElement("div");\n' +
  '    mealDisplay.className = "pkg-name";\n' +
  '    mealDisplay.innerText = "\\uD83C\\uDF7D\\uFE0F " + (mealLabels[currentMealPlan] || currentMealPlan);\n' +
  '    mealRow.appendChild(mealDisplay);\n' +
  '  }\n' +
  '  pkgBody.appendChild(mealRow);\n' +
  // Cancellation
  '  if (hotel.policySummary) {\n' +
  '    var tone = hotel.isRefundable === false ? "warn" : hotel.isRefundable === true ? "good" : "neutral";\n' +
  '    pkgBody.appendChild(makeHighlightRow(hotel.policySummary, tone));\n' +
  '  }\n' +
  // Price per night
  '  pkgBody.appendChild(makeRow("Room Rate", currency + " " + Math.round(hotel.pricePerNight||0).toLocaleString() + "/night", "\\u00d7 " + nights + " night" + (nights!==1?"s":"") + " = " + currency + " " + Math.round(baseTotal).toLocaleString()));\n' +
  // Ancillaries
  '  if (ancillaries.length > 0) {\n' +
  '    var ancRow = document.createElement("div");\n' +
  '    ancRow.className = "pkg-row";\n' +
  '    var ancLabel = document.createElement("div");\n' +
  '    ancLabel.className = "pkg-label";\n' +
  '    ancLabel.innerText = "Add-ons";\n' +
  '    ancRow.appendChild(ancLabel);\n' +
  '    var catIcons = {spa:"\\uD83D\\uDEC6",transfer:"\\uD83D\\uDE97",dining:"\\uD83C\\uDF7D\\uFE0F",activity:"\\uD83C\\uDFC4",upgrade:"\\u2B06\\uFE0F",wellness:"\\uD83E\\uDDD8",other:"\\u2728"};\n' +
  '    ancillaries.forEach(function(anc) {\n' +
  '      var ancItem = document.createElement("div");\n' +
  '      ancItem.style.cssText = "display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px dashed var(--et-border);";\n' +
  '      var cb = document.createElement("input");\n' +
  '      cb.type = "checkbox";\n' +
  '      cb.style.cssText = "margin-top:3px;flex-shrink:0;accent-color:var(--et-navy);";\n' +
  '      var ancInfo = document.createElement("div");\n' +
  '      ancInfo.style.flex = "1";\n' +
  '      var ancName = document.createElement("div");\n' +
  '      ancName.style.cssText = "font-size:12px;font-weight:600;color:var(--et-navy);";\n' +
  '      ancName.innerText = (catIcons[anc.category]||"\\u2728") + " " + anc.name;\n' +
  '      var basisStr = anc.priceBasis==="per_person"?"/person":anc.priceBasis==="per_night"?"/night":"";\n' +
  '      var ancPrice = document.createElement("div");\n' +
  '      ancPrice.style.cssText = "font-size:11px;color:var(--et-muted);";\n' +
  '      ancPrice.innerText = currency + " " + Math.round(anc.price).toLocaleString() + basisStr;\n' +
  '      ancInfo.appendChild(ancName);\n' +
  '      ancInfo.appendChild(ancPrice);\n' +
  '      if (anc.description) {\n' +
  '        var ancDesc = document.createElement("div");\n' +
  '        ancDesc.style.cssText = "font-size:11px;color:var(--et-muted);margin-top:2px;";\n' +
  '        ancDesc.innerText = anc.description;\n' +
  '        ancInfo.appendChild(ancDesc);\n' +
  '      }\n' +
  '      ancItem.appendChild(cb);\n' +
  '      ancItem.appendChild(ancInfo);\n' +
  '      ancRow.appendChild(ancItem);\n' +
  '      cb.onchange = function() {\n' +
  '        if (cb.checked) { selectedAncillaries.push(anc); }\n' +
  '        else { selectedAncillaries = selectedAncillaries.filter(function(a) { return a.id !== anc.id; }); }\n' +
  '        currentTotal = baseTotal + selectedAncillaries.reduce(function(s,a) {\n' +
  '          if (a.priceBasis==="per_person") return s+(a.price*passengers);\n' +
  '          if (a.priceBasis==="per_night") return s+(a.price*nights);\n' +
  '          return s+a.price;\n' +
  '        }, 0);\n' +
  '        var el = document.getElementById("htl-total-"+idx);\n' +
  '        if (el) el.innerText = currency + " " + Math.round(currentTotal).toLocaleString();\n' +
  '      };\n' +
  '    });\n' +
  '    pkgBody.appendChild(ancRow);\n' +
  '  }\n' +
  // Footer
  '  var pkgFooter = document.createElement("div");\n' +
  '  pkgFooter.className = "pkg-footer";\n' +
  '  pkgFooter.style.height = "auto";\n' +
  '  var priceDiv = document.createElement("div");\n' +
  '  priceDiv.className = "pkg-price";\n' +
  '  var priceMain = document.createElement("span");\n' +
  '  priceMain.id = "htl-total-" + idx;\n' +
  '  priceMain.innerText = currency + " " + Math.round(baseTotal).toLocaleString();\n' +
  '  var priceSub = document.createElement("small");\n' +
  '  priceSub.innerText = currency + " " + Math.round(hotel.pricePerNight||0).toLocaleString() + "/night";\n' +
  '  priceDiv.appendChild(priceMain);\n' +
  '  priceDiv.appendChild(priceSub);\n' +
  '  var bookBtn = document.createElement("button");\n' +
  '  bookBtn.className = "book";\n' +
  '  bookBtn.innerText = "Book Now";\n' +
  '  bookBtn.onclick = function() {\n' +
  '    var enriched = JSON.parse(JSON.stringify(p));\n' +
  '    enriched.hotel.mealPlan = currentMealPlan;\n' +
  '    enriched.selectedAncillaries = selectedAncillaries;\n' +
  '    enriched.summary.totalPrice = currentTotal;\n' +
  '    showHotelGuestForm(enriched, bookBtn);\n' +
  '  };\n' +
  '  pkgFooter.appendChild(priceDiv);\n' +
  '  pkgFooter.appendChild(bookBtn);\n' +
  '  div.appendChild(pkgHeader);\n' +
  '  div.appendChild(pkgBody);\n' +
  '  div.appendChild(pkgFooter);\n' +
  '  messages.appendChild(div);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  // ─────────────────────────────────────────────
  // HOTEL ITINERARY CARD
  // ─────────────────────────────────────────────
  'function addHotelItinerary(p) {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "package";\n' +
  '  div.style.height = "auto";\n' +
  '  var summary = p.summary || {};\n' +
  '  var legs = p.legs || [];\n' +
  '  var currency = summary.currency || "KES";\n' +
  '  var pkgHeader = document.createElement("div");\n' +
  '  pkgHeader.className = "pkg-header";\n' +
  '  var pkgTitle = document.createElement("span");\n' +
  '  pkgTitle.className = "pkg-title";\n' +
  '  pkgTitle.innerText = "Your Itinerary";\n' +
  '  var pkgRoute = document.createElement("span");\n' +
  '  pkgRoute.className = "pkg-route";\n' +
  '  pkgRoute.innerText = summary.route || "";\n' +
  '  pkgHeader.appendChild(pkgTitle);\n' +
  '  pkgHeader.appendChild(pkgRoute);\n' +
  '  var pkgBody = document.createElement("div");\n' +
  '  pkgBody.className = "pkg-body";\n' +
  '  pkgBody.style.height = "auto";\n' +
  '  legs.forEach(function(leg, i) {\n' +
  '    var stopDiv = document.createElement("div");\n' +
  '    stopDiv.className = "itin-stop";\n' +
  '    var titleDiv = document.createElement("div");\n' +
  '    titleDiv.className = "itin-stop-title";\n' +
  '    titleDiv.innerText = "Stop " + (i+1) + ": " + titleCase(leg.destination) + " (" + (leg.nights||1) + " night" + ((leg.nights||1)===1?"":"s") + ")";\n' +
  '    stopDiv.appendChild(titleDiv);\n' +
  '    if (leg.hotel) {\n' +
  '      var h = leg.hotel;\n' +
  '      var stars = h.stars ? Array(Math.min(Math.round(h.stars),5)+1).join("\\u2605") : "";\n' +
  '      var hLine = document.createElement("div");\n' +
  '      hLine.className = "itin-line";\n' +
  '      hLine.innerText = "\\uD83C\\uDFE8 " + (h.propertyName||h.name||"TBC") + (stars?" "+stars:"") + " | " + (h.roomType||"") + (h.view?" — "+h.view:"") + " | " + fmtPrice(h.pricePerNight, h.currency) + "/night \\u00d7 " + (leg.nights||1);\n' +
  '      stopDiv.appendChild(hLine);\n' +
  '      if (h.mealPlan) {\n' +
  '        var mpLine = document.createElement("div");\n' +
  '        mpLine.className = "itin-line";\n' +
  '        mpLine.innerText = "\\uD83C\\uDF7D\\uFE0F " + h.mealPlan.replace(/_/g," ");\n' +
  '        stopDiv.appendChild(mpLine);\n' +
  '      }\n' +
  '    }\n' +
  '    pkgBody.appendChild(stopDiv);\n' +
  '  });\n' +
  '  var pkgFooter = document.createElement("div");\n' +
  '  pkgFooter.className = "pkg-footer";\n' +
  '  pkgFooter.style.height = "auto";\n' +
  '  var pkgPrice = document.createElement("div");\n' +
  '  pkgPrice.className = "pkg-price";\n' +
  '  pkgPrice.innerText = fmtPrice(Math.round(summary.totalPrice||0), currency);\n' +
  '  var pkgPriceSub = document.createElement("small");\n' +
  '  pkgPriceSub.innerText = fmtPrice(Math.round(summary.pricePerPerson||0), currency) + "/person | " + (summary.passengers||1) + " guest(s)";\n' +
  '  pkgPrice.appendChild(pkgPriceSub);\n' +
  '  var bookBtn = document.createElement("button");\n' +
  '  bookBtn.className = "book";\n' +
  '  bookBtn.innerText = "Book This Itinerary";\n' +
  '  bookBtn.onclick = function() { showHotelGuestForm(p, bookBtn); };\n' +
  '  pkgFooter.appendChild(pkgPrice);\n' +
  '  pkgFooter.appendChild(bookBtn);\n' +
  '  div.appendChild(pkgHeader);\n' +
  '  div.appendChild(pkgBody);\n' +
  '  div.appendChild(pkgFooter);\n' +
  '  messages.appendChild(div);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  // ─────────────────────────────────────────────
  // HOTEL GUEST FORM — simpler than agency form, no passport needed
  // ─────────────────────────────────────────────
  'function showHotelGuestForm(p, bookBtn) {\n' +
  '  var existing = document.getElementById("et-hotel-form");\n' +
  '  if (existing) existing.remove();\n' +
  '  var hotel = p.hotel || {};\n' +
  '  var summary = p.summary || {};\n' +
  '  var currency = hotel.currency || summary.currency || "KES";\n' +
  '  var total = summary.totalPrice || hotel.totalRate || 0;\n' +
  '  var form = document.createElement("div");\n' +
  '  form.className = "name-form";\n' +
  '  form.id = "et-hotel-form";\n' +
  '  var formTitle = document.createElement("p");\n' +
  '  formTitle.innerText = "Complete your reservation:";\n' +
  '  form.appendChild(formTitle);\n' +
  // Summary strip
  '  var strip = document.createElement("div");\n' +
  '  strip.style.cssText = "background:var(--et-cream);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--et-navy);margin-bottom:12px;";\n' +
  '  var ancNames = (p.selectedAncillaries||[]).map(function(a){return a.name;});\n' +
  '  strip.innerHTML = "<strong>" + (hotel.propertyName||hotel.name||"") + "</strong><br>" +\n' +
  '    (hotel.roomType||"") + (hotel.mealPlan ? " | " + hotel.mealPlan.replace(/_/g," ") : "") + "<br>" +\n' +
  '    (hotel.checkIn||"") + " \\u2192 " + (hotel.checkOut||"") + "<br>" +\n' +
  '    (ancNames.length?"Add-ons: "+ancNames.join(", ")+"<br>":"") +\n' +
  '    "<strong>Total: " + currency + " " + Math.round(total).toLocaleString() + "</strong>";\n' +
  '  form.appendChild(strip);\n' +
  '  var nameInput = document.createElement("input");\n' +
  '  nameInput.className = "name-input";\n' +
  '  nameInput.placeholder = "Full name";\n' +
  '  nameInput.type = "text";\n' +
  '  form.appendChild(nameInput);\n' +
  '  var phoneInput = document.createElement("input");\n' +
  '  phoneInput.className = "name-input";\n' +
  '  phoneInput.placeholder = "Phone number";\n' +
  '  phoneInput.type = "tel";\n' +
  '  form.appendChild(phoneInput);\n' +
  '  var emailInput = document.createElement("input");\n' +
  '  emailInput.className = "name-input";\n' +
  '  emailInput.placeholder = "Email (for voucher)";\n' +
  '  emailInput.type = "email";\n' +
  '  form.appendChild(emailInput);\n' +
  '  var reqInput = document.createElement("textarea");\n' +
  '  reqInput.className = "name-input";\n' +
  '  reqInput.placeholder = "Special requests (optional)";\n' +
  '  reqInput.style.cssText = "height:60px;resize:none;";\n' +
  '  form.appendChild(reqInput);\n' +
  '  var errorMsg = document.createElement("div");\n' +
  '  errorMsg.style.cssText = "color:var(--et-red);font-size:11px;margin-bottom:8px;display:none;";\n' +
  '  form.appendChild(errorMsg);\n' +
  '  var confirmBtn = document.createElement("button");\n' +
  '  confirmBtn.className = "confirm-btn";\n' +
  '  confirmBtn.innerText = "Confirm Reservation";\n' +
  '  confirmBtn.onclick = function() {\n' +
  '    errorMsg.style.display = "none";\n' +
  '    var name = nameInput.value.trim();\n' +
  '    var phone = phoneInput.value.trim();\n' +
  '    if (!name)  { errorMsg.innerText = "Please enter your name.";  errorMsg.style.display = "block"; return; }\n' +
  '    if (!phone) { errorMsg.innerText = "Please enter your phone."; errorMsg.style.display = "block"; return; }\n' +
  '    confirmBtn.innerText = "Processing...";\n' +
  '    confirmBtn.disabled = true;\n' +
  '    fetch("' + apiBase + '/api/hotel/reserve", {\n' +
  '      method: "POST",\n' +
  '      headers: { "Content-Type": "application/json", "x-hotel-key": "' + agencyKey + '" },\n' +
  '      body: JSON.stringify({\n' +
  '        groupSlug: "' + agencyKey + '",\n' +
  '        pkg: p,\n' +
  '        selectedAncillaries: p.selectedAncillaries || [],\n' +
  '        guestName: name,\n' +
  '        guestPhone: phone,\n' +
  '        guestEmail: emailInput.value.trim() || null,\n' +
  '        specialRequests: reqInput.value.trim() || null,\n' +
  '        channel: "widget"\n' +
  '      })\n' +
  '    })\n' +
  '    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })\n' +
  '    .then(function(result) {\n' +
  '      if (!result.ok || !result.data.success) {\n' +
  '        errorMsg.innerText = (result.data&&result.data.error) || "Reservation failed. Please try again.";\n' +
  '        errorMsg.style.display = "block";\n' +
  '        confirmBtn.innerText = "Confirm Reservation";\n' +
  '        confirmBtn.disabled = false;\n' +
  '        return;\n' +
  '      }\n' +
  '      form.remove();\n' +
  '      var ref = result.data.reservationRef;\n' +
  '      addMsg("\\uD83C\\uDFE8 Reservation " + ref + " confirmed! " + currency + " " + Math.round(total).toLocaleString() + " due.", "bot");\n' +
  '      if (result.data.paymentType === "mpesa" || result.data.paymentType === "both") {\n' +
  '        fetch("' + apiBase + '/api/hotel/pay", {\n' +
  '          method: "POST",\n' +
  '          headers: { "Content-Type": "application/json", "x-hotel-key": "' + agencyKey + '" },\n' +
  '          body: JSON.stringify({ reservationRef: ref, guestPhone: phone })\n' +
  '        })\n' +
  '        .then(function(r) { return r.json(); })\n' +
  '        .then(function(pd) {\n' +
  '          if (pd.success && pd.paymentMethod === "card" && pd.paymentLink) {\n' +
  '            addMsg("Click to pay: " + pd.paymentLink, "bot");\n' +
  '          } else if (pd.success) {\n' +
  '            addMsg(pd.message || "Check your phone to complete payment.", "bot");\n' +
  '          } else {\n' +
  '            addMsg("Reservation confirmed as " + ref + ". The hotel will contact you to arrange payment.", "bot");\n' +
  '          }\n' +
  '          messages.scrollTop = messages.scrollHeight;\n' +
  '        });\n' +
  '      } else {\n' +
  '        addMsg("Your reservation " + ref + " is confirmed. The hotel will contact you to arrange payment.", "bot");\n' +
  '      }\n' +
  '      if (bookBtn) { bookBtn.innerText = "Reserved \\u2713"; bookBtn.style.background = "var(--et-green)"; bookBtn.disabled = true; }\n' +
  '    })\n' +
  '    .catch(function() {\n' +
  '      errorMsg.innerText = "Network error. Please try again.";\n' +
  '      errorMsg.style.display = "block";\n' +
  '      confirmBtn.innerText = "Confirm Reservation";\n' +
  '      confirmBtn.disabled = false;\n' +
  '    });\n' +
  '  };\n' +
  '  form.appendChild(confirmBtn);\n' +
  '  var trustBadge = document.createElement("div");\n' +
  '  trustBadge.className = "trust-badge";\n' +
  '  trustBadge.innerHTML = "<svg viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"><path d=\\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\\"/><path d=\\"M9 12l2 2 4-4\\"/></svg> Secure booking";\n' +
  '  form.appendChild(trustBadge);\n' +
  '  messages.appendChild(form);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  // ─────────────────────────────────────────────
  // EXISTING AGENCY FUNCTIONS (unchanged)
  // ─────────────────────────────────────────────
  'function pollBookingStatus(bookingRef, bookBtn) {\n' +
  '  var attempts = 0;\n' +
  '  var maxAttempts = 40;\n' +
  '  var interval = setInterval(function() {\n' +
  '    attempts++;\n' +
  '    fetch("' + apiBase + '/api/trips/booking/" + bookingRef)\n' +
  '      .then(function(r) { return r.json(); })\n' +
  '      .then(function(data) {\n' +
  '        if (data.bookingStage === "paid") {\n' +
  '          clearInterval(interval);\n' +
  '          bookBtn.innerText = "Paid & Confirmed!";\n' +
  '          bookBtn.style.background = "#27ae60";\n' +
  '          addMsg("Payment received! Your booking " + bookingRef + " is fully confirmed. You will receive your e-ticket and hotel confirmation shortly.", "bot");\n' +
  '          messages.scrollTop = messages.scrollHeight;\n' +
  '        } else if (data.bookingStage === "failed" || data.status === "cancelled") {\n' +
  '          clearInterval(interval);\n' +
  '          bookBtn.innerText = "Payment not received";\n' +
  '          bookBtn.style.background = "#C0392B";\n' +
  '          addMsg("We did not receive payment in time for booking " + bookingRef + ", so the hold was released. Feel free to search again if you would still like to book.", "bot");\n' +
  '          messages.scrollTop = messages.scrollHeight;\n' +
  '        } else if (attempts >= maxAttempts) {\n' +
  '          clearInterval(interval);\n' +
  '          addMsg("Still waiting on payment for booking " + bookingRef + ". If you have already paid, this will update shortly \u2014 otherwise you have a bit more time before the hold expires.", "bot");\n' +
  '          messages.scrollTop = messages.scrollHeight;\n' +
  '        }\n' +
  '      })\n' +
  '      .catch(function() {});\n' +
  '  }, 5000);\n' +
  '}\n' +

  'function showPriceApprovalAlert(priceInfo, bookCtx, bookBtn) {\n' +
  '  var existing = document.getElementById("et-price-alert");\n' +
  '  if (existing) existing.remove();\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "price-alert";\n' +
  '  div.id = "et-price-alert";\n' +
  '  var p = document.createElement("p");\n' +
  '  p.innerHTML = "Once the real date of birth was applied for the child traveler, the hotel price changed: " +\n' +
  '    "<span class=\\"old\\">" + fmtPrice(priceInfo.oldPrice, priceInfo.currency) + "</span> \u2192 " +\n' +
  '    "<span class=\\"new\\">" + fmtPrice(priceInfo.newPrice, priceInfo.currency) + "</span>." +\n' +
  '    (priceInfo.flightHeld ? " Your flight is held and not yet charged \u2014 it will simply expire if you cancel." : "");\n' +
  '  div.appendChild(p);\n' +
  '  var actions = document.createElement("div");\n' +
  '  actions.className = "price-alert-actions";\n' +
  '  var approveBtn = document.createElement("button");\n' +
  '  approveBtn.className = "price-approve";\n' +
  '  approveBtn.innerText = "Approve new price";\n' +
  '  var cancelBtn = document.createElement("button");\n' +
  '  cancelBtn.className = "price-cancel";\n' +
  '  cancelBtn.innerText = "Cancel booking";\n' +
  '  actions.appendChild(approveBtn);\n' +
  '  actions.appendChild(cancelBtn);\n' +
  '  div.appendChild(actions);\n' +
  '  messages.appendChild(div);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '  cancelBtn.onclick = function() {\n' +
  '    div.remove();\n' +
  '    addMsg("Booking cancelled \u2014 no payment was taken. Feel free to search again if you would like different dates or a different hotel.", "bot");\n' +
  '  };\n' +
  '  approveBtn.onclick = function() {\n' +
  '    approveBtn.disabled = true;\n' +
  '    cancelBtn.disabled = true;\n' +
  '    approveBtn.innerText = "Processing...";\n' +
  '    fetch("' + apiBase + '/api/trips/book-init", {\n' +
  '      method: "POST",\n' +
  '      headers: { "Content-Type": "application/json" },\n' +
  '      body: JSON.stringify({ agencyId: "' + agencyKey + '", guestName: bookCtx.guestName, guestPhone: bookCtx.phone, guestEmail: bookCtx.email, passengers: bookCtx.passengers, package: bookCtx.pkg, priceApproved: true })\n' +
  '    })\n' +
  '    .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })\n' +
  '    .then(function(result) {\n' +
  '      div.remove();\n' +
  '      if (!result.ok || !result.data.success) { addMsg((result.data&&result.data.error)||"Booking failed at the new price. Please try again.", "bot"); return; }\n' +
  '      continueToPayment(result.data, bookCtx, bookBtn);\n' +
  '    })\n' +
  '    .catch(function() { div.remove(); addMsg("Network error confirming the new price. Please try again.", "bot"); });\n' +
  '  };\n' +
  '}\n' +

  'function continueToPayment(data, bookCtx, bookBtn) {\n' +
  '  var bookingRef = data.bookingRef;\n' +
  '  var totalPrice = data.totalPrice;\n' +
  '  var currency = data.currency;\n' +
  '  addMsg("Flight held and hotel confirmed! Ref: " + bookingRef + ". Total due: " + currency + " " + totalPrice.toLocaleString() + ". Sending an M-Pesa payment prompt to " + bookCtx.phone + " now...", "bot");\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '  fetch("' + apiBase + '/api/trips/book-pay", {\n' +
  '    method: "POST",\n' +
  '    headers: { "Content-Type": "application/json" },\n' +
  '    body: JSON.stringify({ bookingRef: bookingRef, phone: bookCtx.phone, amount: totalPrice, currency: currency, email: bookCtx.email, firstName: bookCtx.passengers[0].firstName, lastName: bookCtx.passengers[0].lastName })\n' +
  '  })\n' +
  '  .then(function(pr) { return pr.json().then(function(pdata) { return { ok: pr.ok, data: pdata }; }); })\n' +
  '  .then(function(payResult) {\n' +
  '    if (!payResult.ok || !payResult.data.success) {\n' +
  '      if (bookBtn) { bookBtn.innerText = "Payment failed to send"; bookBtn.style.background = "#C0392B"; }\n' +
  '      addMsg("Your flight and hotel are held, but we could not send the payment prompt (" + (payResult.data.error||"unknown error") + "). Please contact support with booking ref " + bookingRef + ".", "bot");\n' +
  '      return;\n' +
  '    }\n' +
  '    if (bookBtn) { bookBtn.innerText = "Awaiting payment..."; bookBtn.style.background = "#f0ad4e"; bookBtn.disabled = true; }\n' +
  '    addMsg("Check your phone and enter your M-Pesa PIN to complete payment for booking " + bookingRef + ". This booking will be held for 30 minutes.", "bot");\n' +
  '    messages.scrollTop = messages.scrollHeight;\n' +
  '    pollBookingStatus(bookingRef, bookBtn || { innerText: "", style: {} });\n' +
  '  });\n' +
  '}\n' +

  'function showNameForm(p, bookBtn) {\n' +
  '  var existing = document.getElementById("et-name-form");\n' +
  '  if (existing) existing.remove();\n' +
  '  var passengerCount = (p.summary && p.summary.passengers) ? p.summary.passengers : 1;\n' +
  '  var needsFlightDetails = !!(p.transport && (p.transport.transportType || "flight") === "flight");\n' +
  '  var offersSeatSelection = !p.isMultiDestination && !!(p.transport && p.transport.supplier === "duffel");\n' +
  '  var form = document.createElement("div");\n' +
  '  form.className = "name-form";\n' +
  '  form.id = "et-name-form";\n' +
  '  var formP = document.createElement("p");\n' +
  '  formP.innerText = needsFlightDetails ? "Enter passenger details to confirm booking:" : "Enter your details to confirm booking:";\n' +
  '  form.appendChild(formP);\n' +
  '  var passengerInputs = [];\n' +
  '  var currentYear = new Date().getFullYear();\n' +
  '  function buildDobRow() {\n' +
  '    var row = document.createElement("div"); row.className = "dob-row";\n' +
  '    var daySel = document.createElement("select");\n' +
  '    daySel.innerHTML = "<option value=\\"\\">Day</option>" + Array.from({length:31},function(_,i){return "<option value=\\""+(i+1)+"\\">"+(i+1)+"</option>";}).join("");\n' +
  '    var monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];\n' +
  '    var monthSel = document.createElement("select");\n' +
  '    monthSel.innerHTML = "<option value=\\"\\">Month</option>" + monthNames.map(function(m,i){return "<option value=\\""+(i+1)+"\\">" + m+"</option>";}).join("");\n' +
  '    var yearSel = document.createElement("select");\n' +
  '    yearSel.innerHTML = "<option value=\\"\\">Year</option>" + Array.from({length:100},function(_,i){return currentYear-i;}).map(function(y){return "<option value=\\""+y+"\\">"+y+"</option>";}).join("");\n' +
  '    row.appendChild(daySel); row.appendChild(monthSel); row.appendChild(yearSel);\n' +
  '    return { row:row, daySel:daySel, monthSel:monthSel, yearSel:yearSel };\n' +
  '  }\n' +
  '  for (var pi = 0; pi < passengerCount; pi++) {\n' +
  '    var pBlock = document.createElement("div");\n' +
  '    pBlock.style.cssText = "margin-bottom:12px;padding-bottom:10px;border-bottom:" + (pi<passengerCount-1?"1px dashed #E4E8F0":"none") + ";";\n' +
  '    if (passengerCount > 1) { var pLabel = document.createElement("div"); pLabel.style.cssText = "font-size:11px;font-weight:700;color:#1E2A5E;margin-bottom:6px;"; pLabel.innerText = "Traveler "+(pi+1); pBlock.appendChild(pLabel); }\n' +
  '    var firstNameInput = document.createElement("input"); firstNameInput.className = "name-input"; firstNameInput.placeholder = "First name"; firstNameInput.type = "text"; pBlock.appendChild(firstNameInput);\n' +
  '    var lastNameInput = document.createElement("input"); lastNameInput.className = "name-input"; lastNameInput.placeholder = "Last name"; lastNameInput.type = "text"; pBlock.appendChild(lastNameInput);\n' +
  '    var dobLabel = document.createElement("div"); dobLabel.className = "field-label"; dobLabel.innerText = "Date of birth"; pBlock.appendChild(dobLabel);\n' +
  '    var dob = buildDobRow(); pBlock.appendChild(dob.row);\n' +
  '    var genderSelect = document.createElement("select"); genderSelect.className = "name-input"; genderSelect.innerHTML = "<option value=\\"male\\">Male</option><option value=\\"female\\">Female</option>"; pBlock.appendChild(genderSelect);\n' +
  '    var childRow = document.createElement("label"); childRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;color:#1E2A5E;margin-bottom:8px;";\n' +
  '    var childCheckbox = document.createElement("input"); childCheckbox.type = "checkbox"; childRow.appendChild(childCheckbox); childRow.appendChild(document.createTextNode("This traveler is a child")); pBlock.appendChild(childRow);\n' +
  '    var idLabel = document.createElement("div"); idLabel.className = "field-label"; idLabel.innerText = "Passport or National ID number"; pBlock.appendChild(idLabel);\n' +
  '    var idInput = document.createElement("input"); idInput.className = "name-input"; idInput.placeholder = "Passport / ID number"; idInput.type = "text"; pBlock.appendChild(idInput);\n' +
  '    var seatSelect = null;\n' +
  '    if (offersSeatSelection) { var seatLabel = document.createElement("div"); seatLabel.className = "field-label"; seatLabel.innerText = "Seat preference (optional)"; pBlock.appendChild(seatLabel); seatSelect = document.createElement("select"); seatSelect.className = "name-input"; seatSelect.innerHTML = "<option value=\\"\\">No preference</option><option value=\\"window\\">Window</option><option value=\\"aisle\\">Aisle</option><option value=\\"exit_row\\">Exit row</option>"; pBlock.appendChild(seatSelect); }\n' +
  '    passengerInputs.push({ firstNameInput:firstNameInput, lastNameInput:lastNameInput, daySel:dob.daySel, monthSel:dob.monthSel, yearSel:dob.yearSel, genderSelect:genderSelect, childCheckbox:childCheckbox, idInput:idInput, seatSelect:seatSelect });\n' +
  '    form.appendChild(pBlock);\n' +
  '  }\n' +
  '  var contactLabel = document.createElement("div"); contactLabel.style.cssText = "font-size:11px;font-weight:700;color:#1E2A5E;margin-bottom:6px;"; contactLabel.innerText = "Contact details"; form.appendChild(contactLabel);\n' +
  '  var phoneInput = document.createElement("input"); phoneInput.className = "name-input"; phoneInput.placeholder = "Phone (e.g. 0712345678)"; phoneInput.type = "tel"; form.appendChild(phoneInput);\n' +
  '  var emailInput = document.createElement("input"); emailInput.className = "name-input"; emailInput.placeholder = "Email"; emailInput.type = "email"; form.appendChild(emailInput);\n' +
  '  var errorMsg = document.createElement("div"); errorMsg.style.cssText = "color:#C0392B;font-size:11px;margin-bottom:8px;display:none;"; form.appendChild(errorMsg);\n' +
  '  var confirmBtn = document.createElement("button"); confirmBtn.className = "confirm-btn"; confirmBtn.innerText = "Confirm Booking";\n' +
  '  confirmBtn.onclick = function() {\n' +
  '    errorMsg.style.display = "none";\n' +
  '    var passengers = [];\n' +
  '    for (var k = 0; k < passengerInputs.length; k++) {\n' +
  '      var pin = passengerInputs[k];\n' +
  '      var fn = pin.firstNameInput.value.trim(); var ln = pin.lastNameInput.value.trim();\n' +
  '      if (!fn||!ln) { errorMsg.innerText = "Please fill in all traveler names."; errorMsg.style.display = "block"; return; }\n' +
  '      var day = pin.daySel.value, month = pin.monthSel.value, year = pin.yearSel.value;\n' +
  '      if (!day||!month||!year) { errorMsg.innerText = "Please select a complete date of birth for traveler "+(k+1)+"."; errorMsg.style.display = "block"; return; }\n' +
  '      var dobStr = year+"-"+String(month).padStart(2,"0")+"-"+String(day).padStart(2,"0");\n' +
  '      var isChild = pin.childCheckbox.checked;\n' +
  '      var idNum = pin.idInput.value.trim();\n' +
  '      if (!isChild&&!idNum) { errorMsg.innerText = "Passport/ID number is required for traveler "+(k+1)+" (unless marked as a child)."; errorMsg.style.display = "block"; return; }\n' +
  '      passengers.push({ firstName:fn, lastName:ln, dateOfBirth:dobStr, gender:pin.genderSelect.value, type:isChild?"child":"adult", idNumber:idNum||null, seatPreference:(pin.seatSelect&&pin.seatSelect.value)?pin.seatSelect.value:null });\n' +
  '    }\n' +
  '    var phone = phoneInput.value.trim(); var email = emailInput.value.trim();\n' +
  '    if (!phone) { errorMsg.innerText = "Phone number is required."; errorMsg.style.display = "block"; return; }\n' +
  '    if (needsFlightDetails&&!email) { errorMsg.innerText = "Email is required for flight bookings."; errorMsg.style.display = "block"; return; }\n' +
  '    var guestName = passengers[0].firstName+" "+passengers[0].lastName;\n' +
  '    var bookCtx = { guestName:guestName, phone:phone, email:email, passengers:passengers, pkg:p };\n' +
  '    confirmBtn.innerText = "Processing..."; confirmBtn.disabled = true;\n' +
  '    fetch("' + apiBase + '/api/trips/book-init", {\n' +
  '      method: "POST",\n' +
  '      headers: { "Content-Type": "application/json" },\n' +
  '      body: JSON.stringify({ agencyId:"' + agencyKey + '", guestName:guestName, guestPhone:phone, guestEmail:email, passengers:passengers, package:p })\n' +
  '    })\n' +
  '    .then(function(r) { return r.json().then(function(data) { return { ok:r.ok, data:data }; }); })\n' +
  '    .then(function(result) {\n' +
  '      if (!result.ok&&result.data&&result.data.code==="PRICE_CHANGED") { form.remove(); showPriceApprovalAlert(result.data, bookCtx, bookBtn); return; }\n' +
  '      if (!result.ok||!result.data.success) { var msg=(result.data&&result.data.error)?result.data.error:"Booking failed. Please try again."; errorMsg.innerText=msg; errorMsg.style.display="block"; confirmBtn.innerText="Confirm Booking"; confirmBtn.disabled=false; return; }\n' +
  '      form.remove(); continueToPayment(result.data, bookCtx, bookBtn);\n' +
  '    })\n' +
  '    .catch(function() { errorMsg.innerText="Network error. Please try again."; errorMsg.style.display="block"; confirmBtn.innerText="Confirm Booking"; confirmBtn.disabled=false; });\n' +
  '  };\n' +
  '  form.appendChild(confirmBtn);\n' +
  '  var trustBadge = document.createElement("div"); trustBadge.className = "trust-badge";\n' +
  '  trustBadge.innerHTML = "<svg viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"><path d=\\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\\"/><path d=\\"M9 12l2 2 4-4\\"/></svg> Secure payment via M-Pesa";\n' +
  '  form.appendChild(trustBadge);\n' +
  '  messages.appendChild(form);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  'function addPackage(p, i) {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "package";\n' +
  '  div.style.height = "auto";\n' +
  '  var transport = p.transport || null;\n' +
  '  var returnTransport = p.returnTransport || null;\n' +
  '  var hotel = p.hotel || null;\n' +
  '  var transfers = p.transfers || null;\n' +
  '  var summary = p.summary || {};\n' +
  '  var totalCurrency = summary.currency || "KES";\n' +
  '  var total = Math.round(summary.totalPrice || 0);\n' +
  '  var ppp = Math.round(summary.pricePerPerson || 0);\n' +
  '  var nights = summary.nights || 0;\n' +
  '  var passengers = summary.passengers || 1;\n' +
  '  var route = summary.route || ((transport && transport.origin ? transport.origin : "TBC") + " to " + (transport && transport.destination ? transport.destination : "TBC"));\n' +
  '  var pkgHeader = document.createElement("div"); pkgHeader.className = "pkg-header";\n' +
  '  var pkgTitle = document.createElement("span"); pkgTitle.className = "pkg-title"; pkgTitle.innerText = "Option " + (i + 1);\n' +
  '  var pkgRoute = document.createElement("span"); pkgRoute.className = "pkg-route"; pkgRoute.innerText = route;\n' +
  '  pkgHeader.appendChild(pkgTitle); pkgHeader.appendChild(pkgRoute);\n' +
  '  var pkgBody = document.createElement("div"); pkgBody.className = "pkg-body"; pkgBody.style.height = "auto";\n' +
  '  if (transport) {\n' +
  '    var isbus = (transport.transportType || "").toLowerCase() === "bus";\n' +
  '    var tLabel = isbus ? "Outbound Bus" : "Outbound Flight";\n' +
  '    var tName = transport.airline || transport.provider || "TBC";\n' +
  '    var tSub = (transport.origin||"TBC") + " \\u2192 " + (transport.destination||"TBC") + " | " + fmtTime(transport.departureTime) + " - " + fmtTime(transport.arrivalTime);\n' +
  '    if (transport.stops) tSub += " | " + transport.stops;\n' +
  '    if (transport.cabinClass) tSub += " | " + transport.cabinClass;\n' +
  '    if (!isbus && transport.baggageSummary) tSub += " | " + transport.baggageSummary;\n' +
  '    tSub += " | " + fmtPrice(transport.price, transport.currency);\n' +
  '    pkgBody.appendChild(makeRow(tLabel, tName, tSub));\n' +
  '    if (transport.policySummary) pkgBody.appendChild(makeHighlightRow(transport.policySummary, transport.isRefundable===true?"good":transport.isRefundable===false?"warn":"neutral"));\n' +
  '  }\n' +
  '  if (returnTransport) {\n' +
  '    var isRetBus = (returnTransport.transportType||"").toLowerCase()==="bus";\n' +
  '    var rtLabel = isRetBus ? "Return Bus" : "Return Flight";\n' +
  '    var rtName = returnTransport.airline || returnTransport.provider || "TBC";\n' +
  '    var rtSub = (returnTransport.origin||"TBC") + " \\u2192 " + (returnTransport.destination||"TBC") + " | " + fmtTime(returnTransport.departureTime) + " - " + fmtTime(returnTransport.arrivalTime);\n' +
  '    if (returnTransport.stops) rtSub += " | " + returnTransport.stops;\n' +
  '    if (!isRetBus && returnTransport.baggageSummary) rtSub += " | " + returnTransport.baggageSummary;\n' +
  '    rtSub += " | " + fmtPrice(returnTransport.price, returnTransport.currency);\n' +
  '    pkgBody.appendChild(makeRow(rtLabel, rtName, rtSub));\n' +
  '    if (returnTransport.policySummary) pkgBody.appendChild(makeHighlightRow(returnTransport.policySummary, returnTransport.isRefundable===true?"good":returnTransport.isRefundable===false?"warn":"neutral"));\n' +
  '  }\n' +
  '  if (hotel) {\n' +
  '    var stars = hotel.stars ? Array(Math.min(Math.round(hotel.stars),5)+1).join("\\u2605") : "";\n' +
  '    var hName = (hotel.name||"TBC") + (stars?" "+stars:"");\n' +
  '    var hSub = (hotel.location||"TBC");\n' +
  '    if (nights>0) hSub += " | " + nights + " nights | " + fmtPrice(hotel.pricePerNight, hotel.currency) + "/night";\n' +
  '    if (hotel.rating) hSub += " | Rating: " + hotel.rating + "/5";\n' +
  '    if (hotel.images && hotel.images.length > 0) {\n' +
  '      var hotelImg = document.createElement("img"); hotelImg.src = hotel.images[0]; hotelImg.alt = hotel.name||"Hotel";\n' +
  '      hotelImg.style.cssText = "width:100%;height:140px;object-fit:cover;border-radius:10px;margin-bottom:8px;display:block;";\n' +
  '      hotelImg.onerror = function() { this.style.display="none"; };\n' +
  '      pkgBody.appendChild(hotelImg);\n' +
  '    }\n' +
  '    pkgBody.appendChild(makeRow("Hotel", hName, hSub));\n' +
  '    if (hotel.mealPlan) pkgBody.appendChild(makeHighlightRow("\\uD83C\\uDF7D\\uFE0F Board: " + hotel.mealPlan, "neutral"));\n' +
  '    var hPolicyTone = hotel.isRefundable===false?"warn":hotel.isRefundable===true||hotel.policySummary?"good":"neutral";\n' +
  '    pkgBody.appendChild(makeHighlightRow(hotel.policySummary||(hotel.isRefundable===false?"\\u26a0\\uFE0F Non-refundable":"Refund terms confirmed at booking"), hPolicyTone));\n' +
  '  }\n' +
  '  var transferList = Array.isArray(transfers) ? transfers : (transfers?[transfers]:[]);\n' +
  '  if (transferList.length > 0) {\n' +
  '    var transferSub = transferList.map(function(t) { return (t.legType==="departure"?"Departure":t.legType==="arrival"?"Arrival":(t.provider||"Transfer")) + ": " + (t.description||t.location||"TBC") + " (" + fmtPrice(t.price,t.currency) + ")"; }).join(" | ");\n' +
  '    pkgBody.appendChild(makeRow("Transfer", transferList[0].provider||"Bodrless Standard Transfer", transferSub));\n' +
  '  }\n' +
  '  if (p.connectionAdvisory) {\n' +
  '    var advisoryRow = document.createElement("div"); advisoryRow.className = "pkg-row";\n' +
  '    var advisoryLabel = document.createElement("div"); advisoryLabel.className = "pkg-label"; advisoryLabel.innerText = "\\u26a0\\uFE0F Before you book";\n' +
  '    var advisoryText = document.createElement("div"); advisoryText.className = "pkg-sub"; advisoryText.innerText = p.connectionAdvisory;\n' +
  '    advisoryRow.appendChild(advisoryLabel); advisoryRow.appendChild(advisoryText); pkgBody.appendChild(advisoryRow);\n' +
  '  }\n' +
  '  var pkgFooter = document.createElement("div"); pkgFooter.className = "pkg-footer"; pkgFooter.style.height = "auto";\n' +
  '  var pkgPrice = document.createElement("div"); pkgPrice.className = "pkg-price"; pkgPrice.innerText = fmtPrice(total, totalCurrency);\n' +
  '  var pkgPriceSub = document.createElement("small"); pkgPriceSub.innerText = fmtPrice(ppp, totalCurrency) + "/person | " + passengers + " traveller(s)"; pkgPrice.appendChild(pkgPriceSub);\n' +
  '  var bookBtn = document.createElement("button"); bookBtn.className = "book"; bookBtn.innerText = "Book Now";\n' +
  '  bookBtn.onclick = function() { showNameForm(p, bookBtn); };\n' +
  '  pkgFooter.appendChild(pkgPrice); pkgFooter.appendChild(bookBtn);\n' +
  '  div.appendChild(pkgHeader); div.appendChild(pkgBody); div.appendChild(pkgFooter);\n' +
  '  messages.appendChild(div); messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  'function addItinerary(p) {\n' +
  '  var div = document.createElement("div"); div.className = "package"; div.style.height = "auto";\n' +
  '  var summary = p.summary || {}; var legs = p.legs || [];\n' +
  '  var totalCurrency = summary.currency || "KES";\n' +
  '  var total = Math.round(summary.totalPrice||0); var ppp = Math.round(summary.pricePerPerson||0); var passengers = summary.passengers||1;\n' +
  '  var pkgHeader = document.createElement("div"); pkgHeader.className = "pkg-header";\n' +
  '  var pkgTitle = document.createElement("span"); pkgTitle.className = "pkg-title"; pkgTitle.innerText = "Your Itinerary";\n' +
  '  var pkgRoute = document.createElement("span"); pkgRoute.className = "pkg-route"; pkgRoute.innerText = summary.route||"";\n' +
  '  pkgHeader.appendChild(pkgTitle); pkgHeader.appendChild(pkgRoute);\n' +
  '  var pkgBody = document.createElement("div"); pkgBody.className = "pkg-body"; pkgBody.style.height = "auto";\n' +
  '  legs.forEach(function(leg, idx) {\n' +
  '    var stopDiv = document.createElement("div"); stopDiv.className = "itin-stop"+(leg.isBufferLeg?" buffer":"");\n' +
  '    var titleDiv = document.createElement("div"); titleDiv.className = "itin-stop-title"+(leg.isBufferLeg?" buffer":"");\n' +
  '    titleDiv.innerText = leg.isBufferLeg ? "Connection: overnight in "+titleCase(leg.destination) : "Stop "+(idx+1)+": "+titleCase(leg.destination)+" ("+leg.nights+" night"+(leg.nights===1?"":"s")+")";\n' +
  '    stopDiv.appendChild(titleDiv);\n' +
  '    var t = leg.transportIn;\n' +
  '    if (t) {\n' +
  '      var isbus = (t.transportType||"").toLowerCase()==="bus";\n' +
  '      var tLine = document.createElement("div"); tLine.className = "itin-line";\n' +
  '      tLine.innerText = (isbus?"Bus: ":"Flight: ")+(t.airline||t.provider||"TBC")+" | "+(t.origin||"TBC")+" \\u2192 "+(t.destination||"TBC")+" | "+fmtTime(t.departureTime)+"-"+fmtTime(t.arrivalTime)+" | "+fmtPrice(t.price,t.currency);\n' +
  '      stopDiv.appendChild(tLine);\n' +
  '      if (leg.connectsVia && !leg.isBufferLeg) { var connLine = document.createElement("div"); connLine.className = "itin-connects"; connLine.innerText = "Connects via "+titleCase(leg.connectsVia); stopDiv.appendChild(connLine); }\n' +
  '    }\n' +
  '    if (leg.hotel) {\n' +
  '      var h = leg.hotel; var stars = h.stars?Array(Math.min(Math.round(h.stars),5)+1).join("\\u2605"):"";\n' +
  '      var hLine = document.createElement("div"); hLine.className = "itin-line";\n' +
  '      hLine.innerText = "Hotel: "+(h.name||"TBC")+(stars?" "+stars:"")+(h.location?" | "+h.location:"")+" | "+fmtPrice(h.pricePerNight,h.currency)+"/night \\u00d7 "+leg.nights;\n' +
  '      stopDiv.appendChild(hLine);\n' +
  '    }\n' +
  '    pkgBody.appendChild(stopDiv);\n' +
  '  });\n' +
  '  if (p.returnTransport) {\n' +
  '    var rt = p.returnTransport; var isRetBus = (rt.transportType||"").toLowerCase()==="bus";\n' +
  '    var returnDiv = document.createElement("div"); returnDiv.className = "itin-stop";\n' +
  '    var returnTitle = document.createElement("div"); returnTitle.className = "itin-stop-title"; returnTitle.innerText = "Return"; returnDiv.appendChild(returnTitle);\n' +
  '    var returnLine = document.createElement("div"); returnLine.className = "itin-line";\n' +
  '    returnLine.innerText = (isRetBus?"Bus: ":"Flight: ")+(rt.origin||"TBC")+" \\u2192 "+(rt.destination||"TBC")+" | "+fmtTime(rt.departureTime)+"-"+fmtTime(rt.arrivalTime)+" | "+fmtPrice(rt.price,rt.currency);\n' +
  '    returnDiv.appendChild(returnLine); pkgBody.appendChild(returnDiv);\n' +
  '  }\n' +
  '  var pkgFooter = document.createElement("div"); pkgFooter.className = "pkg-footer"; pkgFooter.style.height = "auto";\n' +
  '  var pkgPrice = document.createElement("div"); pkgPrice.className = "pkg-price"; pkgPrice.innerText = fmtPrice(total, totalCurrency);\n' +
  '  var pkgPriceSub = document.createElement("small"); pkgPriceSub.innerText = fmtPrice(ppp,totalCurrency)+"/person | "+passengers+" traveller(s)"; pkgPrice.appendChild(pkgPriceSub);\n' +
  '  var bookBtn = document.createElement("button"); bookBtn.className = "book"; bookBtn.innerText = "Book This Itinerary";\n' +
  '  bookBtn.onclick = function() { showNameForm(p, bookBtn); };\n' +
  '  pkgFooter.appendChild(pkgPrice); pkgFooter.appendChild(bookBtn);\n' +
  '  div.appendChild(pkgHeader); div.appendChild(pkgBody); div.appendChild(pkgFooter);\n' +
  '  messages.appendChild(div); messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  // ─────────────────────────────────────────────
  // SEND FUNCTION — routes hotel direct vs agency
  // ─────────────────────────────────────────────
  'function send() {\n' +
  '  var text = input.value.trim();\n' +
  '  if (!text) return;\n' +
  '  addMsg(text, "user");\n' +
  '  transcript.push({ type: "user", text: text });\n' +
  '  persistState();\n' +
  '  input.value = "";\n' +
  '  showTyping();\n' +
  // Hotel direct uses /api/hotel/orchestrate with x-hotel-key
  // Agency mode uses /api/trips/orchestrate with x-api-key
  '  var endpoint = isHotelMode ? "' + apiBase + '/api/hotel/orchestrate" : "' + apiBase + '/api/trips/orchestrate";\n' +
  '  var headers = isHotelMode\n' +
  '    ? { "Content-Type": "application/json", "x-hotel-key": "' + agencyKey + '" }\n' +
  '    : { "Content-Type": "application/json", "x-api-key": "' + agencyKey + '" };\n' +
  '  var body = isHotelMode\n' +
  '    ? JSON.stringify({ prompt: text, groupSlug: "' + agencyKey + '", sessionId: sessionId, conversationHistory: conversationHistory, previousParams: previousParams })\n' +
  '    : JSON.stringify({ prompt: text, agencyId: "' + agencyKey + '", channelType: "widget", sessionId: sessionId, conversationHistory: conversationHistory, previousParams: previousParams });\n' +
  '  fetch(endpoint, { method: "POST", headers: headers, body: body })\n' +
  '  .then(function(res) { return res.json(); })\n' +
  '  .then(function(data) {\n' +
  '    hideTyping();\n' +
  '    if (data.sessionId) sessionId = data.sessionId;\n' +
  '    if (data.tripParams) previousParams = data.tripParams;\n' +
  '    if (data.conversationHistory) conversationHistory = data.conversationHistory;\n' +
  '    if (data.needsClarification) {\n' +
  '      var clarifyText = data.text || "Could you give me a bit more detail?";\n' +
  '      addMsg(clarifyText, "bot"); transcript.push({ type: "bot", text: clarifyText }); persistState(); return;\n' +
  '    }\n' +
  '    var packages = data && data.packages ? data.packages : [];\n' +
  '    var isHotelDirect = data.isHotelDirect || (packages.length > 0 && packages[0] && packages[0].isHotelDirect);\n' +
  '    var isItinerary = packages.length === 1 && packages[0] && packages[0].isMultiDestination;\n' +
  '    if (!packages.length) {\n' +
  '      var noneText = (data && data.text) ? data.text : "No options found. Try specifying your dates and number of guests.";\n' +
  '      addMsg(noneText, "bot"); transcript.push({ type: "bot", text: noneText }); persistState(); return;\n' +
  '    }\n' +
  '    var responseMsg = data.text || (isHotelDirect ? "Here are the available rooms:" : "I found " + packages.length + " option(s) for you:");\n' +
  '    if (!isHotelDirect && !isItinerary && data.intent && data.intent.isFollowUp) {\n' +
  '      var adj = data.intent.adjustments || {};\n' +
  '      if (adj.budget==="low") responseMsg="Here are more affordable options:";\n' +
  '      else if (adj.budget==="luxury") responseMsg="Here are the premium options:";\n' +
  '      else if (adj.budget==="mid") responseMsg="Here are mid-range options:";\n' +
  '      else if (adj.nights) responseMsg="Here are options for "+adj.nights+" nights:";\n' +
  '      else responseMsg="Here are the updated options:";\n' +
  '    }\n' +
  '    addMsg(responseMsg, "bot");\n' +
  '    transcript.push({ type: "bot", text: responseMsg });\n' +
  '    if (isHotelDirect && isItinerary) {\n' +
  '      addHotelItinerary(packages[0]);\n' +
  '      transcript.push({ type: "hotel_itinerary", pkg: packages[0] });\n' +
  '    } else if (isHotelDirect) {\n' +
  '      packages.slice(0, 4).forEach(function(p, i) { addHotelPackage(p, i); });\n' +
  '      transcript.push({ type: "hotel_packages", packages: packages.slice(0, 4) });\n' +
  '    } else if (isItinerary) {\n' +
  '      addItinerary(packages[0]);\n' +
  '      transcript.push({ type: "itinerary", pkg: packages[0] });\n' +
  '    } else {\n' +
  '      packages.slice(0, 4).forEach(function(p, i) { addPackage(p, i); });\n' +
  '      transcript.push({ type: "packages", packages: packages.slice(0, 4) });\n' +
  '    }\n' +
  '    persistState();\n' +
  '  })\n' +
  '  .catch(function(e) {\n' +
  '    hideTyping();\n' +
  '    console.log("Widget error:", e);\n' +
  '    addMsg("Unable to load options right now. Please try again.", "bot");\n' +
  '  });\n' +
  '}\n' +

  'sendBtn.onclick = send;\n' +
  'input.addEventListener("keypress", function(e) { if (e.key === "Enter") send(); });\n' +
  'console.log("[BODRLESS] Widget loaded for: ' + agencyKey + ' mode: ' + mode + '");\n' +
  '}\n' +
  'if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", initWidget); } else { initWidget(); }\n' +
  '})();\n';

  res.send(widgetCode);
});

module.exports = router;