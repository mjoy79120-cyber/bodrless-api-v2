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

  // ─────────────────────────────────────────────
  // DURABLE CONVERSATION STATE (2026-07-05)
  // BUG FIX (found via a real "does this reach the widget too"
  // review): previously conversationHistory/previousParams/sessionId
  // lived ONLY as plain in-memory JS variables in this one open
  // browser tab — a page refresh, an accidental tab close, or
  // switching devices wiped the entire conversation with no
  // recovery at all. This is arguably a bigger gap than WhatsApp had
  // before its own durable-cache fix, since WhatsApp at least
  // persisted state server-side already. Uses localStorage (NOT a
  // restriction here — that only applies to Claude.ai's own Artifact
  // preview environment, not real code shipped to a client's site)
  // scoped per-agency so multiple Bodrless-powered widgets on
  // different sites never collide. STORAGE_KEY is a container for
  // storing widget stat.
  //
  // Stores a lightweight TRANSCRIPT (not just backend context) so a
  // returning visitor sees their actual prior messages AND package
  // cards redrawn with fully working "Book Now" buttons — addPackage/
  // addItinerary only need the same plain data object `p` whether it
  // came from a live fetch response or a restored transcript entry,
  // so replaying is exactly as functional as the original render.
  //
  // 24-HOUR CUTOFF: same honest staleness posture as the WhatsApp
  // package cache (services/packageCache.js) — restored state older
  // than 24 hours is NOT trusted silently (prices/availability/dates
  // could be entirely stale by then); the visitor just starts fresh,
  // same as a new visitor would.
  // ─────────────────────────────────────────────
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
  '  } catch (e) {\n' +
  '    /* localStorage unavailable (private browsing, quota exceeded, etc.) —\n' +
  '       conversation simply will not persist; never breaks the widget itself. */\n' +
  '  }\n' +
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
  '  } catch (e) {\n' +
  '    return null;\n' +
  '  }\n' +
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
  'triggerBtn.onclick = function() { chatDiv.classList.add("open"); input.focus(); if (!welcomeShown) { welcomeShown = true; if (hasRestoredHistory) { replayTranscript(); } else { showWelcome(); } } };\n' +
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

  // ─────────────────────────────────────────────
  // REPLAY TRANSCRIPT
  // Rebuilds the visible conversation from a restored localStorage
  // transcript on the widget's first open after a page reload — a
  // short italic divider marks where the restored history begins.
  // addPackage/addItinerary need nothing special to work here: they
  // just take a plain data object `p` and build fresh DOM + event
  // handlers each call, exactly the same whether `p` came from a
  // live fetch response or a restored transcript entry — so "Book
  // Now" buttons on restored package cards are fully functional, not
  // a static readonly replay.
  // ─────────────────────────────────────────────
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

  // Prominent, unambiguous callout — used for refund status and
  // board type, which need to be immediately visible, not buried
  // inside a long pipe-separated line the traveler has to parse.
  // tone: "good" (green, e.g. refundable) | "warn" (amber, e.g.
  // non-refundable) | "neutral" (blue-grey, e.g. board type, or
  // refund status genuinely not confirmed by the supplier).
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
  '      .catch(function() { /* silent retry on next interval tick */ });\n' +
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
  '      body: JSON.stringify({\n' +
  '        agencyId: "' + agencyKey + '",\n' +
  '        guestName: bookCtx.guestName,\n' +
  '        guestPhone: bookCtx.phone,\n' +
  '        guestEmail: bookCtx.email,\n' +
  '        passengers: bookCtx.passengers,\n' +
  '        package: bookCtx.pkg,\n' +
  '        priceApproved: true\n' +
  '      })\n' +
  '    })\n' +
  '    .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })\n' +
  '    .then(function(result) {\n' +
  '      div.remove();\n' +
  '      if (!result.ok || !result.data.success) {\n' +
  '        var msg = (result.data && result.data.error) ? result.data.error : "Booking failed at the new price. Please try again.";\n' +
  '        addMsg(msg, "bot");\n' +
  '        return;\n' +
  '      }\n' +
  '      continueToPayment(result.data, bookCtx, bookBtn);\n' +
  '    })\n' +
  '    .catch(function() {\n' +
  '      div.remove();\n' +
  '      addMsg("Network error confirming the new price. Please try again.", "bot");\n' +
  '    });\n' +
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
  '    body: JSON.stringify({\n' +
  '      bookingRef: bookingRef,\n' +
  '      phone: bookCtx.phone,\n' +
  '      amount: totalPrice,\n' +
  '      currency: currency,\n' +
  '      email: bookCtx.email,\n' +
  '      firstName: bookCtx.passengers[0].firstName,\n' +
  '      lastName: bookCtx.passengers[0].lastName\n' +
  '    })\n' +
  '  })\n' +
  '  .then(function(pr) { return pr.json().then(function(pdata) { return { ok: pr.ok, data: pdata }; }); })\n' +
  '  .then(function(payResult) {\n' +
  '    if (!payResult.ok || !payResult.data.success) {\n' +
  '      if (bookBtn) { bookBtn.innerText = "Payment failed to send"; bookBtn.style.background = "#C0392B"; }\n' +
  '      addMsg("Your flight and hotel are held, but we could not send the payment prompt (" + (payResult.data.error || "unknown error") + "). Please contact support with booking ref " + bookingRef + ".", "bot");\n' +
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
  '  var needsFlightDetails = false;\n' +
  '  if (p.isMultiDestination) {\n' +
  '    needsFlightDetails = (p.legs || []).some(function(leg) { return leg.transportIn && (leg.transportIn.transportType || "flight") === "flight"; })\n' +
  '      || !!(p.returnTransport && (p.returnTransport.transportType || "flight") === "flight");\n' +
  '  } else {\n' +
  '    needsFlightDetails = !!(p.transport && (p.transport.transportType || "flight") === "flight");\n' +
  '  }\n' +
  '  var offersSeatSelection = !p.isMultiDestination && !!(p.transport && p.transport.supplier === "duffel");\n' +

  '  var form = document.createElement("div");\n' +
  '  form.className = "name-form";\n' +
  '  form.id = "et-name-form";\n' +
  '  var formP = document.createElement("p");\n' +
  '  formP.innerText = needsFlightDetails\n' +
  '    ? "Enter passenger details to confirm booking:"\n' +
  '    : "Enter your details to confirm booking:";\n' +
  '  form.appendChild(formP);\n' +

  '  var passengerInputs = [];\n' +
  '  var currentYear = new Date().getFullYear();\n' +
  '  function buildDobRow() {\n' +
  '    var row = document.createElement("div");\n' +
  '    row.className = "dob-row";\n' +
  '    var daySel = document.createElement("select");\n' +
  '    daySel.innerHTML = "<option value=\\"\\">Day</option>" + Array.from({length:31}, function(_, i) { return "<option value=\\"" + (i+1) + "\\">" + (i+1) + "</option>"; }).join("");\n' +
  '    var monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];\n' +
  '    var monthSel = document.createElement("select");\n' +
  '    monthSel.innerHTML = "<option value=\\"\\">Month</option>" + monthNames.map(function(m, i) { return "<option value=\\"" + (i+1) + "\\">" + m + "</option>"; }).join("");\n' +
  '    var yearSel = document.createElement("select");\n' +
  '    yearSel.innerHTML = "<option value=\\"\\">Year</option>" + Array.from({length:100}, function(_, i) { return currentYear - i; }).map(function(y) { return "<option value=\\"" + y + "\\">" + y + "</option>"; }).join("");\n' +
  '    row.appendChild(daySel);\n' +
  '    row.appendChild(monthSel);\n' +
  '    row.appendChild(yearSel);\n' +
  '    return { row: row, daySel: daySel, monthSel: monthSel, yearSel: yearSel };\n' +
  '  }\n' +

  '  for (var pi = 0; pi < passengerCount; pi++) {\n' +
  '    var pBlock = document.createElement("div");\n' +
  '    pBlock.style.marginBottom = "12px";\n' +
  '    pBlock.style.paddingBottom = "10px";\n' +
  '    pBlock.style.borderBottom = (pi < passengerCount - 1) ? "1px dashed #E4E8F0" : "none";\n' +
  '    if (passengerCount > 1) {\n' +
  '      var pLabel = document.createElement("div");\n' +
  '      pLabel.style.fontSize = "11px";\n' +
  '      pLabel.style.fontWeight = "700";\n' +
  '      pLabel.style.color = "#1E2A5E";\n' +
  '      pLabel.style.marginBottom = "6px";\n' +
  '      pLabel.innerText = "Traveler " + (pi + 1);\n' +
  '      pBlock.appendChild(pLabel);\n' +
  '    }\n' +
  '    var firstNameInput = document.createElement("input");\n' +
  '    firstNameInput.className = "name-input";\n' +
  '    firstNameInput.placeholder = "First name";\n' +
  '    firstNameInput.type = "text";\n' +
  '    pBlock.appendChild(firstNameInput);\n' +
  '    var lastNameInput = document.createElement("input");\n' +
  '    lastNameInput.className = "name-input";\n' +
  '    lastNameInput.placeholder = "Last name";\n' +
  '    lastNameInput.type = "text";\n' +
  '    pBlock.appendChild(lastNameInput);\n' +

  '    var dobLabel = document.createElement("div");\n' +
  '    dobLabel.className = "field-label";\n' +
  '    dobLabel.innerText = "Date of birth";\n' +
  '    pBlock.appendChild(dobLabel);\n' +
  '    var dob = buildDobRow();\n' +
  '    pBlock.appendChild(dob.row);\n' +

  '    var genderSelect = document.createElement("select");\n' +
  '    genderSelect.className = "name-input";\n' +
  '    genderSelect.innerHTML = "<option value=\\"male\\">Male</option><option value=\\"female\\">Female</option>";\n' +
  '    pBlock.appendChild(genderSelect);\n' +

  '    var childRow = document.createElement("label");\n' +
  '    childRow.style.display = "flex";\n' +
  '    childRow.style.alignItems = "center";\n' +
  '    childRow.style.gap = "6px";\n' +
  '    childRow.style.fontSize = "11px";\n' +
  '    childRow.style.color = "#1E2A5E";\n' +
  '    childRow.style.marginBottom = "8px";\n' +
  '    var childCheckbox = document.createElement("input");\n' +
  '    childCheckbox.type = "checkbox";\n' +
  '    childRow.appendChild(childCheckbox);\n' +
  '    childRow.appendChild(document.createTextNode("This traveler is a child"));\n' +
  '    pBlock.appendChild(childRow);\n' +

  '    var idLabel = document.createElement("div");\n' +
  '    idLabel.className = "field-label";\n' +
  '    idLabel.innerText = "Passport or National ID number";\n' +
  '    pBlock.appendChild(idLabel);\n' +
  '    var idInput = document.createElement("input");\n' +
  '    idInput.className = "name-input";\n' +
  '    idInput.placeholder = "Passport / ID number";\n' +
  '    idInput.type = "text";\n' +
  '    pBlock.appendChild(idInput);\n' +
  '    childCheckbox.onchange = function(inp) { return function() { inp.placeholder = inp.parentNode.parentNode.querySelector("input[type=checkbox]").checked ? "Passport / ID number (optional for children)" : "Passport / ID number"; }; }(idInput);\n' +

  '    var seatSelect = null;\n' +
  '    if (offersSeatSelection) {\n' +
  '      var seatLabel = document.createElement("div");\n' +
  '      seatLabel.className = "field-label";\n' +
  '      seatLabel.innerText = "Seat preference (optional)";\n' +
  '      pBlock.appendChild(seatLabel);\n' +
  '      seatSelect = document.createElement("select");\n' +
  '      seatSelect.className = "name-input";\n' +
  '      seatSelect.innerHTML = "<option value=\\"\\">No preference</option><option value=\\"window\\">Window</option><option value=\\"aisle\\">Aisle</option><option value=\\"exit_row\\">Exit row (extra legroom, may cost more)</option>";\n' +
  '      pBlock.appendChild(seatSelect);\n' +
  '    }\n' +

  '    passengerInputs.push({\n' +
  '      firstNameInput: firstNameInput,\n' +
  '      lastNameInput: lastNameInput,\n' +
  '      daySel: dob.daySel, monthSel: dob.monthSel, yearSel: dob.yearSel,\n' +
  '      genderSelect: genderSelect,\n' +
  '      childCheckbox: childCheckbox,\n' +
  '      idInput: idInput,\n' +
  '      seatSelect: seatSelect\n' +
  '    });\n' +
  '    form.appendChild(pBlock);\n' +
  '  }\n' +

  '  var contactLabel = document.createElement("div");\n' +
  '  contactLabel.style.fontSize = "11px";\n' +
  '  contactLabel.style.fontWeight = "700";\n' +
  '  contactLabel.style.color = "#1E2A5E";\n' +
  '  contactLabel.style.marginBottom = "6px";\n' +
  '  contactLabel.innerText = "Contact details";\n' +
  '  form.appendChild(contactLabel);\n' +

  '  var phoneInput = document.createElement("input");\n' +
  '  phoneInput.className = "name-input";\n' +
  '  phoneInput.placeholder = "Phone (e.g. 0712345678)";\n' +
  '  phoneInput.type = "tel";\n' +
  '  form.appendChild(phoneInput);\n' +

  '  var emailInput = document.createElement("input");\n' +
  '  emailInput.className = "name-input";\n' +
  '  emailInput.placeholder = "Email";\n' +
  '  emailInput.type = "email";\n' +
  '  form.appendChild(emailInput);\n' +

  '  var errorMsg = document.createElement("div");\n' +
  '  errorMsg.style.color = "#C0392B";\n' +
  '  errorMsg.style.fontSize = "11px";\n' +
  '  errorMsg.style.marginBottom = "8px";\n' +
  '  errorMsg.style.display = "none";\n' +
  '  form.appendChild(errorMsg);\n' +

  '  var confirmBtn = document.createElement("button");\n' +
  '  confirmBtn.className = "confirm-btn";\n' +
  '  confirmBtn.innerText = "Confirm Booking";\n' +
  '  confirmBtn.onclick = function() {\n' +
  '    errorMsg.style.display = "none";\n' +
  '    var passengers = [];\n' +
  '    for (var k = 0; k < passengerInputs.length; k++) {\n' +
  '      var pin = passengerInputs[k];\n' +
  '      var fn = pin.firstNameInput.value.trim();\n' +
  '      var ln = pin.lastNameInput.value.trim();\n' +
  '      if (!fn || !ln) { errorMsg.innerText = "Please fill in all traveler names."; errorMsg.style.display = "block"; return; }\n' +
  '      var day = pin.daySel.value, month = pin.monthSel.value, year = pin.yearSel.value;\n' +
  '      if (!day || !month || !year) { errorMsg.innerText = "Please select a complete date of birth for traveler " + (k+1) + "."; errorMsg.style.display = "block"; return; }\n' +
  '      var dob = year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");\n' +
  '      var isChild = pin.childCheckbox.checked;\n' +
  '      var idNum = pin.idInput.value.trim();\n' +
  '      if (!isChild && !idNum) { errorMsg.innerText = "Passport/ID number is required for traveler " + (k+1) + " (unless marked as a child)."; errorMsg.style.display = "block"; return; }\n' +
  '      passengers.push({\n' +
  '        firstName: fn, lastName: ln, dateOfBirth: dob,\n' +
  '        gender: pin.genderSelect.value,\n' +
  '        type: isChild ? "child" : "adult",\n' +
  '        idNumber: idNum || null,\n' +
  '        seatPreference: (pin.seatSelect && pin.seatSelect.value) ? pin.seatSelect.value : null\n' +
  '      });\n' +
  '    }\n' +
  '    var phone = phoneInput.value.trim();\n' +
  '    var email = emailInput.value.trim();\n' +
  '    if (!phone) { errorMsg.innerText = "Phone number is required."; errorMsg.style.display = "block"; return; }\n' +
  '    if (needsFlightDetails && !email) { errorMsg.innerText = "Email is required for flight bookings."; errorMsg.style.display = "block"; return; }\n' +

  '    var guestName = passengers[0].firstName + " " + passengers[0].lastName;\n' +
  '    var bookCtx = { guestName: guestName, phone: phone, email: email, passengers: passengers, pkg: p };\n' +
  '    confirmBtn.innerText = "Processing...";\n' +
  '    confirmBtn.disabled = true;\n' +
  '    fetch("' + apiBase + '/api/trips/book-init", {\n' +
  '      method: "POST",\n' +
  '      headers: { "Content-Type": "application/json" },\n' +
  '      body: JSON.stringify({\n' +
  '        agencyId: "' + agencyKey + '",\n' +
  '        guestName: guestName,\n' +
  '        guestPhone: phone,\n' +
  '        guestEmail: email,\n' +
  '        passengers: passengers,\n' +
  '        package: p\n' +
  '      })\n' +
  '    })\n' +
  '    .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })\n' +
  '    .then(function(result) {\n' +
  '      if (!result.ok && result.data && result.data.code === "PRICE_CHANGED") {\n' +
  '        form.remove();\n' +
  '        showPriceApprovalAlert(result.data, bookCtx, bookBtn);\n' +
  '        return;\n' +
  '      }\n' +
  '      if (!result.ok || !result.data.success) {\n' +
  '        var msg = (result.data && result.data.error) ? result.data.error : "Booking failed. Please try again.";\n' +
  '        errorMsg.innerText = msg;\n' +
  '        errorMsg.style.display = "block";\n' +
  '        confirmBtn.innerText = "Confirm Booking";\n' +
  '        confirmBtn.disabled = false;\n' +
  '        return;\n' +
  '      }\n' +
  '      form.remove();\n' +
  '      continueToPayment(result.data, bookCtx, bookBtn);\n' +
  '    })\n' +
  '    .catch(function() {\n' +
  '      errorMsg.innerText = "Network error. Please try again.";\n' +
  '      errorMsg.style.display = "block";\n' +
  '      confirmBtn.innerText = "Confirm Booking";\n' +
  '      confirmBtn.disabled = false;\n' +
  '    });\n' +
  '  };\n' +
  '  form.appendChild(confirmBtn);\n' +
  '  var trustBadge = document.createElement("div");\n' +
  '  trustBadge.className = "trust-badge";\n' +
  '  trustBadge.innerHTML = "<svg viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"><path d=\\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\\"/><path d=\\"M9 12l2 2 4-4\\"/></svg> Secure payment via M-Pesa";\n' +
  '  form.appendChild(trustBadge);\n' +
  '  messages.appendChild(form);\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  'function addPackage(p, i) {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "package";\n' +
  '  div.style.height = "auto";\n' +
  '  var transport       = p.transport       || null;\n' +
  '  var returnTransport = p.returnTransport || null;\n' +
  '  var hotel     = p.hotel     || null;\n' +
  '  var transfers = p.transfers || null;\n' +
  '  var summary   = p.summary   || {};\n' +
  '  var totalCurrency = summary.currency || "KES";\n' +
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

  '  if (transport) {\n' +
  '    var isbus = (transport.transportType || "").toLowerCase() === "bus";\n' +
  '    var tLabel = isbus ? "Outbound Bus" : "Outbound Flight";\n' +
  '    var tName  = transport.airline || transport.provider || "TBC";\n' +
  '    var tSub   = (transport.origin || "TBC") + " \u2192 " + (transport.destination || "TBC") +\n' +
  '                 " | " + fmtTime(transport.departureTime) + " - " + fmtTime(transport.arrivalTime);\n' +
  '    if (transport.stops) tSub += " | " + transport.stops;\n' +
  '    if (transport.cabinClass) tSub += " | " + transport.cabinClass;\n' +
  '    if (!isbus && transport.baggageSummary) tSub += " | " + transport.baggageSummary;\n' +
  '    tSub += " | " + fmtPrice(transport.price, transport.currency);\n' +
  '    pkgBody.appendChild(makeRow(tLabel, tName, tSub));\n' +
  '    var tPolicyText = transport.policySummary || (isbus ? transport.cancellationPolicy : null);\n' +
  '    if (tPolicyText) {\n' +
  '      var tTone = transport.isRefundable === true ? "good" : transport.isRefundable === false ? "warn" : "neutral";\n' +
  '      pkgBody.appendChild(makeHighlightRow(tPolicyText, tTone));\n' +
  '    }\n' +
  '  }\n' +

  '  if (returnTransport) {\n' +
  '    var isRetBus = (returnTransport.transportType || "").toLowerCase() === "bus";\n' +
  '    var rtLabel = isRetBus ? "Return Bus" : "Return Flight";\n' +
  '    var rtName  = returnTransport.airline || returnTransport.provider || "TBC";\n' +
  '    var rtSub   = (returnTransport.origin || "TBC") + " \u2192 " + (returnTransport.destination || "TBC") +\n' +
  '                  " | " + fmtTime(returnTransport.departureTime) + " - " + fmtTime(returnTransport.arrivalTime);\n' +
  '    if (returnTransport.stops) rtSub += " | " + returnTransport.stops;\n' +
  '    if (!isRetBus && returnTransport.baggageSummary) rtSub += " | " + returnTransport.baggageSummary;\n' +
  '    rtSub += " | " + fmtPrice(returnTransport.price, returnTransport.currency);\n' +
  '    pkgBody.appendChild(makeRow(rtLabel, rtName, rtSub));\n' +
  '    var rtPolicyText = returnTransport.policySummary || (isRetBus ? returnTransport.cancellationPolicy : null);\n' +
  '    if (rtPolicyText) {\n' +
  '      var rtTone = returnTransport.isRefundable === true ? "good" : returnTransport.isRefundable === false ? "warn" : "neutral";\n' +
  '      pkgBody.appendChild(makeHighlightRow(rtPolicyText, rtTone));\n' +
  '    }\n' +
  '  }\n' +

  '  if (hotel) {\n' +
  '    var stars = hotel.stars ? Array(Math.min(Math.round(hotel.stars), 5) + 1).join("\u2605") : "";\n' +
  '    var hName = (hotel.name || "TBC") + (stars ? " " + stars : "");\n' +
  '    var hSub  = (hotel.location || "TBC");\n' +
  '    if (nights > 0) hSub += " | " + nights + " nights | " + fmtPrice(hotel.pricePerNight, hotel.currency) + "/night";\n' +
  '    if (hotel.rating) hSub += " | Rating: " + hotel.rating + "/5";\n' +
  '    if (hotel.images && hotel.images.length > 0) {\n' +
  '      var hotelImg = document.createElement("img");\n' +
  '      hotelImg.src = hotel.images[0];\n' +
  '      hotelImg.alt = hotel.name || "Hotel";\n' +
  '      hotelImg.style.width = "100%";\n' +
  '      hotelImg.style.height = "140px";\n' +
  '      hotelImg.style.objectFit = "cover";\n' +
  '      hotelImg.style.borderRadius = "10px";\n' +
  '      hotelImg.style.marginBottom = "8px";\n' +
  '      hotelImg.style.display = "block";\n' +
  '      hotelImg.onerror = function() { this.style.display = "none"; };\n' +
  '      pkgBody.appendChild(hotelImg);\n' +
  '    }\n' +
  '    pkgBody.appendChild(makeRow("Hotel", hName, hSub));\n' +
  '    if (hotel.mealPlan) {\n' +
  '      pkgBody.appendChild(makeHighlightRow("\ud83c\udf7d\ufe0f Board: " + hotel.mealPlan, "neutral"));\n' +
  '    }\n' +
  '    var hPolicyTone = hotel.isRefundable === false ? "warn" : hotel.isRefundable === true || hotel.policySummary ? "good" : "neutral";\n' +
  '    var hPolicyText = hotel.policySummary || (hotel.isRefundable === false ? "\u26a0\ufe0f Non-refundable" : "Refund terms confirmed at booking");\n' +
  '    pkgBody.appendChild(makeHighlightRow(hPolicyText, hPolicyTone));\n' +
  '  }\n' +

  '  var transferList = Array.isArray(transfers) ? transfers : (transfers ? [transfers] : []);\n' +
  '  if (transferList.length > 0) {\n' +
  '    var transferSub = transferList.map(function(t) {\n' +
  '      var legLabel = t.legType === "departure" ? "Departure" : t.legType === "arrival" ? "Arrival" : (t.provider || "Transfer");\n' +
  '      return legLabel + ": " + (t.description || t.location || "TBC") + " (" + fmtPrice(t.price, t.currency) + ")";\n' +
  '    }).join(" | ");\n' +
  '    pkgBody.appendChild(makeRow("Transfer", transferList[0].provider || "Bodrless Standard Transfer", transferSub));\n' +
  '  }\n' +

  '  if (p.connectionAdvisory) {\n' +
  '    var advisoryRow = document.createElement("div");\n' +
  '    advisoryRow.className = "pkg-row";\n' +
  '    var advisoryLabel = document.createElement("div");\n' +
  '    advisoryLabel.className = "pkg-label";\n' +
  '    advisoryLabel.innerText = "\u26a0\ufe0f Before you book";\n' +
  '    var advisoryText = document.createElement("div");\n' +
  '    advisoryText.className = "pkg-sub";\n' +
  '    advisoryText.innerText = p.connectionAdvisory;\n' +
  '    advisoryRow.appendChild(advisoryLabel);\n' +
  '    advisoryRow.appendChild(advisoryText);\n' +
  '    pkgBody.appendChild(advisoryRow);\n' +
  '  }\n' +

  '  var pkgFooter = document.createElement("div");\n' +
  '  pkgFooter.className = "pkg-footer";\n' +
  '  pkgFooter.style.height = "auto";\n' +
  '  var pkgPrice = document.createElement("div");\n' +
  '  pkgPrice.className = "pkg-price";\n' +
  '  pkgPrice.innerText = fmtPrice(total, totalCurrency);\n' +
  '  var pkgPriceSub = document.createElement("small");\n' +
  '  pkgPriceSub.innerText = fmtPrice(ppp, totalCurrency) + "/person | " + passengers + " traveller(s)";\n' +
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

  'function addItinerary(p) {\n' +
  '  var div = document.createElement("div");\n' +
  '  div.className = "package";\n' +
  '  div.style.height = "auto";\n' +
  '  var summary = p.summary || {};\n' +
  '  var legs = p.legs || [];\n' +
  '  var totalCurrency = summary.currency || "KES";\n' +
  '  var total = Math.round(summary.totalPrice || 0);\n' +
  '  var ppp = Math.round(summary.pricePerPerson || 0);\n' +
  '  var passengers = summary.passengers || 1;\n' +

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

  '  legs.forEach(function(leg, idx) {\n' +
  '    var stopDiv = document.createElement("div");\n' +
  '    stopDiv.className = "itin-stop" + (leg.isBufferLeg ? " buffer" : "");\n' +

  '    var titleDiv = document.createElement("div");\n' +
  '    titleDiv.className = "itin-stop-title" + (leg.isBufferLeg ? " buffer" : "");\n' +
  '    titleDiv.innerText = leg.isBufferLeg\n' +
  '      ? "Connection: overnight in " + titleCase(leg.destination)\n' +
  '      : "Stop " + (idx + 1) + ": " + titleCase(leg.destination) + " (" + leg.nights + " night" + (leg.nights === 1 ? "" : "s") + ")";\n' +
  '    stopDiv.appendChild(titleDiv);\n' +

  '    var t = leg.transportIn;\n' +
  '    if (t) {\n' +
  '      var isbus = (t.transportType || "").toLowerCase() === "bus";\n' +
  '      var tLine = document.createElement("div");\n' +
  '      tLine.className = "itin-line";\n' +
  '      tLine.innerText = (isbus ? "Bus: " : "Flight: ") + (t.airline || t.provider || "TBC") + " | " +\n' +
  '        (t.origin || "TBC") + " \u2192 " + (t.destination || "TBC") + " | " +\n' +
  '        fmtTime(t.departureTime) + "-" + fmtTime(t.arrivalTime) + " | " + fmtPrice(t.price, t.currency);\n' +
  '      stopDiv.appendChild(tLine);\n' +
  '      if (leg.connectsVia && !leg.isBufferLeg) {\n' +
  '        var connLine = document.createElement("div");\n' +
  '        connLine.className = "itin-connects";\n' +
  '        connLine.innerText = "Connects via " + titleCase(leg.connectsVia);\n' +
  '        stopDiv.appendChild(connLine);\n' +
  '      }\n' +
  '    }\n' +

  '    if (leg.hotel) {\n' +
  '      var h = leg.hotel;\n' +
  '      var stars = h.stars ? Array(Math.min(Math.round(h.stars), 5) + 1).join("\u2605") : "";\n' +
  '      var hLine = document.createElement("div");\n' +
  '      hLine.className = "itin-line";\n' +
  '      hLine.innerText = "Hotel: " + (h.name || "TBC") + (stars ? " " + stars : "") +\n' +
  '        (h.location ? " | " + h.location : "") +\n' +
  '        " | " + fmtPrice(h.pricePerNight, h.currency) + "/night \u00d7 " + leg.nights;\n' +
  '      stopDiv.appendChild(hLine);\n' +
  '    }\n' +

  '    var transferList = Array.isArray(leg.transfers) ? leg.transfers : (leg.transfers ? [leg.transfers] : []);\n' +
  '    if (transferList.length > 0) {\n' +
  '      var trLine = document.createElement("div");\n' +
  '      trLine.className = "itin-line";\n' +
  '      trLine.innerText = "Transfer: " + transferList.map(function(tr) {\n' +
  '        var legLabel = tr.legType === "departure" ? "Departure" : tr.legType === "arrival" ? "Arrival" : (tr.provider || "Transfer");\n' +
  '        return legLabel + " (" + fmtPrice(tr.price, tr.currency) + ")";\n' +
  '      }).join(" | ");\n' +
  '      stopDiv.appendChild(trLine);\n' +
  '    }\n' +

  '    pkgBody.appendChild(stopDiv);\n' +
  '  });\n' +

  '  if (p.returnTransport) {\n' +
  '    var rt = p.returnTransport;\n' +
  '    var isRetBus = (rt.transportType || "").toLowerCase() === "bus";\n' +
  '    var returnDiv = document.createElement("div");\n' +
  '    returnDiv.className = "itin-stop";\n' +
  '    var returnTitle = document.createElement("div");\n' +
  '    returnTitle.className = "itin-stop-title";\n' +
  '    returnTitle.innerText = "Return";\n' +
  '    returnDiv.appendChild(returnTitle);\n' +
  '    var returnLine = document.createElement("div");\n' +
  '    returnLine.className = "itin-line";\n' +
  '    returnLine.innerText = (isRetBus ? "Bus: " : "Flight: ") + (rt.origin || "TBC") + " \u2192 " + (rt.destination || "TBC") +\n' +
  '      " | " + fmtTime(rt.departureTime) + "-" + fmtTime(rt.arrivalTime) + " | " + fmtPrice(rt.price, rt.currency);\n' +
  '    returnDiv.appendChild(returnLine);\n' +
  '    pkgBody.appendChild(returnDiv);\n' +
  '  }\n' +

  '  var pkgFooter = document.createElement("div");\n' +
  '  pkgFooter.className = "pkg-footer";\n' +
  '  pkgFooter.style.height = "auto";\n' +
  '  var pkgPrice = document.createElement("div");\n' +
  '  pkgPrice.className = "pkg-price";\n' +
  '  pkgPrice.innerText = fmtPrice(total, totalCurrency);\n' +
  '  var pkgPriceSub = document.createElement("small");\n' +
  '  pkgPriceSub.innerText = fmtPrice(ppp, totalCurrency) + "/person | " + passengers + " traveller(s)";\n' +
  '  pkgPrice.appendChild(pkgPriceSub);\n' +
  '  var bookBtn = document.createElement("button");\n' +
  '  bookBtn.className = "book";\n' +
  '  bookBtn.innerText = "Book This Itinerary";\n' +
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
  '  transcript.push({ type: "user", text: text });\n' +
  '  persistState();\n' +
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
  '    if (data.needsClarification) {\n' +
  '      var clarifyText = data.text || "Could you give me a bit more detail about your trip?";\n' +
  '      addMsg(clarifyText, "bot");\n' +
  '      transcript.push({ type: "bot", text: clarifyText });\n' +
  '      persistState();\n' +
  '      return;\n' +
  '    }\n' +
  '    var packages = data && data.packages ? data.packages : [];\n' +
  '    if (!packages.length) {\n' +
  '      var noneText = (data && data.text) ? data.text : "No packages found. Try specifying destination, number of people and nights.";\n' +
  '      addMsg(noneText, "bot");\n' +
  '      transcript.push({ type: "bot", text: noneText });\n' +
  '      persistState();\n' +
  '      return;\n' +
  '    }\n' +
  '    var isItinerary = packages.length === 1 && packages[0] && packages[0].isMultiDestination;\n' +
  '    var intent = data.intent || {};\n' +
  '    var responseMsg = isItinerary\n' +
  '      ? "I put together your multi-stop itinerary:"\n' +
  '      : "I found " + packages.length + " option(s) for you:";\n' +
  '    if (!isItinerary && intent.isFollowUp) {\n' +
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
  '    transcript.push({ type: "bot", text: responseMsg });\n' +
  '    if (isItinerary) {\n' +
  '      addItinerary(packages[0]);\n' +
  '      transcript.push({ type: "itinerary", pkg: packages[0] });\n' +
  '    } else {\n' +
  '      var limitedPackages = packages.slice(0, 4);\n' +
  '      limitedPackages.forEach(function(p, i) { addPackage(p, i); });\n' +
  '      transcript.push({ type: "packages", packages: limitedPackages });\n' +
  '    }\n' +
  '    persistState();\n' +
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