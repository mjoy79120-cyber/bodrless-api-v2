const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  const agencyKey   = req.query.key   || 'epic-travels';
  const agencyName  = req.query.name  || 'Epic Travels';
  const mode        = req.query.mode  || 'agency';
  const embedTarget = req.query.embed || null;
  const apiBase     = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';
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
  'var embedTarget = ' + JSON.stringify(embedTarget) + ';\n' +

  'var STORAGE_KEY = "bodrless_widget_' + agencyKey + '";\n' +
  'var transcript = [];\n' +
  'var hasRestoredHistory = false;\n' +

  'function persistState() {\n' +
  '  try {\n' +
  '    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v:1, savedAt:Date.now(), transcript:transcript.slice(-20), conversationHistory:conversationHistory, previousParams:previousParams, sessionId:sessionId }));\n' +
  '  } catch(e) {}\n' +
  '}\n' +

  'function loadPersistedState() {\n' +
  '  try {\n' +
  '    var raw = localStorage.getItem(STORAGE_KEY);\n' +
  '    if (!raw) return null;\n' +
  '    var p = JSON.parse(raw);\n' +
  '    if (!p || p.v !== 1) return null;\n' +
  '    if (Date.now() - (p.savedAt||0) > 24*60*60*1000) return null;\n' +
  '    return p;\n' +
  '  } catch(e) { return null; }\n' +
  '}\n' +

  'var __r = loadPersistedState();\n' +
  'if (__r) {\n' +
  '  conversationHistory = __r.conversationHistory || [];\n' +
  '  previousParams = __r.previousParams || null;\n' +
  '  sessionId = __r.sessionId || null;\n' +
  '  transcript = __r.transcript || [];\n' +
  '  hasRestoredHistory = transcript.length > 0;\n' +
  '}\n' +

  // ── STYLES ────────────────────────────────────────────────
  'var style = document.createElement("style");\n' +
  'style.innerHTML = [\n' +
  // CSS variables
  '":root{--et-navy:#1E2A5E;--et-red:#C0392B;--et-white:#FFFFFF;--et-cream:#F9F7F4;--et-border:#E8E3DA;--et-muted:#9A9088;--et-green:#27ae60;--et-gold:#B8964A;}",\n' +

  // Chat container — no fixed position by default, class decides
  '"#bodrless-chat{background:var(--et-white);z-index:999999;display:none;flex-direction:column;border-radius:18px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.14);font-family:\'Inter\',Arial,sans-serif;}",\n' +
  '"#bodrless-chat.open{display:flex;}",\n' +

  // Floating mode — agency default and hotel fallback
  '"#bodrless-chat.floating{position:fixed;bottom:90px;right:24px;width:390px;height:640px;}",\n' +

  // Embedded mode — hotel direct, fills its mount container
  '"#bodrless-chat.embedded{position:relative;width:100%;height:760px;display:flex;border-radius:0;}",\n' +

  '"@keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:0.5;}30%{transform:translateY(-5px);opacity:1;}}",\n' +

  // Header
  '"#et-header{background:var(--et-navy);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}",\n' +
  '"#et-header-left{display:flex;align-items:center;gap:12px;}",\n' +
  '"#et-logo-wrap{width:38px;height:38px;background:rgba(255,255,255,0.1);border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;}",\n' +
  '"#et-logo-wrap img{width:34px;height:34px;object-fit:contain;}",\n' +
  '"#et-header-text h3{font-size:14px;color:white;margin:0 0 1px 0;font-weight:600;letter-spacing:0.2px;}",\n' +
  '"#et-header-text p{font-size:10px;color:rgba(255,255,255,0.5);margin:0;letter-spacing:1px;text-transform:uppercase;}",\n' +
  '"#et-close{background:rgba(255,255,255,0.08);border:none;color:rgba(255,255,255,0.7);width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:background 0.2s;}",\n' +
  '"#et-close:hover{background:rgba(255,255,255,0.18);}",\n' +

  // Messages area
  '"#bodrless-messages{flex:1;padding:20px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:12px;background:var(--et-cream);}",\n' +

  // Message bubbles
  '".msg{padding:11px 15px;border-radius:16px;max-width:82%;font-size:13.5px;line-height:1.55;}",\n' +
  '".user{background:var(--et-navy);color:white;margin-left:auto;border-bottom-right-radius:4px;}",\n' +
  '".bot{background:var(--et-white);color:#2A2A2A;border:1px solid var(--et-border);border-bottom-left-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,0.05);}",\n' +

  // Typing
  '".typing{background:var(--et-white);border:1px solid var(--et-border);padding:12px 16px;border-radius:16px;display:flex;gap:5px;align-items:center;width:fit-content;}",\n' +
  '".typing span{width:6px;height:6px;background:var(--et-navy);border-radius:50%;animation:bounce 1.2s infinite;}",\n' +
  '".typing span:nth-child(2){animation-delay:0.2s;background:var(--et-gold);}",\n' +
  '".typing span:nth-child(3){animation-delay:0.4s;}",\n' +

  // Welcome card — hotel mode only
  '".et-welcome{background:var(--et-white);border-radius:14px;padding:20px;border:1px solid var(--et-border);}",\n' +
  '".et-welcome-eyebrow{font-size:10px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:var(--et-gold);margin-bottom:10px;}",\n' +
  '".et-welcome-title{font-size:18px;font-weight:600;color:var(--et-navy);margin-bottom:8px;line-height:1.3;}",\n' +
  '".et-welcome-body{font-size:13px;color:#5A5A5A;line-height:1.65;margin-bottom:18px;}",\n' +
  '".et-divider{height:1px;background:var(--et-border);margin:4px 0 16px 0;}",\n' +
  '".et-prompts-label{font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--et-muted);margin-bottom:12px;}",\n' +

  // Conversation starter cards
  '".et-starter{width:100%;background:var(--et-cream);border:1px solid var(--et-border);border-radius:12px;padding:14px 16px;text-align:left;cursor:pointer;transition:all 0.2s;margin-bottom:8px;display:block;}",\n' +
  '".et-starter:last-child{margin-bottom:0;}",\n' +
  '".et-starter:hover{background:var(--et-navy);border-color:var(--et-navy);}",\n' +
  '".et-starter:hover .st-title{color:white;}",\n' +
  '".et-starter:hover .st-body{color:rgba(255,255,255,0.7);}",\n' +
  '".st-title{font-size:13px;font-weight:600;color:var(--et-navy);margin-bottom:3px;}",\n' +
  '".st-body{font-size:12px;color:var(--et-muted);line-height:1.45;}",\n' +

  // Agency welcome chips
  '".et-agency-welcome{background:linear-gradient(135deg,#1E2A5E 0%,#2d3f82 100%);border-radius:16px;padding:16px;color:white;border-left:4px solid #C0392B;}",\n' +
  '".et-agency-welcome h4{font-size:14px;margin:0 0 6px 0;}",\n' +
  '".et-agency-welcome p{font-size:12px;margin:0 0 12px 0;color:rgba(255,255,255,0.7);}",\n' +
  '".et-suggestions{display:flex;flex-wrap:wrap;gap:6px;}",\n' +
  '".et-suggestion{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.9);padding:5px 10px;border-radius:20px;font-size:11px;cursor:pointer;}",\n' +

  // Package cards
  '".package{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;overflow:visible;box-shadow:0 2px 12px rgba(0,0,0,0.06);margin-bottom:8px;}",\n' +
  '".pkg-header{background:var(--et-navy);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-radius:14px 14px 0 0;}",\n' +
  '".pkg-title{color:white;font-size:13px;font-weight:600;}",\n' +
  '".pkg-route{background:rgba(255,255,255,0.15);color:white;font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",\n' +
  '".pkg-body{padding:12px 14px;}",\n' +
  '".pkg-row{display:flex;flex-direction:column;padding:8px 0;border-bottom:1px solid var(--et-border);}",\n' +
  '".pkg-row:last-child{border-bottom:none;}",\n' +
  '".pkg-label{font-size:10px;font-weight:700;color:var(--et-gold);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;}",\n' +
  '".pkg-name{font-size:13px;font-weight:600;color:var(--et-navy);margin-bottom:2px;}",\n' +
  '".pkg-sub{font-size:11px;color:var(--et-muted);line-height:1.4;}",\n' +
  '".pkg-footer{padding:10px 14px;background:#FAFAF8;display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--et-border);border-radius:0 0 14px 14px;}",\n' +
  '".pkg-price{font-size:20px;font-weight:700;color:var(--et-navy);line-height:1;}",\n' +
  '".pkg-price small{font-size:10px;color:var(--et-muted);display:block;font-weight:400;margin-top:2px;}",\n' +
  '".book{background:var(--et-gold);color:white;border:none;padding:10px 20px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;letter-spacing:0.3px;transition:opacity 0.2s;}",\n' +
  '".book:hover{opacity:0.88;}",\n' +
  '".book:disabled{opacity:0.6;cursor:not-allowed;}",\n' +

  // Input area
  '"#bodrless-input-area{display:flex;border-top:1px solid var(--et-border);background:var(--et-white);padding:12px;gap:8px;flex-shrink:0;}",\n' +
  '"#bodrless-input{flex:1;padding:10px 14px;border:1.5px solid var(--et-border);border-radius:20px;outline:none;font-size:13px;background:var(--et-cream);color:#2A2A2A;font-family:\'Inter\',Arial,sans-serif;}",\n' +
  '"#bodrless-input:focus{border-color:var(--et-navy);}",\n' +
  '"#bodrless-input::placeholder{color:var(--et-muted);font-size:12px;}",\n' +
  '"#bodrless-send{background:var(--et-navy);color:white;border:none;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 0.2s;}",\n' +
  '"#bodrless-send:hover{background:var(--et-gold);}",\n' +

  // Floating trigger — only shown in floating mode
  '"#bodrless-trigger { z-index: 999998; background: var(--et-navy); color: white; border: none; padding: 13px 20px; border-radius: 999px; cursor: pointer; font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(30,42,94,0.35); }\\n" +'

  // Forms
  '".name-form{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;padding:16px;margin-top:8px;}",\n' +
  '".name-form p{font-size:12px;color:var(--et-navy);margin:0 0 12px 0;font-weight:500;}",\n' +
  '".name-input{width:100%;padding:9px 12px;border:1.5px solid var(--et-border);border-radius:10px;outline:none;font-size:12px;color:#2A2A2A;box-sizing:border-box;margin-bottom:10px;font-family:\'Inter\',Arial,sans-serif;background:var(--et-cream);}",\n' +
  '".name-input:focus{border-color:var(--et-navy);}",\n' +
  '".dob-row{display:flex;gap:6px;margin-bottom:10px;}",\n' +
  '".dob-row select{flex:1;padding:9px 4px;border:1.5px solid var(--et-border);border-radius:10px;outline:none;font-size:12px;color:#2A2A2A;background:white;}",\n' +
  '".field-label{font-size:10px;color:var(--et-muted);margin-bottom:4px;font-weight:600;letter-spacing:0.3px;}",\n' +
  '".confirm-btn{background:var(--et-navy);color:white;border:none;padding:11px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;width:100%;transition:background 0.2s;}",\n' +
  '".confirm-btn:hover{background:var(--et-gold);}",\n' +
  '".trust-badge{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:10px;font-size:10px;color:var(--et-muted);}",\n' +
  '".trust-badge svg{width:12px;height:12px;}",\n' +

  // Highlight rows
  '".hl{padding:7px 10px;border-radius:8px;font-size:11px;font-weight:600;margin-top:6px;}",\n' +
  '".hl-good{background:#E8F8EE;color:#1B7A3D;}",\n' +
  '".hl-warn{background:#FFF3E0;color:#B05A00;}",\n' +
  '".hl-neutral{background:#F0EDE8;color:#5A4A3A;}",\n' +

  // Itinerary
  '".itin-stop{padding:10px 0;border-bottom:1px dashed var(--et-border);}",\n' +
  '".itin-stop:last-child{border-bottom:none;}",\n' +
  '".itin-stop-title{font-size:12px;font-weight:700;color:var(--et-navy);margin-bottom:4px;}",\n' +
  '".itin-line{font-size:11px;color:var(--et-muted);line-height:1.5;margin-bottom:2px;}",\n' +

  // Price alert
  '".price-alert{background:#FFF8EC;border:1px solid #E8C96D;border-radius:12px;padding:12px;margin-top:8px;}",\n' +
  '".price-alert p{font-size:12px;color:#5A4A1A;margin:0 0 10px 0;line-height:1.5;}",\n' +
  '".price-alert-actions{display:flex;gap:8px;}",\n' +
  '".price-approve{flex:1;background:var(--et-navy);color:white;border:none;padding:9px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;}",\n' +
  '".price-cancel{flex:1;background:white;color:var(--et-navy);border:1.5px solid var(--et-border);padding:9px 14px;border-radius:20px;cursor:pointer;font-size:12px;}"\n' +
  '].join("");\n' +
  'document.head.appendChild(style);\n' +

  // ── BUILD DOM ─────────────────────────────────────────────
  'var root = document.createElement("div");\n' +
  'root.id = "bodrless-widget-root";\n' +

  'var chatDiv = document.createElement("div");\n' +
  'chatDiv.id = "bodrless-chat";\n' +

  // Embedded vs floating class
  'if (embedTarget) {\n' +
  '  chatDiv.classList.add("embedded");\n' +
  '} else {\n' +
  '  chatDiv.classList.add("floating");\n' +
  '}\n' +

  // Header
  'var header = document.createElement("div");\n' +
  'header.id = "et-header";\n' +
  'var headerLeft = document.createElement("div");\n' +
  'headerLeft.id = "et-header-left";\n' +
  'var logoWrap = document.createElement("div");\n' +
  'logoWrap.id = "et-logo-wrap";\n' +
  'var logoImg = document.createElement("img");\n' +
  'logoImg.src = "https://epictravels.co.ke/apple-touch-icon.png";\n' +
  'logoImg.alt = "' + agencyName + '";\n' +
  'logoImg.onerror = function() { this.parentNode.innerText = "' + agencyName.charAt(0) + '"; };\n' +
  'logoWrap.appendChild(logoImg);\n' +
  'var headerText = document.createElement("div");\n' +
  'headerText.id = "et-header-text";\n' +
  'headerText.innerHTML = "<h3>' + agencyName + '</h3><p>" + (isHotelMode ? "Concierge" : "Travel Specialist") + "</p>";\n' +
  'headerLeft.appendChild(logoWrap);\n' +
  'headerLeft.appendChild(headerText);\n' +
  'var closeBtn = document.createElement("button");\n' +
  'closeBtn.id = "et-close";\n' +
  'closeBtn.innerHTML = "&#215;";\n' +
  // Hide close button in embedded mode — no floating panel to close
  'if (embedTarget) closeBtn.style.display = "none";\n' +
  'header.appendChild(headerLeft);\n' +
  'header.appendChild(closeBtn);\n' +

  'var messages = document.createElement("div");\n' +
  'messages.id = "bodrless-messages";\n' +

  'var inputArea = document.createElement("div");\n' +
  'inputArea.id = "bodrless-input-area";\n' +
  'var input = document.createElement("input");\n' +
  'input.id = "bodrless-input";\n' +
  'input.placeholder = isHotelMode ? "Tell me what you\'re looking for..." : "Where would you like to go?";\n' +
  'var sendBtn = document.createElement("button");\n' +
  'sendBtn.id = "bodrless-send";\n' +
  'sendBtn.innerHTML = "&#10148;";\n' +
  'inputArea.appendChild(input);\n' +
  'inputArea.appendChild(sendBtn);\n' +
  'chatDiv.appendChild(header);\n' +
  'chatDiv.appendChild(messages);\n' +
  'chatDiv.appendChild(inputArea);\n' +
  'root.appendChild(chatDiv);\n' +

  // Mount: embedded goes into target div, floating goes to body
  'if (embedTarget) {\n' +
  '  var mount = document.getElementById(embedTarget);\n' +
  '  if (mount) { mount.appendChild(root); } else { document.body.appendChild(root); }\n' +
  '} else {\n' +
  '  document.body.appendChild(root);\n' +
  '}\n' +

  // Floating trigger — only in floating mode
  'var welcomeShown = false;\n' +
  'if (!embedTarget) {\n' +
  '  var triggerBtn = document.createElement("button");\n' +
  '  triggerBtn.id = "bodrless-trigger";\n' +
  '  triggerBtn.innerText = isHotelMode ? "Book a Room" : "Plan Your Trip";\n' +
  '  document.body.appendChild(triggerBtn);\n' +
  '  triggerBtn.onclick = function() {\n' +
  '    chatDiv.classList.add("open");\n' +
  '    input.focus();\n' +
  '    if (!welcomeShown) { welcomeShown = true; if (hasRestoredHistory) { replayTranscript(); } else { showWelcome(); } }\n' +
  '  };\n' +
  '  closeBtn.onclick = function() { chatDiv.classList.remove("open"); };\n' +
  '} else {\n' +
  // Embedded: show immediately, no trigger needed
  '  chatDiv.classList.add("open");\n' +
  '  if (!welcomeShown) { welcomeShown = true; if (hasRestoredHistory) { replayTranscript(); } else { showWelcome(); } }\n' +
  '}\n' +

  // ── WELCOME ───────────────────────────────────────────────
  'function showWelcome() {\n' +
  '  if (isHotelMode) {\n' +
  '    showHotelWelcome();\n' +
  '  } else {\n' +
  '    showAgencyWelcome();\n' +
  '  }\n' +
  '}\n' +

  'function showHotelWelcome() {\n' +
  '  var card = document.createElement("div");\n' +
  '  card.className = "et-welcome";\n' +
  '  var eyebrow = document.createElement("div");\n' +
  '  eyebrow.className = "et-welcome-eyebrow";\n' +
  '  eyebrow.innerText = "Your Concierge";\n' +
  '  var title = document.createElement("div");\n' +
  '  title.className = "et-welcome-title";\n' +
  '  title.innerText = "Welcome to ' + agencyName + '";\n' +
  '  var body = document.createElement("div");\n' +
  '  body.className = "et-welcome-body";\n' +
  '  body.innerText = "I\'m here to help you find and book the perfect stay. Tell me which property you\'d like, your dates and number of guests — I\'ll take care of the rest.";\n' +
  '  var divider = document.createElement("div");\n' +
  '  divider.className = "et-divider";\n' +
  '  var promptLabel = document.createElement("div");\n' +
  '  promptLabel.className = "et-prompts-label";\n' +
  '  promptLabel.innerText = "Need inspiration?";\n' +
  '  card.appendChild(eyebrow);\n' +
  '  card.appendChild(title);\n' +
  '  card.appendChild(body);\n' +
  '  card.appendChild(divider);\n' +
  '  card.appendChild(promptLabel);\n' +
  // Conversation starters — pulled from page-level window.bodrlessStarters if set,
  // otherwise sensible defaults. The landing page injects these via a small inline script.
  '  var starters = (window.bodrlessStarters && window.bodrlessStarters.length)\n' +
  '    ? window.bodrlessStarters\n' +
  '    : [\n' +
  '        { icon: "💼", title: "Business Stay",    text: "Book me a business room at ' + agencyName + ' tomorrow night." },\n' +
  '        { icon: "🏖️", title: "Beach Holiday",    text: "Sea view room for two adults, 5 nights all inclusive." },\n' +
  '        { icon: "👨‍👩‍👧", title: "Family Escape",   text: "Family room for 2 adults and 2 children, full board." },\n' +
  '        { icon: "❤️", title: "Romantic Getaway", text: "Recommend the perfect ' + agencyName + ' stay for our anniversary." }\n' +
  '      ];\n' +
  '  starters.forEach(function(s) {\n' +
  '    var btn = document.createElement("button");\n' +
  '    btn.className = "et-starter";\n' +
  '    var t = document.createElement("div"); t.className = "st-title"; t.innerText = s.icon + "  " + s.title;\n' +
  '    var b = document.createElement("div"); b.className = "st-body";  b.innerText = s.text;\n' +
  '    btn.appendChild(t); btn.appendChild(b);\n' +
  '    btn.onclick = function() { input.value = s.text; send(); };\n' +
  '    card.appendChild(btn);\n' +
  '  });\n' +
  '  messages.appendChild(card);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  'function showAgencyWelcome() {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "et-agency-welcome";\n' +
  '  var h4 = document.createElement("h4"); h4.innerText = "Welcome to ' + agencyName + '";\n' +
  '  var p = document.createElement("p"); p.innerText = "Tell me your dream destination and I will find the perfect package.";\n' +
  '  var sugDiv = document.createElement("div"); sugDiv.className = "et-suggestions";\n' +
  '  ["Nairobi to Zanzibar","Cape Town 5 nights","Masai Mara Safari","Kigali Rwanda","Cairo Egypt"].forEach(function(s) {\n' +
  '    var btn = document.createElement("span"); btn.className = "et-suggestion"; btn.innerText = s;\n' +
  '    btn.onclick = function() { input.value = s; send(); };\n' +
  '    sugDiv.appendChild(btn);\n' +
  '  });\n' +
  '  div.appendChild(h4); div.appendChild(p); div.appendChild(sugDiv);\n' +
  '  messages.appendChild(div);\n' +
  '}\n' +

  'function replayTranscript() {\n' +
  '  var note = document.createElement("div"); note.className = "msg bot";\n' +
  '  note.style.cssText = "font-style:italic;opacity:0.6;";\n' +
  '  note.innerText = "\u2014 Continuing where you left off \u2014";\n' +
  '  messages.appendChild(note);\n' +
  '  for (var ri = 0; ri < transcript.length; ri++) {\n' +
  '    var e = transcript[ri];\n' +
  '    if (!e || !e.type) continue;\n' +
  '    if (e.type === "user" || e.type === "bot") { addMsg(e.text || "", e.type); }\n' +
  '    else if (e.type === "hotel_packages" && Array.isArray(e.packages)) { e.packages.slice(0,4).forEach(function(p,i){addHotelPackage(p,i);}); }\n' +
  '    else if (e.type === "hotel_itinerary" && e.pkg) { addHotelItinerary(e.pkg); }\n' +
  '    else if (e.type === "packages" && Array.isArray(e.packages)) { e.packages.slice(0,4).forEach(function(p,i){addPackage(p,i);}); }\n' +
  '    else if (e.type === "itinerary" && e.pkg) { addItinerary(e.pkg); }\n' +
  '  }\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  // ── HELPERS ───────────────────────────────────────────────
  'function addMsg(text, type) {\n' +
  '  var div = document.createElement("div"); div.className = "msg " + type;\n' +
  '  div.innerText = text; messages.appendChild(div); messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +
  'function showTyping() {\n' +
  '  var div = document.createElement("div"); div.className = "typing"; div.id = "et-typing";\n' +
  '  div.innerHTML = "<span></span><span></span><span></span>";\n' +
  '  messages.appendChild(div); messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +
  'function hideTyping() { var t = document.getElementById("et-typing"); if (t) t.remove(); }\n' +
  'function fmtTime(iso) {\n' +
  '  if (!iso) return "TBC";\n' +
  '  try { var d = new Date(iso); if (isNaN(d)) return iso; return d.toLocaleTimeString("en-KE",{hour:"2-digit",minute:"2-digit"}); } catch(e){return iso;}\n' +
  '}\n' +
  'function fmtPrice(n, cur) { return (cur||"KES")+" "+(Math.round(Number(n)||0)).toLocaleString(); }\n' +
  'function titleCase(s) { if(!s)return""; return String(s).replace(/\\b\\w/g,function(c){return c.toUpperCase();}); }\n' +
  'function makeRow(label, name, sub) {\n' +
  '  var row = document.createElement("div"); row.className = "pkg-row";\n' +
  '  var l = document.createElement("div"); l.className = "pkg-label"; l.innerText = label;\n' +
  '  var n = document.createElement("div"); n.className = "pkg-name";  n.innerText = name;\n' +
  '  var s = document.createElement("div"); s.className = "pkg-sub";   s.innerText = sub;\n' +
  '  row.appendChild(l); row.appendChild(n); row.appendChild(s); return row;\n' +
  '}\n' +
  'function makeHL(text, tone) {\n' +
  '  var d = document.createElement("div");\n' +
  '  d.className = "hl " + (tone==="good"?"hl-good":tone==="warn"?"hl-warn":"hl-neutral");\n' +
  '  d.innerText = text; return d;\n' +
  '}\n' +

  // ── HOTEL PACKAGE CARD ────────────────────────────────────
  'function addHotelPackage(p, idx) {\n' +
  '  var div = document.createElement("div"); div.className = "package";\n' +
  '  var hotel = p.hotel || {}; var summary = p.summary || {};\n' +
  '  var ancillaries = p.ancillaryServices || [];\n' +
  '  var currency = hotel.currency || summary.currency || "KES";\n' +
  '  var nights = hotel.nights || summary.nights || 1;\n' +
  '  var passengers = summary.passengers || 1;\n' +
  '  var baseTotal = hotel.totalRate || (hotel.pricePerNight * nights) || summary.totalPrice || 0;\n' +
  '  var currentTotal = baseTotal;\n' +
  '  var selectedAnc = [];\n' +
  '  var currentMealPlan = hotel.mealPlan || "bed_and_breakfast";\n' +
  '  var mealLabels = {room_only:"Room Only",bed_and_breakfast:"Bed & Breakfast",half_board:"Half Board",full_board:"Full Board",all_inclusive:"All Inclusive"};\n' +

  // Header
  '  var pkgH = document.createElement("div"); pkgH.className = "pkg-header";\n' +
  '  var pt = document.createElement("span"); pt.className = "pkg-title"; pt.innerText = "Option "+(idx+1);\n' +
  '  var pr = document.createElement("span"); pr.className = "pkg-route"; pr.innerText = hotel.location||summary.route||"Room";\n' +
  '  pkgH.appendChild(pt); pkgH.appendChild(pr);\n' +
  '  var pkgB = document.createElement("div"); pkgB.className = "pkg-body";\n' +

  // Image
  '  var images = hotel.images||[];\n' +
  '  if (images.length>0) {\n' +
  '    var img = document.createElement("img");\n' +
  '    img.src = images[0]; img.alt = hotel.roomType||hotel.name||"Room";\n' +
  '    img.style.cssText = "width:100%;height:160px;object-fit:cover;border-radius:10px;margin-bottom:10px;display:block;";\n' +
  '    img.onerror = function(){this.style.display="none";};\n' +
  '    pkgB.appendChild(img);\n' +
  '  }\n' +

  // Hotel + room rows
  '  var stars = hotel.stars?Array(Math.min(Math.round(hotel.stars),5)+1).join("\\u2605"):"";\n' +
  '  pkgB.appendChild(makeRow("Property",(hotel.propertyName||hotel.name||"TBC")+(stars?" "+stars:""),hotel.location||hotel.address||""));\n' +
  '  var roomSub=[]; if(hotel.bedType)roomSub.push(hotel.bedType); if(hotel.view)roomSub.push(hotel.view);\n' +
  '  pkgB.appendChild(makeRow("Room",hotel.roomType||"Standard Room",roomSub.join(" \u00b7 ")));\n' +
  '  pkgB.appendChild(makeRow("Dates",(hotel.checkIn||"")+" \u2192 "+(hotel.checkOut||""),nights+" night"+(nights!==1?"s":"")+" \u00b7 "+passengers+" guest(s)"));\n' +

  // Meal plan
  '  var avRates = hotel.availableRates||[];\n' +
  '  var mealRow = document.createElement("div"); mealRow.className = "pkg-row";\n' +
  '  var ml = document.createElement("div"); ml.className = "pkg-label"; ml.innerText = "Meal Plan"; mealRow.appendChild(ml);\n' +
  '  if (avRates.length>1) {\n' +
  '    var ms = document.createElement("select");\n' +
  '    ms.style.cssText = "margin-top:4px;padding:7px 10px;border:1.5px solid var(--et-border);border-radius:8px;font-size:12px;color:#2A2A2A;background:var(--et-cream);width:100%;";\n' +
  '    avRates.forEach(function(r){\n' +
  '      var o=document.createElement("option"); o.value=r.ratePlanId;\n' +
  '      o.setAttribute("data-price",r.pricePerNight); o.setAttribute("data-meal",r.mealPlan);\n' +
  '      o.selected=r.mealPlan===currentMealPlan;\n' +
  '      o.innerText=(mealLabels[r.mealPlan]||r.mealPlan)+" \u2014 "+currency+" "+Math.round(r.pricePerNight).toLocaleString()+"/night";\n' +
  '      ms.appendChild(o);\n' +
  '    });\n' +
  '    ms.onchange=function(){\n' +
  '      var o=ms.options[ms.selectedIndex];\n' +
  '      currentMealPlan=o.getAttribute("data-meal"); hotel.ratePlanId=o.value;\n' +
  '      baseTotal=parseFloat(o.getAttribute("data-price"))*nights;\n' +
  '      currentTotal=baseTotal+selectedAnc.reduce(function(s,a){return s+(a.priceBasis==="per_person"?a.price*passengers:a.priceBasis==="per_night"?a.price*nights:a.price);},0);\n' +
  '      var el=document.getElementById("htl-total-"+idx); if(el)el.innerText=currency+" "+Math.round(currentTotal).toLocaleString();\n' +
  '    };\n' +
  '    mealRow.appendChild(ms);\n' +
  '  } else {\n' +
  '    var md=document.createElement("div"); md.className="pkg-name"; md.innerText="\uD83C\uDF7D\uFE0F "+(mealLabels[currentMealPlan]||currentMealPlan); mealRow.appendChild(md);\n' +
  '  }\n' +
  '  pkgB.appendChild(mealRow);\n' +
  '  if(hotel.policySummary) pkgB.appendChild(makeHL(hotel.policySummary,hotel.isRefundable===false?"warn":hotel.isRefundable===true?"good":"neutral"));\n' +
  '  pkgB.appendChild(makeRow("Rate",currency+" "+Math.round(hotel.pricePerNight||0).toLocaleString()+"/night","\u00d7 "+nights+" night"+(nights!==1?"s":"")+" = "+currency+" "+Math.round(baseTotal).toLocaleString()));\n' +

  // Ancillaries
  '  if(ancillaries.length>0){\n' +
  '    var aRow=document.createElement("div"); aRow.className="pkg-row";\n' +
  '    var aLbl=document.createElement("div"); aLbl.className="pkg-label"; aLbl.innerText="Add-ons"; aRow.appendChild(aLbl);\n' +
  '    var catIcons={spa:"\uD83D\uDEC6",transfer:"\uD83D\uDE97",dining:"\uD83C\uDF7D\uFE0F",activity:"\uD83C\uDFC4",upgrade:"\u2B06\uFE0F",wellness:"\uD83E\uDDD8",other:"\u2728"};\n' +
  '    ancillaries.forEach(function(a){\n' +
  '      var ai=document.createElement("div"); ai.style.cssText="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--et-border);";\n' +
  '      var cb=document.createElement("input"); cb.type="checkbox"; cb.style.cssText="margin-top:3px;flex-shrink:0;accent-color:var(--et-navy);";\n' +
  '      var inf=document.createElement("div"); inf.style.flex="1";\n' +
  '      var an=document.createElement("div"); an.style.cssText="font-size:12px;font-weight:600;color:var(--et-navy);";\n' +
  '      an.innerText=(catIcons[a.category]||"\u2728")+" "+a.name;\n' +
  '      var basis=a.priceBasis==="per_person"?"/person":a.priceBasis==="per_night"?"/night":"";\n' +
  '      var ap=document.createElement("div"); ap.style.cssText="font-size:11px;color:var(--et-muted);";\n' +
  '      ap.innerText=currency+" "+Math.round(a.price).toLocaleString()+basis;\n' +
  '      if(a.description){var ad=document.createElement("div");ad.style.cssText="font-size:11px;color:var(--et-muted);margin-top:2px;";ad.innerText=a.description;inf.appendChild(ad);}\n' +
  '      inf.appendChild(an); inf.appendChild(ap); ai.appendChild(cb); ai.appendChild(inf); aRow.appendChild(ai);\n' +
  '      cb.onchange=function(){\n' +
  '        if(cb.checked){selectedAnc.push(a);}else{selectedAnc=selectedAnc.filter(function(x){return x.id!==a.id;});}\n' +
  '        currentTotal=baseTotal+selectedAnc.reduce(function(s,x){return s+(x.priceBasis==="per_person"?x.price*passengers:x.priceBasis==="per_night"?x.price*nights:x.price);},0);\n' +
  '        var el=document.getElementById("htl-total-"+idx); if(el)el.innerText=currency+" "+Math.round(currentTotal).toLocaleString();\n' +
  '      };\n' +
  '    });\n' +
  '    pkgB.appendChild(aRow);\n' +
  '  }\n' +

  // Footer
  '  var pkgF=document.createElement("div"); pkgF.className="pkg-footer";\n' +
  '  var pd=document.createElement("div"); pd.className="pkg-price";\n' +
  '  var pm=document.createElement("span"); pm.id="htl-total-"+idx; pm.innerText=currency+" "+Math.round(baseTotal).toLocaleString();\n' +
  '  var ps=document.createElement("small"); ps.innerText=currency+" "+Math.round(hotel.pricePerNight||0).toLocaleString()+"/night";\n' +
  '  pd.appendChild(pm); pd.appendChild(ps);\n' +
  '  var bk=document.createElement("button"); bk.className="book"; bk.innerText="Reserve";\n' +
  '  bk.onclick=function(){var ep=JSON.parse(JSON.stringify(p));ep.hotel.mealPlan=currentMealPlan;ep.selectedAncillaries=selectedAnc;ep.summary.totalPrice=currentTotal;showHotelGuestForm(ep,bk);};\n' +
  '  pkgF.appendChild(pd); pkgF.appendChild(bk);\n' +
  '  div.appendChild(pkgH); div.appendChild(pkgB); div.appendChild(pkgF);\n' +
  '  messages.appendChild(div); messages.scrollTop=messages.scrollHeight;\n' +
  '}\n' +

  // ── HOTEL ITINERARY ───────────────────────────────────────
  'function addHotelItinerary(p) {\n' +
  '  var div=document.createElement("div"); div.className="package";\n' +
  '  var summary=p.summary||{}; var legs=p.legs||{};\n' +
  '  var currency=summary.currency||"KES";\n' +
  '  var pkgH=document.createElement("div"); pkgH.className="pkg-header";\n' +
  '  var pt=document.createElement("span"); pt.className="pkg-title"; pt.innerText="Your Itinerary";\n' +
  '  var pr=document.createElement("span"); pr.className="pkg-route"; pr.innerText=summary.route||"";\n' +
  '  pkgH.appendChild(pt); pkgH.appendChild(pr);\n' +
  '  var pkgB=document.createElement("div"); pkgB.className="pkg-body";\n' +
  '  legs.forEach(function(leg,i){\n' +
  '    var sd=document.createElement("div"); sd.className="itin-stop";\n' +
  '    var st=document.createElement("div"); st.className="itin-stop-title";\n' +
  '    st.innerText="Stop "+(i+1)+": "+titleCase(leg.destination)+" ("+(leg.nights||1)+" night"+((leg.nights||1)===1?"":"s")+")";\n' +
  '    sd.appendChild(st);\n' +
  '    if(leg.hotel){\n' +
  '      var h=leg.hotel; var stars=h.stars?Array(Math.min(Math.round(h.stars),5)+1).join("\\u2605"):"";\n' +
  '      var hl=document.createElement("div"); hl.className="itin-line";\n' +
  '      hl.innerText="\uD83C\uDFE8 "+(h.propertyName||h.name||"TBC")+(stars?" "+stars:"")+(h.view?" \u00b7 "+h.view:"")+" \u00b7 "+fmtPrice(h.pricePerNight,h.currency)+"/night \u00d7 "+(leg.nights||1);\n' +
  '      sd.appendChild(hl);\n' +
  '    }\n' +
  '    pkgB.appendChild(sd);\n' +
  '  });\n' +
  '  var pkgF=document.createElement("div"); pkgF.className="pkg-footer";\n' +
  '  var pd=document.createElement("div"); pd.className="pkg-price"; pd.innerText=fmtPrice(Math.round(summary.totalPrice||0),currency);\n' +
  '  var ps=document.createElement("small"); ps.innerText=fmtPrice(Math.round(summary.pricePerPerson||0),currency)+"/person"; pd.appendChild(ps);\n' +
  '  var bk=document.createElement("button"); bk.className="book"; bk.innerText="Reserve Itinerary";\n' +
  '  bk.onclick=function(){showHotelGuestForm(p,bk);};\n' +
  '  pkgF.appendChild(pd); pkgF.appendChild(bk);\n' +
  '  div.appendChild(pkgH); div.appendChild(pkgB); div.appendChild(pkgF);\n' +
  '  messages.appendChild(div); messages.scrollTop=messages.scrollHeight;\n' +
  '}\n' +

  // ── HOTEL GUEST FORM ──────────────────────────────────────
  'function showHotelGuestForm(p, bookBtn) {\n' +
  '  var ex=document.getElementById("et-hotel-form"); if(ex)ex.remove();\n' +
  '  var hotel=p.hotel||{}; var summary=p.summary||{};\n' +
  '  var currency=hotel.currency||summary.currency||"KES";\n' +
  '  var total=summary.totalPrice||hotel.totalRate||0;\n' +
  '  var form=document.createElement("div"); form.className="name-form"; form.id="et-hotel-form";\n' +
  '  var fp=document.createElement("p"); fp.innerText="Complete your reservation:"; form.appendChild(fp);\n' +
  '  var strip=document.createElement("div"); strip.style.cssText="background:var(--et-cream);border-radius:8px;padding:10px 12px;font-size:12px;color:#2A2A2A;margin-bottom:12px;line-height:1.6;";\n' +
  '  var ancNames=(p.selectedAncillaries||[]).map(function(a){return a.name;});\n' +
  '  strip.innerHTML="<strong>"+(hotel.propertyName||hotel.name||"")+"</strong><br>"+(hotel.roomType||"")+(hotel.mealPlan?" \u00b7 "+hotel.mealPlan.replace(/_/g," "):"")+"<br>"+(hotel.checkIn||"")+" \u2192 "+(hotel.checkOut||"")+"<br>"+(ancNames.length?"Add-ons: "+ancNames.join(", ")+"<br>":"")+"<strong>Total: "+currency+" "+Math.round(total).toLocaleString()+"</strong>";\n' +
  '  form.appendChild(strip);\n' +
  '  var ni=document.createElement("input"); ni.className="name-input"; ni.placeholder="Full name"; ni.type="text"; form.appendChild(ni);\n' +
  '  var pi=document.createElement("input"); pi.className="name-input"; pi.placeholder="Phone number"; pi.type="tel"; form.appendChild(pi);\n' +
  '  var ei=document.createElement("input"); ei.className="name-input"; ei.placeholder="Email (for voucher)"; ei.type="email"; form.appendChild(ei);\n' +
  '  var ri=document.createElement("textarea"); ri.className="name-input"; ri.placeholder="Special requests (optional)"; ri.style.cssText="height:56px;resize:none;"; form.appendChild(ri);\n' +
  '  var err=document.createElement("div"); err.style.cssText="color:var(--et-red);font-size:11px;margin-bottom:8px;display:none;"; form.appendChild(err);\n' +
  '  var cb=document.createElement("button"); cb.className="confirm-btn"; cb.innerText="Confirm Reservation";\n' +
  '  cb.onclick=function(){\n' +
  '    err.style.display="none";\n' +
  '    var name=ni.value.trim(); var phone=pi.value.trim();\n' +
  '    if(!name){err.innerText="Please enter your name.";err.style.display="block";return;}\n' +
  '    if(!phone){err.innerText="Please enter your phone number.";err.style.display="block";return;}\n' +
  '    cb.innerText="Processing..."; cb.disabled=true;\n' +
  '    fetch("' + apiBase + '/api/hotel/reserve",{\n' +
  '      method:"POST",\n' +
  '      headers:{"Content-Type":"application/json","x-hotel-key":"' + agencyKey + '"},\n' +
  '      body:JSON.stringify({groupSlug:"' + agencyKey + '",pkg:p,selectedAncillaries:p.selectedAncillaries||[],guestName:name,guestPhone:phone,guestEmail:ei.value.trim()||null,specialRequests:ri.value.trim()||null,channel:"widget"})\n' +
  '    })\n' +
  '    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})\n' +
  '    .then(function(res){\n' +
  '      if(!res.ok||!res.data.success){err.innerText=(res.data&&res.data.error)||"Reservation failed. Please try again.";err.style.display="block";cb.innerText="Confirm Reservation";cb.disabled=false;return;}\n' +
  '      form.remove();\n' +
  '      var ref=res.data.reservationRef;\n' +
  '      addMsg("\uD83C\uDFE8 Reservation "+ref+" confirmed. "+currency+" "+Math.round(total).toLocaleString()+" due.","bot");\n' +
  '      if(res.data.paymentType==="mpesa"||res.data.paymentType==="both"){\n' +
  '        fetch("' + apiBase + '/api/hotel/pay",{method:"POST",headers:{"Content-Type":"application/json","x-hotel-key":"' + agencyKey + '"},body:JSON.stringify({reservationRef:ref,guestPhone:phone})})\n' +
  '        .then(function(r){return r.json();})\n' +
  '        .then(function(pd){addMsg(pd.success?pd.message||"Check your phone to complete payment.":"Reservation confirmed as "+ref+". The hotel will contact you to arrange payment.","bot");messages.scrollTop=messages.scrollHeight;});\n' +
  '      } else { addMsg("Reservation "+ref+" confirmed. The hotel will contact you to arrange payment.","bot"); }\n' +
  '      if(bookBtn){bookBtn.innerText="Reserved \u2713";bookBtn.style.background="var(--et-green)";bookBtn.disabled=true;}\n' +
  '    })\n' +
  '    .catch(function(){err.innerText="Network error. Please try again.";err.style.display="block";cb.innerText="Confirm Reservation";cb.disabled=false;});\n' +
  '  };\n' +
  '  form.appendChild(cb);\n' +
  '  var tb=document.createElement("div"); tb.className="trust-badge";\n' +
  '  tb.innerHTML="<svg viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"><path d=\\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\\"/><path d=\\"M9 12l2 2 4-4\\"/></svg> Secure booking";\n' +
  '  form.appendChild(tb);\n' +
  '  messages.appendChild(form); messages.scrollTop=messages.scrollHeight;\n' +
  '}\n' +

  // ── AGENCY PACKAGE CARD ───────────────────────────────────
  'function pollBookingStatus(ref,btn){\n' +
  '  var a=0,max=40,iv=setInterval(function(){\n' +
  '    a++;\n' +
  '    fetch("' + apiBase + '/api/trips/booking/"+ref).then(function(r){return r.json();}).then(function(d){\n' +
  '      if(d.bookingStage==="paid"){clearInterval(iv);btn.innerText="Paid & Confirmed!";btn.style.background="#27ae60";addMsg("Payment received! Booking "+ref+" confirmed. Your e-ticket will follow shortly.","bot");messages.scrollTop=messages.scrollHeight;}\n' +
  '      else if(d.bookingStage==="failed"||d.status==="cancelled"){clearInterval(iv);btn.innerText="Payment not received";btn.style.background="var(--et-red)";addMsg("We did not receive payment for booking "+ref+". The hold has been released.","bot");messages.scrollTop=messages.scrollHeight;}\n' +
  '      else if(a>=max){clearInterval(iv);addMsg("Still waiting on payment for "+ref+". If you have paid, this will update shortly.","bot");messages.scrollTop=messages.scrollHeight;}\n' +
  '    }).catch(function(){});\n' +
  '  },5000);\n' +
  '}\n' +

  'function continueToPayment(data,ctx,btn){\n' +
  '  var ref=data.bookingRef,total=data.totalPrice,cur=data.currency;\n' +
  '  addMsg("Flight held! Ref: "+ref+". Total: "+cur+" "+total.toLocaleString()+". Sending M-Pesa prompt to "+ctx.phone+"...","bot");\n' +
  '  messages.scrollTop=messages.scrollHeight;\n' +
  '  fetch("' + apiBase + '/api/trips/book-pay",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({bookingRef:ref,phone:ctx.phone,amount:total,currency:cur,email:ctx.email,firstName:ctx.passengers[0].firstName,lastName:ctx.passengers[0].lastName})})\n' +
  '  .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})\n' +
  '  .then(function(pr){\n' +
  '    if(!pr.ok||!pr.data.success){if(btn){btn.innerText="Payment failed";btn.style.background="var(--et-red)";}addMsg("Flight held but M-Pesa prompt failed. Contact support with ref "+ref+".","bot");return;}\n' +
  '    if(btn){btn.innerText="Awaiting payment...";btn.style.background="#f0ad4e";btn.disabled=true;}\n' +
  '    addMsg("Check your phone and enter your PIN to complete payment. Ref: "+ref+".","bot");\n' +
  '    messages.scrollTop=messages.scrollHeight;\n' +
  '    pollBookingStatus(ref,btn||{innerText:"",style:{}});\n' +
  '  });\n' +
  '}\n' +

  'function showNameForm(p,bookBtn){\n' +
  '  var ex=document.getElementById("et-name-form"); if(ex)ex.remove();\n' +
  '  var pc=(p.summary&&p.summary.passengers)?p.summary.passengers:1;\n' +
  '  var needsFlight=!!(p.transport&&(p.transport.transportType||"flight")==="flight");\n' +
  '  var offersSeat=!p.isMultiDestination&&!!(p.transport&&p.transport.supplier==="duffel");\n' +
  '  var form=document.createElement("div"); form.className="name-form"; form.id="et-name-form";\n' +
  '  var fp=document.createElement("p"); fp.innerText=needsFlight?"Enter passenger details to confirm:":"Enter your details to confirm:"; form.appendChild(fp);\n' +
  '  var pInputs=[]; var yr=new Date().getFullYear();\n' +
  '  function buildDob(){\n' +
  '    var row=document.createElement("div"); row.className="dob-row";\n' +
  '    var d=document.createElement("select"); d.innerHTML="<option value=\\"\\">Day</option>"+Array.from({length:31},function(_,i){return"<option value=\\""+(i+1)+"\\">"+(i+1)+"</option>";}).join("");\n' +
  '    var m=document.createElement("select"); m.innerHTML="<option value=\\"\\">Month</option>"+["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map(function(mn,i){return"<option value=\\""+(i+1)+"\\">" +mn+"</option>";}).join("");\n' +
  '    var y=document.createElement("select"); y.innerHTML="<option value=\\"\\">Year</option>"+Array.from({length:100},function(_,i){return yr-i;}).map(function(yy){return"<option value=\\""+yy+"\\">"+yy+"</option>";}).join("");\n' +
  '    row.appendChild(d);row.appendChild(m);row.appendChild(y);return{row:row,d:d,m:m,y:y};\n' +
  '  }\n' +
  '  for(var pi=0;pi<pc;pi++){\n' +
  '    var pb=document.createElement("div"); pb.style.cssText="margin-bottom:12px;padding-bottom:10px;border-bottom:"+(pi<pc-1?"1px solid var(--et-border)":"none")+";";\n' +
  '    if(pc>1){var pl=document.createElement("div");pl.style.cssText="font-size:11px;font-weight:700;color:var(--et-navy);margin-bottom:6px;";pl.innerText="Traveler "+(pi+1);pb.appendChild(pl);}\n' +
  '    var fn=document.createElement("input");fn.className="name-input";fn.placeholder="First name";fn.type="text";pb.appendChild(fn);\n' +
  '    var ln=document.createElement("input");ln.className="name-input";ln.placeholder="Last name";ln.type="text";pb.appendChild(ln);\n' +
  '    var dl=document.createElement("div");dl.className="field-label";dl.innerText="Date of birth";pb.appendChild(dl);\n' +
  '    var dob=buildDob();pb.appendChild(dob.row);\n' +
  '    var gs=document.createElement("select");gs.className="name-input";gs.innerHTML="<option value=\\"male\\">Male</option><option value=\\"female\\">Female</option>";pb.appendChild(gs);\n' +
  '    var cl=document.createElement("label");cl.style.cssText="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--et-navy);margin-bottom:8px;";\n' +
  '    var cc=document.createElement("input");cc.type="checkbox";cl.appendChild(cc);cl.appendChild(document.createTextNode("This traveler is a child"));pb.appendChild(cl);\n' +
  '    var idl=document.createElement("div");idl.className="field-label";idl.innerText="Passport or National ID";pb.appendChild(idl);\n' +
  '    var ii=document.createElement("input");ii.className="name-input";ii.placeholder="Passport / ID number";ii.type="text";pb.appendChild(ii);\n' +
  '    var ss=null;\n' +
  '    if(offersSeat){var sl=document.createElement("div");sl.className="field-label";sl.innerText="Seat preference (optional)";pb.appendChild(sl);ss=document.createElement("select");ss.className="name-input";ss.innerHTML="<option value=\\"\\">No preference</option><option value=\\"window\\">Window</option><option value=\\"aisle\\">Aisle</option><option value=\\"exit_row\\">Exit row</option>";pb.appendChild(ss);}\n' +
  '    pInputs.push({fn:fn,ln:ln,d:dob.d,m:dob.m,y:dob.y,gs:gs,cc:cc,ii:ii,ss:ss});\n' +
  '    form.appendChild(pb);\n' +
  '  }\n' +
  '  var cl2=document.createElement("div");cl2.style.cssText="font-size:11px;font-weight:700;color:var(--et-navy);margin-bottom:6px;";cl2.innerText="Contact details";form.appendChild(cl2);\n' +
  '  var phi=document.createElement("input");phi.className="name-input";phi.placeholder="Phone (e.g. 0712345678)";phi.type="tel";form.appendChild(phi);\n' +
  '  var emi=document.createElement("input");emi.className="name-input";emi.placeholder="Email";emi.type="email";form.appendChild(emi);\n' +
  '  var em=document.createElement("div");em.style.cssText="color:var(--et-red);font-size:11px;margin-bottom:8px;display:none;";form.appendChild(em);\n' +
  '  var cfb=document.createElement("button");cfb.className="confirm-btn";cfb.innerText="Confirm Booking";\n' +
  '  cfb.onclick=function(){\n' +
  '    em.style.display="none";\n' +
  '    var pax=[];\n' +
  '    for(var k=0;k<pInputs.length;k++){\n' +
  '      var pin=pInputs[k];\n' +
  '      var f=pin.fn.value.trim(),l=pin.ln.value.trim();\n' +
  '      if(!f||!l){em.innerText="Please fill in all traveler names.";em.style.display="block";return;}\n' +
  '      var dd=pin.d.value,mm=pin.m.value,yy=pin.y.value;\n' +
  '      if(!dd||!mm||!yy){em.innerText="Please select a date of birth for traveler "+(k+1)+".";em.style.display="block";return;}\n' +
  '      var dstr=yy+"-"+String(mm).padStart(2,"0")+"-"+String(dd).padStart(2,"0");\n' +
  '      var isC=pin.cc.checked,idn=pin.ii.value.trim();\n' +
  '      if(!isC&&!idn){em.innerText="Passport/ID required for traveler "+(k+1)+".";em.style.display="block";return;}\n' +
  '      pax.push({firstName:f,lastName:l,dateOfBirth:dstr,gender:pin.gs.value,type:isC?"child":"adult",idNumber:idn||null,seatPreference:(pin.ss&&pin.ss.value)?pin.ss.value:null});\n' +
  '    }\n' +
  '    var phone=phi.value.trim(),email=emi.value.trim();\n' +
  '    if(!phone){em.innerText="Phone number is required.";em.style.display="block";return;}\n' +
  '    if(needsFlight&&!email){em.innerText="Email is required for flight bookings.";em.style.display="block";return;}\n' +
  '    var gn=pax[0].firstName+" "+pax[0].lastName;\n' +
  '    var ctx={guestName:gn,phone:phone,email:email,passengers:pax,pkg:p};\n' +
  '    cfb.innerText="Processing...";cfb.disabled=true;\n' +
  '    fetch("' + apiBase + '/api/trips/book-init",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agencyId:"' + agencyKey + '",guestName:gn,guestPhone:phone,guestEmail:email,passengers:pax,package:p})})\n' +
  '    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})\n' +
  '    .then(function(res){\n' +
  '      if(!res.ok&&res.data&&res.data.code==="PRICE_CHANGED"){form.remove();showPriceAlert(res.data,ctx,bookBtn);return;}\n' +
  '      if(!res.ok||!res.data.success){em.innerText=(res.data&&res.data.error)||"Booking failed. Please try again.";em.style.display="block";cfb.innerText="Confirm Booking";cfb.disabled=false;return;}\n' +
  '      form.remove();continueToPayment(res.data,ctx,bookBtn);\n' +
  '    })\n' +
  '    .catch(function(){em.innerText="Network error. Please try again.";em.style.display="block";cfb.innerText="Confirm Booking";cfb.disabled=false;});\n' +
  '  };\n' +
  '  form.appendChild(cfb);\n' +
  '  var tb=document.createElement("div");tb.className="trust-badge";\n' +
  '  tb.innerHTML="<svg viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"><path d=\\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\\"/><path d=\\"M9 12l2 2 4-4\\"/></svg> Secure payment via M-Pesa";\n' +
  '  form.appendChild(tb);\n' +
  '  messages.appendChild(form);messages.scrollTop=messages.scrollHeight;\n' +
  '}\n' +

  'function showPriceAlert(info,ctx,btn){\n' +
  '  var ex=document.getElementById("et-price-alert");if(ex)ex.remove();\n' +
  '  var d=document.createElement("div");d.className="price-alert";d.id="et-price-alert";\n' +
  '  var p=document.createElement("p");p.innerHTML="The hotel price changed: <span style=\\"text-decoration:line-through;color:var(--et-muted);\\">" +fmtPrice(info.oldPrice,info.currency)+"</span> \u2192 <strong style=\\"color:var(--et-red);\\">"+(fmtPrice(info.newPrice,info.currency))+"</strong>"+(info.flightHeld?" Your flight is held and not yet charged.":"");\n' +
  '  d.appendChild(p);\n' +
  '  var acts=document.createElement("div");acts.className="price-alert-actions";\n' +
  '  var ap=document.createElement("button");ap.className="price-approve";ap.innerText="Approve new price";\n' +
  '  var ca=document.createElement("button");ca.className="price-cancel";ca.innerText="Cancel";\n' +
  '  acts.appendChild(ap);acts.appendChild(ca);d.appendChild(acts);messages.appendChild(d);messages.scrollTop=messages.scrollHeight;\n' +
  '  ca.onclick=function(){d.remove();addMsg("Booking cancelled \u2014 no charge was made.","bot");};\n' +
  '  ap.onclick=function(){\n' +
  '    ap.disabled=true;ca.disabled=true;ap.innerText="Processing...";\n' +
  '    fetch("' + apiBase + '/api/trips/book-init",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agencyId:"' + agencyKey + '",guestName:ctx.guestName,guestPhone:ctx.phone,guestEmail:ctx.email,passengers:ctx.passengers,package:ctx.pkg,priceApproved:true})})\n' +
  '    .then(function(r){return r.json().then(function(data){return{ok:r.ok,data:data};});})\n' +
  '    .then(function(res){d.remove();if(!res.ok||!res.data.success){addMsg((res.data&&res.data.error)||"Booking failed at the new price.","bot");return;}continueToPayment(res.data,ctx,btn);})\n' +
  '    .catch(function(){d.remove();addMsg("Network error. Please try again.","bot");});\n' +
  '  };\n' +
  '}\n' +

  'function addPackage(p,i){\n' +
  '  var div=document.createElement("div");div.className="package";\n' +
  '  var t=p.transport||null,rt=p.returnTransport||null,h=p.hotel||null,tr=p.transfers||null,s=p.summary||{};\n' +
  '  var cur=s.currency||"KES",total=Math.round(s.totalPrice||0),ppp=Math.round(s.pricePerPerson||0),nights=s.nights||0,pax=s.passengers||1;\n' +
  '  var route=s.route||((t&&t.origin?t.origin:"TBC")+" to "+(t&&t.destination?t.destination:"TBC"));\n' +
  '  var ph=document.createElement("div");ph.className="pkg-header";\n' +
  '  var pt=document.createElement("span");pt.className="pkg-title";pt.innerText="Option "+(i+1);\n' +
  '  var pr=document.createElement("span");pr.className="pkg-route";pr.innerText=route;\n' +
  '  ph.appendChild(pt);ph.appendChild(pr);\n' +
  '  var pb=document.createElement("div");pb.className="pkg-body";\n' +
  '  if(t){\n' +
  '    var isb=(t.transportType||"").toLowerCase()==="bus";\n' +
  '    var sub=(t.origin||"TBC")+" \u2192 "+(t.destination||"TBC")+" \u00b7 "+fmtTime(t.departureTime)+" - "+fmtTime(t.arrivalTime);\n' +
  '    if(t.stops)sub+=" \u00b7 "+t.stops;if(t.cabinClass)sub+=" \u00b7 "+t.cabinClass;\n' +
  '    if(!isb&&t.baggageSummary)sub+=" \u00b7 "+t.baggageSummary;sub+=" \u00b7 "+fmtPrice(t.price,t.currency);\n' +
  '    pb.appendChild(makeRow(isb?"Outbound Bus":"Outbound Flight",t.airline||t.provider||"TBC",sub));\n' +
  '    if(t.policySummary)pb.appendChild(makeHL(t.policySummary,t.isRefundable===true?"good":t.isRefundable===false?"warn":"neutral"));\n' +
  '  }\n' +
  '  if(rt){\n' +
  '    var isrb=(rt.transportType||"").toLowerCase()==="bus";\n' +
  '    var rsub=(rt.origin||"TBC")+" \u2192 "+(rt.destination||"TBC")+" \u00b7 "+fmtTime(rt.departureTime)+" - "+fmtTime(rt.arrivalTime);\n' +
  '    if(!isrb&&rt.baggageSummary)rsub+=" \u00b7 "+rt.baggageSummary;rsub+=" \u00b7 "+fmtPrice(rt.price,rt.currency);\n' +
  '    pb.appendChild(makeRow(isrb?"Return Bus":"Return Flight",rt.airline||rt.provider||"TBC",rsub));\n' +
  '    if(rt.policySummary)pb.appendChild(makeHL(rt.policySummary,rt.isRefundable===true?"good":rt.isRefundable===false?"warn":"neutral"));\n' +
  '  }\n' +
  '  if(h){\n' +
  '    var stars=h.stars?Array(Math.min(Math.round(h.stars),5)+1).join("\\u2605"):"";\n' +
  '    var hsub=(h.location||"TBC");if(nights>0)hsub+=" \u00b7 "+nights+" nights \u00b7 "+fmtPrice(h.pricePerNight,h.currency)+"/night";\n' +
  '    if(h.images&&h.images.length>0){var hi=document.createElement("img");hi.src=h.images[0];hi.alt=h.name||"Hotel";hi.style.cssText="width:100%;height:140px;object-fit:cover;border-radius:10px;margin-bottom:8px;display:block;";hi.onerror=function(){this.style.display="none";};pb.appendChild(hi);}\n' +
  '    pb.appendChild(makeRow("Hotel",(h.name||"TBC")+(stars?" "+stars:""),hsub));\n' +
  '    if(h.mealPlan)pb.appendChild(makeHL("\uD83C\uDF7D\uFE0F Board: "+h.mealPlan,"neutral"));\n' +
  '    pb.appendChild(makeHL(h.policySummary||(h.isRefundable===false?"\u26a0\uFE0F Non-refundable":"Refund terms confirmed at booking"),h.isRefundable===false?"warn":h.isRefundable===true||h.policySummary?"good":"neutral"));\n' +
  '  }\n' +
  '  var trl=Array.isArray(tr)?tr:(tr?[tr]:[]);\n' +
  '  if(trl.length>0){var tsub=trl.map(function(x){return(x.legType==="departure"?"Departure":x.legType==="arrival"?"Arrival":(x.provider||"Transfer"))+": "+(x.description||x.location||"TBC")+" ("+fmtPrice(x.price,x.currency)+")";}).join(" \u00b7 ");pb.appendChild(makeRow("Transfer",trl[0].provider||"Bodrless Transfer",tsub));}\n' +
  '  if(p.connectionAdvisory){var ar=document.createElement("div");ar.className="pkg-row";var al=document.createElement("div");al.className="pkg-label";al.innerText="\u26a0\uFE0F Before you book";var at=document.createElement("div");at.className="pkg-sub";at.innerText=p.connectionAdvisory;ar.appendChild(al);ar.appendChild(at);pb.appendChild(ar);}\n' +
  '  var pf=document.createElement("div");pf.className="pkg-footer";\n' +
  '  var ppd=document.createElement("div");ppd.className="pkg-price";ppd.innerText=fmtPrice(total,cur);\n' +
  '  var pps=document.createElement("small");pps.innerText=fmtPrice(ppp,cur)+"/person \u00b7 "+pax+" traveller(s)";ppd.appendChild(pps);\n' +
  '  var bk=document.createElement("button");bk.className="book";bk.innerText="Book Now";\n' +
  '  bk.onclick=function(){showNameForm(p,bk);};\n' +
  '  pf.appendChild(ppd);pf.appendChild(bk);\n' +
  '  div.appendChild(ph);div.appendChild(pb);div.appendChild(pf);\n' +
  '  messages.appendChild(div);messages.scrollTop=messages.scrollHeight;\n' +
  '}\n' +

  'function addItinerary(p){\n' +
  '  var div=document.createElement("div");div.className="package";\n' +
  '  var s=p.summary||{},legs=p.legs||[],cur=s.currency||"KES";\n' +
  '  var ph=document.createElement("div");ph.className="pkg-header";\n' +
  '  var pt=document.createElement("span");pt.className="pkg-title";pt.innerText="Your Itinerary";\n' +
  '  var pr=document.createElement("span");pr.className="pkg-route";pr.innerText=s.route||"";\n' +
  '  ph.appendChild(pt);ph.appendChild(pr);\n' +
  '  var pb=document.createElement("div");pb.className="pkg-body";\n' +
  '  legs.forEach(function(leg,idx){\n' +
  '    var sd=document.createElement("div");sd.className="itin-stop"+(leg.isBufferLeg?" buffer":"");\n' +
  '    var st=document.createElement("div");st.className="itin-stop-title";\n' +
  '    st.innerText=leg.isBufferLeg?"Connection: overnight in "+titleCase(leg.destination):"Stop "+(idx+1)+": "+titleCase(leg.destination)+" ("+leg.nights+" night"+(leg.nights===1?"":"s")+")";\n' +
  '    sd.appendChild(st);\n' +
  '    var tr=leg.transportIn;\n' +
  '    if(tr){var isb=(tr.transportType||"").toLowerCase()==="bus";var tl=document.createElement("div");tl.className="itin-line";tl.innerText=(isb?"Bus: ":"Flight: ")+(tr.airline||tr.provider||"TBC")+" \u00b7 "+(tr.origin||"TBC")+" \u2192 "+(tr.destination||"TBC")+" \u00b7 "+fmtTime(tr.departureTime)+"-"+fmtTime(tr.arrivalTime)+" \u00b7 "+fmtPrice(tr.price,tr.currency);sd.appendChild(tl);}\n' +
  '    if(leg.hotel){var h=leg.hotel;var stars=h.stars?Array(Math.min(Math.round(h.stars),5)+1).join("\\u2605"):"";var hl=document.createElement("div");hl.className="itin-line";hl.innerText="Hotel: "+(h.name||"TBC")+(stars?" "+stars:"")+(h.location?" \u00b7 "+h.location:"")+" \u00b7 "+fmtPrice(h.pricePerNight,h.currency)+"/night \u00d7 "+leg.nights;sd.appendChild(hl);}\n' +
  '    pb.appendChild(sd);\n' +
  '  });\n' +
  '  if(p.returnTransport){var rt=p.returnTransport;var isrb=(rt.transportType||"").toLowerCase()==="bus";var rd=document.createElement("div");rd.className="itin-stop";var rtl=document.createElement("div");rtl.className="itin-stop-title";rtl.innerText="Return";rd.appendChild(rtl);var rl=document.createElement("div");rl.className="itin-line";rl.innerText=(isrb?"Bus: ":"Flight: ")+(rt.origin||"TBC")+" \u2192 "+(rt.destination||"TBC")+" \u00b7 "+fmtTime(rt.departureTime)+"-"+fmtTime(rt.arrivalTime)+" \u00b7 "+fmtPrice(rt.price,rt.currency);rd.appendChild(rl);pb.appendChild(rd);}\n' +
  '  var pf=document.createElement("div");pf.className="pkg-footer";\n' +
  '  var ppd=document.createElement("div");ppd.className="pkg-price";ppd.innerText=fmtPrice(Math.round(s.totalPrice||0),cur);\n' +
  '  var pps=document.createElement("small");pps.innerText=fmtPrice(Math.round(s.pricePerPerson||0),cur)+"/person \u00b7 "+(s.passengers||1)+" traveller(s)";ppd.appendChild(pps);\n' +
  '  var bk=document.createElement("button");bk.className="book";bk.innerText="Book Itinerary";\n' +
  '  bk.onclick=function(){showNameForm(p,bk);};\n' +
  '  pf.appendChild(ppd);pf.appendChild(bk);\n' +
  '  div.appendChild(ph);div.appendChild(pb);div.appendChild(pf);\n' +
  '  messages.appendChild(div);messages.scrollTop=messages.scrollHeight;\n' +
  '}\n' +

  // ── SEND ─────────────────────────────────────────────────
  'function send(){\n' +
  '  var text=input.value.trim(); if(!text)return;\n' +
  '  addMsg(text,"user"); transcript.push({type:"user",text:text}); persistState();\n' +
  '  input.value=""; showTyping();\n' +
  '  var endpoint=isHotelMode?"' + apiBase + '/api/hotel/orchestrate":"' + apiBase + '/api/trips/orchestrate";\n' +
  '  var hdrs=isHotelMode?{"Content-Type":"application/json","x-hotel-key":"' + agencyKey + '"}:{"Content-Type":"application/json","x-api-key":"' + agencyKey + '"};\n' +
  '  var body=isHotelMode?JSON.stringify({prompt:text,groupSlug:"' + agencyKey + '",sessionId:sessionId,conversationHistory:conversationHistory,previousParams:previousParams}):JSON.stringify({prompt:text,agencyId:"' + agencyKey + '",channelType:"widget",sessionId:sessionId,conversationHistory:conversationHistory,previousParams:previousParams});\n' +
  '  fetch(endpoint,{method:"POST",headers:hdrs,body:body})\n' +
  '  .then(function(r){return r.json();})\n' +
  '  .then(function(data){\n' +
  '    hideTyping();\n' +
  '    if(data.sessionId)sessionId=data.sessionId;\n' +
  '    if(data.tripParams)previousParams=data.tripParams;\n' +
  '    if(data.conversationHistory)conversationHistory=data.conversationHistory;\n' +
  '    if(data.needsClarification){var ct=data.text||"Could you give me a bit more detail?";addMsg(ct,"bot");transcript.push({type:"bot",text:ct});persistState();return;}\n' +
  '    var pkgs=data&&data.packages?data.packages:[];\n' +
  '    var isHD=data.isHotelDirect||(pkgs.length>0&&pkgs[0]&&pkgs[0].isHotelDirect);\n' +
  '    var isIt=pkgs.length===1&&pkgs[0]&&pkgs[0].isMultiDestination;\n' +
  '    if(!pkgs.length){var nt=(data&&data.text)?data.text:"No options found. Try specifying your dates and number of guests.";addMsg(nt,"bot");transcript.push({type:"bot",text:nt});persistState();return;}\n' +
  '    var rm=data.text||(isHD?"Here are the available rooms:":"I found "+pkgs.length+" option(s) for you:");\n' +
  '    if(!isHD&&!isIt&&data.intent&&data.intent.isFollowUp){var adj=data.intent.adjustments||{};if(adj.budget==="low")rm="Here are more affordable options:";else if(adj.budget==="luxury")rm="Here are the premium options:";else if(adj.nights)rm="Here are options for "+adj.nights+" nights:";else rm="Here are the updated options:";}\n' +
  '    addMsg(rm,"bot");transcript.push({type:"bot",text:rm});\n' +
  '    if(isHD&&isIt){addHotelItinerary(pkgs[0]);transcript.push({type:"hotel_itinerary",pkg:pkgs[0]});}\n' +
  '    else if(isHD){pkgs.slice(0,4).forEach(function(p,i){addHotelPackage(p,i);});transcript.push({type:"hotel_packages",packages:pkgs.slice(0,4)});}\n' +
  '    else if(isIt){addItinerary(pkgs[0]);transcript.push({type:"itinerary",pkg:pkgs[0]});}\n' +
  '    else{pkgs.slice(0,4).forEach(function(p,i){addPackage(p,i);});transcript.push({type:"packages",packages:pkgs.slice(0,4)});}\n' +
  '    persistState();\n' +
  '  })\n' +
  '  .catch(function(e){hideTyping();console.log("Widget error:",e);addMsg("Unable to load options right now. Please try again.","bot");});\n' +
  '}\n' +

  'sendBtn.onclick=send;\n' +
  'input.addEventListener("keypress",function(e){if(e.key==="Enter")send();});\n' +
  'console.log("[BODRLESS] Widget loaded — key:' + agencyKey + ' mode:' + mode + ' embed:"+(embedTarget||"floating"));\n' +
  '}\n' +
  'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",initWidget);}else{initWidget();}\n' +
  '})();\n';

  res.send(widgetCode);
});

module.exports = router;