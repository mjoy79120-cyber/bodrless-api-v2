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

  'var style = document.createElement("style");\n' +
  'style.innerHTML = [\n' +
  '":root{--et-navy:#1E2A5E;--et-red:#C0392B;--et-white:#FFFFFF;--et-cream:#F9F7F4;--et-border:#E8E3DA;--et-muted:#9A9088;--et-green:#27ae60;--et-gold:#B8964A;}",\n' +
  '"#bodrless-chat{background:var(--et-white);z-index:999999;display:none;flex-direction:column;border-radius:18px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.14);font-family:\'Inter\',Arial,sans-serif;}",\n' +
  '"#bodrless-chat.open{display:flex;}",\n' +
  '"#bodrless-chat.floating{position:fixed;bottom:90px;right:24px;width:390px;height:640px;}",\n' +
  '"#bodrless-chat.embedded{position:relative;width:100%;height:760px;display:flex;border-radius:0;}",\n' +
  '"@keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:0.5;}30%{transform:translateY(-5px);opacity:1;}}",\n' +
  '"#et-header{background:var(--et-navy);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}",\n' +
  '"#et-header-left{display:flex;align-items:center;gap:12px;}",\n' +
  '"#et-logo-wrap{width:38px;height:38px;background:rgba(255,255,255,0.1);border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;}",\n' +
  '"#et-logo-wrap img{width:34px;height:34px;object-fit:contain;}",\n' +
  '"#et-header-text h3{font-size:14px;color:white;margin:0 0 1px 0;font-weight:600;letter-spacing:0.2px;}",\n' +
  '"#et-header-text p{font-size:10px;color:rgba(255,255,255,0.5);margin:0;letter-spacing:1px;text-transform:uppercase;}",\n' +
  '"#et-close{background:rgba(255,255,255,0.08);border:none;color:rgba(255,255,255,0.7);width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:background 0.2s;}",\n' +
  '"#et-close:hover{background:rgba(255,255,255,0.18);}",\n' +
  '"#bodrless-messages{flex:1;padding:20px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:12px;background:var(--et-cream);}",\n' +
  '".msg{padding:11px 15px;border-radius:16px;max-width:82%;font-size:13.5px;line-height:1.55;}",\n' +
  '".user{background:var(--et-navy);color:white;margin-left:auto;border-bottom-right-radius:4px;}",\n' +
  '".bot{background:var(--et-white);color:#2A2A2A;border:1px solid var(--et-border);border-bottom-left-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,0.05);}",\n' +
  '".typing{background:var(--et-white);border:1px solid var(--et-border);padding:12px 16px;border-radius:16px;display:flex;gap:5px;align-items:center;width:fit-content;}",\n' +
  '".typing span{width:6px;height:6px;background:var(--et-navy);border-radius:50%;animation:bounce 1.2s infinite;}",\n' +
  '".typing span:nth-child(2){animation-delay:0.2s;background:var(--et-gold);}",\n' +
  '".typing span:nth-child(3){animation-delay:0.4s;}",\n' +
  '".et-welcome{background:var(--et-white);border-radius:14px;padding:20px;border:1px solid var(--et-border);}",\n' +
  '".et-welcome-eyebrow{font-size:10px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:var(--et-gold);margin-bottom:10px;}",\n' +
  '".et-welcome-title{font-size:18px;font-weight:600;color:var(--et-navy);margin-bottom:8px;line-height:1.3;}",\n' +
  '".et-welcome-body{font-size:13px;color:#5A5A5A;line-height:1.65;margin-bottom:18px;}",\n' +
  '".et-divider{height:1px;background:var(--et-border);margin:4px 0 16px 0;}",\n' +
  '".et-prompts-label{font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--et-muted);margin-bottom:12px;}",\n' +
  '".et-starter{width:100%;background:var(--et-cream);border:1px solid var(--et-border);border-radius:12px;padding:14px 16px;text-align:left;cursor:pointer;transition:all 0.2s;margin-bottom:8px;display:block;}",\n' +
  '".et-starter:last-child{margin-bottom:0;}",\n' +
  '".et-starter:hover{background:var(--et-navy);border-color:var(--et-navy);}",\n' +
  '".et-starter:hover .st-title{color:white;}",\n' +
  '".et-starter:hover .st-body{color:rgba(255,255,255,0.7);}",\n' +
  '".st-title{font-size:13px;font-weight:600;color:var(--et-navy);margin-bottom:3px;}",\n' +
  '".st-body{font-size:12px;color:var(--et-muted);line-height:1.45;}",\n' +
  '".et-agency-welcome{background:linear-gradient(135deg,#1E2A5E 0%,#2d3f82 100%);border-radius:16px;padding:16px;color:white;border-left:4px solid #C0392B;}",\n' +
  '".et-agency-welcome h4{font-size:14px;margin:0 0 6px 0;}",\n' +
  '".et-agency-welcome p{font-size:12px;margin:0 0 12px 0;color:rgba(255,255,255,0.7);}",\n' +
  '".et-suggestions{display:flex;flex-wrap:wrap;gap:6px;}",\n' +
  '".et-suggestion{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.9);padding:5px 10px;border-radius:20px;font-size:11px;cursor:pointer;}",\n' +
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
  '".cancel-policy{display:flex;align-items:center;gap:6px;font-size:11px;padding:8px 10px;border-radius:8px;margin-top:4px;}",\n' +
  '".cancel-policy.refundable{background:#E8F8EE;color:#1B7A3D;}",\n' +
  '".cancel-policy.non-refundable{background:#FFF0F0;color:#A02020;}",\n' +
  '".cancel-policy.neutral{background:#F0EDE8;color:#5A4A3A;}",\n' +
  // Price match badge
  '".price-match-badge{background:#E8F8EE;border:1px solid #A8D8B8;border-radius:10px;padding:10px 12px;margin:6px 0;display:flex;align-items:center;gap:10px;}",\n' +
  '".pm-icon{font-size:18px;flex-shrink:0;}",\n' +
  '".pm-label{font-size:10px;font-weight:700;color:#1B7A3D;letter-spacing:1px;text-transform:uppercase;}",\n' +
  '".pm-detail{font-size:11px;color:#2A5A3A;margin-top:2px;}",\n' +
  '"#bodrless-input-area{display:flex;border-top:1px solid var(--et-border);background:var(--et-white);padding:12px;gap:8px;flex-shrink:0;}",\n' +
  '"#bodrless-input{flex:1;padding:10px 14px;border:1.5px solid var(--et-border);border-radius:20px;outline:none;font-size:13px;background:var(--et-cream);color:#2A2A2A;font-family:\'Inter\',Arial,sans-serif;}",\n' +
  '"#bodrless-input:focus{border-color:var(--et-navy);}",\n' +
  '"#bodrless-input::placeholder{color:var(--et-muted);font-size:12px;}",\n' +
  '"#bodrless-send{background:var(--et-navy);color:white;border:none;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 0.2s;}",\n' +
  '"#bodrless-send:hover{background:var(--et-gold);}",\n' +
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
  '".hl{padding:7px 10px;border-radius:8px;font-size:11px;font-weight:600;margin-top:6px;}",\n' +
  '".hl-good{background:#E8F8EE;color:#1B7A3D;}",\n' +
  '".hl-warn{background:#FFF3E0;color:#B05A00;}",\n' +
  '".hl-neutral{background:#F0EDE8;color:#5A4A3A;}",\n' +
  '".manage-card{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;padding:16px;margin-top:8px;}",\n' +
  '".manage-card p{font-size:12px;color:var(--et-navy);margin:0 0 12px 0;font-weight:500;}",\n' +
  '".manage-actions{display:flex;gap:8px;}",\n' +
  '".manage-btn{flex:1;padding:10px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;border:1.5px solid var(--et-border);background:var(--et-cream);color:var(--et-navy);transition:all 0.2s;}",\n' +
  '".manage-btn:hover{background:var(--et-navy);color:white;border-color:var(--et-navy);}",\n' +
  '".manage-btn.danger:hover{background:var(--et-red);border-color:var(--et-red);color:white;}",\n' +
  '".itin-stop{padding:10px 0;border-bottom:1px dashed var(--et-border);}",\n' +
  '".itin-stop:last-child{border-bottom:none;}",\n' +
  '".itin-stop-title{font-size:12px;font-weight:700;color:var(--et-navy);margin-bottom:4px;}",\n' +
  '".itin-line{font-size:11px;color:var(--et-muted);line-height:1.5;margin-bottom:2px;}",\n' +
  '".price-alert{background:#FFF8EC;border:1px solid #E8C96D;border-radius:12px;padding:12px;margin-top:8px;}",\n' +
  '".price-alert p{font-size:12px;color:#5A4A1A;margin:0 0 10px 0;line-height:1.5;}",\n' +
  '".price-alert-actions{display:flex;gap:8px;}",\n' +
  '".price-approve{flex:1;background:var(--et-navy);color:white;border:none;padding:9px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;}",\n' +
  '".price-cancel{flex:1;background:white;color:var(--et-navy);border:1.5px solid var(--et-border);padding:9px 14px;border-radius:20px;cursor:pointer;font-size:12px;}",\n' +
  // Powered by Bodrless
  '".bodrless-powered{text-align:center;padding:8px 0 4px;font-size:10px;color:var(--et-muted);letter-spacing:0.5px;}",\n' +
  '".bodrless-powered a{color:var(--et-muted);text-decoration:none;font-weight:600;}",\n' +
  '".bodrless-powered a:hover{color:var(--et-navy);}"\n' +
  '].join("");\n' +
  'document.head.appendChild(style);\n' +

  'var root = document.createElement("div");\n' +
  'root.id = "bodrless-widget-root";\n' +
  'var chatDiv = document.createElement("div");\n' +
  'chatDiv.id = "bodrless-chat";\n' +
  'if (embedTarget) { chatDiv.classList.add("embedded"); } else { chatDiv.classList.add("floating"); }\n' +

  'var header = document.createElement("div");\n' +
  'header.id = "et-header";\n' +
  'var headerLeft = document.createElement("div");\n' +
  'headerLeft.id = "et-header-left";\n' +
  'var logoWrap = document.createElement("div");\n' +
  'logoWrap.id = "et-logo-wrap";\n' +
  'logoWrap.innerText = "' + agencyName.charAt(0) + '";\n' +
  'logoWrap.style.cssText += ";display:flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:50%;background:#0F4C3A;color:#fff;font-family:Playfair Display,serif;font-size:22px;font-weight:700;box-shadow:0 6px 16px rgba(0,0,0,.18);flex-shrink:0;";\n' +
  'var headerText = document.createElement("div");\n' +
  'headerText.id = "et-header-text";\n' +
  'headerText.innerHTML = "<h3>' + agencyName + '</h3><p>" + (isHotelMode ? "Concierge" : "Travel Specialist") + "</p>";\n' +
  'headerLeft.appendChild(logoWrap);\n' +
  'headerLeft.appendChild(headerText);\n' +
  'var closeBtn = document.createElement("button");\n' +
  'closeBtn.id = "et-close";\n' +
  'closeBtn.innerHTML = "&#215;";\n' +
  'if (embedTarget) closeBtn.style.display = "none";\n' +
  'header.appendChild(headerLeft);\n' +
  'header.appendChild(closeBtn);\n' +

  'var messages = document.createElement("div");\n' +
  'messages.id = "bodrless-messages";\n' +

  // Powered by Bodrless footer
  'var poweredBy = document.createElement("div");\n' +
  'poweredBy.className = "bodrless-powered";\n' +
  'poweredBy.innerHTML = "Powered by <a href=\'https://bodrless.com\' target=\'_blank\'>Bodrless</a>";\n' +

  'var inputArea = document.createElement("div");\n' +
  'inputArea.id = "bodrless-input-area";\n' +
  'var input = document.createElement("input");\n' +
  'input.id = "bodrless-input";\n' +
  'input.placeholder = isHotelMode ? "How can I help you plan your stay?" : "Where would you like to go?";\n' +
  'var sendBtn = document.createElement("button");\n' +
  'sendBtn.id = "bodrless-send";\n' +
  'sendBtn.innerHTML = "&#10148;";\n' +
  'inputArea.appendChild(input);\n' +
  'inputArea.appendChild(sendBtn);\n' +
  'chatDiv.appendChild(header);\n' +
  'chatDiv.appendChild(messages);\n' +
  'chatDiv.appendChild(poweredBy);\n' +
  'chatDiv.appendChild(inputArea);\n' +
  'root.appendChild(chatDiv);\n' +

  'if (embedTarget) {\n' +
  '  var mount = document.getElementById(embedTarget);\n' +
  '  if (mount) { mount.appendChild(root); } else { document.body.appendChild(root); }\n' +
  '} else {\n' +
  '  document.body.appendChild(root);\n' +
  '}\n' +

  'var welcomeShown = false;\n' +
  'if (!embedTarget) {\n' +
  '  var triggerBtn = document.createElement("button");\n' +
  '  triggerBtn.id = "bodrless-trigger";\n' +
  '  triggerBtn.innerText = isHotelMode ? "Book a Room" : "Plan Your Trip";\n' +
  '  document.body.appendChild(triggerBtn);\n' +
  '  triggerBtn.onclick = function() {\n' +
  '    chatDiv.classList.add("open"); input.focus();\n' +
  '    if (!welcomeShown) { welcomeShown = true; if (hasRestoredHistory) { replayTranscript(); } else { showWelcome(); } }\n' +
  '  };\n' +
  '  closeBtn.onclick = function() { chatDiv.classList.remove("open"); };\n' +
  '} else {\n' +
  '  chatDiv.classList.add("open");\n' +
  '  if (!welcomeShown) { welcomeShown = true; if (hasRestoredHistory) { replayTranscript(); } else { showWelcome(); } }\n' +
  '}\n' +

  'function showWelcome() {\n' +
  '  if (isHotelMode) { showHotelEntry(); } else { showAgencyWelcome(); }\n' +
  '}\n' +

  'function showHotelEntry() {\n' +
  '  var card = document.createElement("div"); card.className = "et-welcome"; card.id = "et-hotel-entry";\n' +
  '  var eyebrow = document.createElement("div"); eyebrow.className = "et-welcome-eyebrow"; eyebrow.innerText = "Your Personal Concierge";\n' +
  '  var title = document.createElement("div"); title.className = "et-welcome-title"; title.innerText = "Welcome to ' + agencyName + '";\n' +
  '  var body = document.createElement("div"); body.className = "et-welcome-body"; body.innerText = "It\'s a pleasure to have you with us. Tell me the occasion, your preferred dates, and how many guests — I\'ll take care of finding the perfect room and making it special.";\n' +
  '  var ctaBtn = document.createElement("button");\n' +
  '  ctaBtn.style.cssText = "display:block;width:100%;background:var(--et-navy);color:white;border:none;padding:12px 20px;border-radius:20px;cursor:pointer;font-size:13px;font-weight:600;letter-spacing:0.3px;margin-top:4px;transition:background 0.2s;";\n' +
  '  ctaBtn.innerText = "Start Planning";\n' +
  '  ctaBtn.onmouseover = function(){this.style.background="var(--et-gold)";};\n' +
  '  ctaBtn.onmouseout  = function(){this.style.background="var(--et-navy)";};\n' +
  '  ctaBtn.onclick = function() {\n' +
  '    card.remove();\n' +
  '    var mountEl = embedTarget ? document.getElementById(embedTarget) : null;\n' +
  '    if (mountEl) { mountEl.scrollIntoView({ behavior: "smooth", block: "start" }); }\n' +
  '    setTimeout(function(){ showHotelWelcome(); input.focus(); }, 300);\n' +
  '  };\n' +
  '  card.appendChild(eyebrow); card.appendChild(title); card.appendChild(body); card.appendChild(ctaBtn);\n' +
  '  messages.appendChild(card); messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  'function showHotelWelcome() {\n' +
  '  var card = document.createElement("div"); card.className = "et-welcome";\n' +
  '  var eyebrow = document.createElement("div"); eyebrow.className = "et-welcome-eyebrow"; eyebrow.innerText = "Your Personal Concierge";\n' +
  '  var title = document.createElement("div"); title.className = "et-welcome-title"; title.innerText = "Welcome to ' + agencyName + '";\n' +
  '  var body = document.createElement("div"); body.className = "et-welcome-body"; body.innerText = "It\'s a pleasure to have you with us. Tell me the occasion, your preferred dates, and how many guests — I\'ll take care of finding the perfect room and making it special.";\n' +
  '  var divider = document.createElement("div"); divider.className = "et-divider";\n' +
  '  var promptLabel = document.createElement("div"); promptLabel.className = "et-prompts-label"; promptLabel.innerText = "Popular requests";\n' +
  '  var starters = (window.bodrlessStarters && window.bodrlessStarters.length) ? window.bodrlessStarters.slice(0,3) : [\n' +
  '    { icon: "\u2764\uFE0F", title: "Romantic Getaway", text: "We\'re celebrating our anniversary — recommend your most romantic room for 2 nights." },\n' +
  '    { icon: "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67", title: "Family Stay", text: "Family room for 2 adults and 2 children, full board, arriving this weekend." },\n' +
  '    { icon: "\uD83D\uDCBC", title: "Business Trip", text: "Single business room for tomorrow night, need early check-in if possible." }\n' +
  '  ];\n' +
  '  card.appendChild(eyebrow); card.appendChild(title); card.appendChild(body); card.appendChild(divider); card.appendChild(promptLabel);\n' +
  '  starters.forEach(function(s) {\n' +
  '    var btn = document.createElement("button"); btn.className = "et-starter";\n' +
  '    var t = document.createElement("div"); t.className = "st-title"; t.innerText = s.icon + "  " + s.title;\n' +
  '    var b = document.createElement("div"); b.className = "st-body";  b.innerText = s.text;\n' +
  '    btn.appendChild(t); btn.appendChild(b);\n' +
  '    btn.onclick = function() { input.value = s.text; send(); };\n' +
  '    card.appendChild(btn);\n' +
  '  });\n' +
  '  var manageBtn = document.createElement("button"); manageBtn.className = "et-starter"; manageBtn.style.cssText += "margin-top:12px;border-color:#C0C0C0;";\n' +
  '  var mt = document.createElement("div"); mt.className = "st-title"; mt.innerText = "\uD83D\uDD11  Manage a Booking";\n' +
  '  var mb = document.createElement("div"); mb.className = "st-body";  mb.innerText = "View, modify, or cancel an existing reservation.";\n' +
  '  manageBtn.appendChild(mt); manageBtn.appendChild(mb);\n' +
  '  manageBtn.onclick = function() { showManageBookingForm(); };\n' +
  '  card.appendChild(manageBtn);\n' +
  '  messages.appendChild(card); messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  'function showAgencyWelcome() {\n' +
  '  var div = document.createElement("div"); div.className = "et-agency-welcome";\n' +
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
  '    var e = transcript[ri]; if (!e || !e.type) continue;\n' +
  '    if (e.type === "user" || e.type === "bot") { addMsg(e.text || "", e.type); }\n' +
  '    else if (e.type === "hotel_packages" && Array.isArray(e.packages)) { e.packages.forEach(function(p,i){addHotelPackage(p,i);}); }\n' +
  '    else if (e.type === "hotel_itinerary" && e.pkg) { addHotelItinerary(e.pkg); }\n' +
  '    else if (e.type === "packages" && Array.isArray(e.packages)) { e.packages.slice(0,4).forEach(function(p,i){addPackage(p,i);}); }\n' +
  '    else if (e.type === "itinerary" && e.pkg) { addItinerary(e.pkg); }\n' +
  '  }\n' +
  '  messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  'function addMsg(text, type) {\n' +
  '  var div = document.createElement("div"); div.className = "msg " + type;\n' +
  '  div.innerText = text; messages.appendChild(div); messages.scrollTop = messages.scrollHeight;\n' +
  '  return div;\n' +
  '}\n' +
  'function showTyping() {\n' +
  '  var div = document.createElement("div"); div.className = "typing"; div.id = "et-typing";\n' +
  '  div.innerHTML = "<span></span><span></span><span></span>";\n' +
  '  messages.appendChild(div); messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +
  'function hideTyping() { var t = document.getElementById("et-typing"); if (t) t.remove(); }\n' +
  'function scrollToEl(el) {\n' +
  '  if (!el) return;\n' +
  '  setTimeout(function() {\n' +
  '    var top = el.offsetTop - 12;\n' +
  '    messages.scrollTo({ top: top, behavior: "smooth" });\n' +
  '  }, 80);\n' +
  '}\n' +
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
  'function makeCancelBadge(policySummary, isRefundable) {\n' +
  '  var d = document.createElement("div"); var cls = "cancel-policy "; var icon;\n' +
  '  if (isRefundable === true)        { cls += "refundable";     icon = "\u2705"; }\n' +
  '  else if (isRefundable === false)  { cls += "non-refundable"; icon = "\u274C"; }\n' +
  '  else                              { cls += "neutral";        icon = "\u2139\uFE0F"; }\n' +
  '  d.className = cls;\n' +
  '  d.innerText = icon + "  " + (policySummary || "Cancellation policy confirmed at booking.");\n' +
  '  return d;\n' +
  '}\n' +
  'function makePriceMatchBadge(otaName, savingPerNight, currency) {\n' +
  '  var d = document.createElement("div"); d.className = "price-match-badge";\n' +
  '  var icon = document.createElement("div"); icon.className = "pm-icon"; icon.innerText = "\uD83C\uDFF7\uFE0F";\n' +
  '  var info = document.createElement("div");\n' +
  '  var label = document.createElement("div"); label.className = "pm-label"; label.innerText = "Best Rate Guaranteed";\n' +
  '  var detail = document.createElement("div"); detail.className = "pm-detail";\n' +
  '  detail.innerText = "Cheaper than " + (otaName || "OTA") + " \u00b7 Save " + (currency||"KES") + " " + Math.round(savingPerNight).toLocaleString() + "/night";\n' +
  '  info.appendChild(label); info.appendChild(detail);\n' +
  '  d.appendChild(icon); d.appendChild(info);\n' +
  '  return d;\n' +
  '}\n' +
  'function sortAncillariesByContext(ancillaries, prefs) {\n' +
  '  if (!prefs || !prefs.length) return ancillaries;\n' +
  '  var isRomantic = prefs.indexOf("honeymoon") !== -1;\n' +
  '  var isFamily   = prefs.indexOf("family") !== -1;\n' +
  '  var isSpa      = prefs.indexOf("spa") !== -1;\n' +
  '  var priority = [];\n' +
  '  if (isRomantic)    priority = ["spa","dining","upgrade","wellness","activity"];\n' +
  '  else if (isFamily) priority = ["activity","dining","transfer","upgrade"];\n' +
  '  else if (isSpa)    priority = ["spa","wellness","dining","upgrade"];\n' +
  '  else               priority = ["transfer","dining","spa","activity","upgrade","wellness"];\n' +
  '  return ancillaries.slice().sort(function(a,b){\n' +
  '    var ai=priority.indexOf(a.category); var bi=priority.indexOf(b.category);\n' +
  '    if(ai===-1)ai=99; if(bi===-1)bi=99; return ai-bi;\n' +
  '  });\n' +
  '}\n' +

  'function showManageBookingForm() {\n' +
  '  var ex = document.getElementById("et-manage-form"); if (ex) ex.remove();\n' +
  '  var card = document.createElement("div"); card.className = "manage-card"; card.id = "et-manage-form";\n' +
  '  var p = document.createElement("p"); p.innerText = "Enter your reservation reference and we\'ll pull up your booking."; card.appendChild(p);\n' +
  '  var ri = document.createElement("input"); ri.className = "name-input"; ri.placeholder = "Reservation reference (e.g. BDR-12345)"; ri.type = "text"; card.appendChild(ri);\n' +
  '  var pi = document.createElement("input"); pi.className = "name-input"; pi.placeholder = "Phone number used at booking"; pi.type = "tel"; card.appendChild(pi);\n' +
  '  var err = document.createElement("div"); err.style.cssText = "color:var(--et-red);font-size:11px;margin-bottom:8px;display:none;"; card.appendChild(err);\n' +
  '  var findBtn = document.createElement("button"); findBtn.className = "confirm-btn"; findBtn.innerText = "Find My Booking";\n' +
  '  findBtn.onclick = function() {\n' +
  '    err.style.display = "none";\n' +
  '    var ref = ri.value.trim(); var phone = pi.value.trim();\n' +
  '    if (!ref)   { err.innerText = "Please enter your reservation reference."; err.style.display = "block"; return; }\n' +
  '    if (!phone) { err.innerText = "Please enter the phone number used at booking."; err.style.display = "block"; return; }\n' +
  '    findBtn.innerText = "Looking up..."; findBtn.disabled = true;\n' +
  '    fetch("' + apiBase + '/api/hotel/reservation?ref=" + encodeURIComponent(ref) + "&phone=" + encodeURIComponent(phone), { headers: { "x-hotel-key": "' + agencyKey + '" } })\n' +
  '    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })\n' +
  '    .then(function(res) {\n' +
  '      if (!res.ok || !res.data.success) { err.innerText = (res.data && res.data.error) || "Booking not found."; err.style.display = "block"; findBtn.innerText = "Find My Booking"; findBtn.disabled = false; return; }\n' +
  '      card.remove(); showBookingDetails(res.data.reservation);\n' +
  '    })\n' +
  '    .catch(function() { err.innerText = "Network error. Please try again."; err.style.display = "block"; findBtn.innerText = "Find My Booking"; findBtn.disabled = false; });\n' +
  '  };\n' +
  '  card.appendChild(findBtn); messages.appendChild(card); messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  'function showBookingDetails(res) {\n' +
  '  var card = document.createElement("div"); card.className = "manage-card";\n' +
  '  var summary = ["\uD83C\uDFE8 "+(res.property_name||res.hotel_name||""),(res.room_type||"")+(res.meal_plan?" \u00b7 "+res.meal_plan.replace(/_/g," "):""),\n' +
  '    (res.check_in||"")+" \u2192 "+(res.check_out||""),"Ref: "+res.reservation_ref+" \u00b7 "+(res.status||"").toUpperCase()].filter(Boolean).join("\\n");\n' +
  '  var p = document.createElement("p"); p.style.whiteSpace = "pre-line"; p.innerText = summary; card.appendChild(p);\n' +
  '  var canModify = res.status === "confirmed" || res.status === "pending";\n' +
  '  var canCancel = res.status === "confirmed" || res.status === "pending";\n' +
  '  if (res.cancellation_policy) { card.appendChild(makeCancelBadge(res.cancellation_policy, res.is_refundable)); }\n' +
  '  var acts = document.createElement("div"); acts.className = "manage-actions"; acts.style.marginTop = "14px";\n' +
  '  if (canModify) { var modBtn = document.createElement("button"); modBtn.className = "manage-btn"; modBtn.innerText = "\u270F\uFE0F Modify"; modBtn.onclick = function() { showModifyForm(res); }; acts.appendChild(modBtn); }\n' +
  '  if (canCancel) { var canBtn = document.createElement("button"); canBtn.className = "manage-btn danger"; canBtn.innerText = "\u274C Cancel"; canBtn.onclick = function() { confirmCancellation(res, canBtn); }; acts.appendChild(canBtn); }\n' +
  '  if (!canModify && !canCancel) { var na = document.createElement("p"); na.style.cssText = "font-size:11px;color:var(--et-muted);margin:8px 0 0 0;"; na.innerText = "This reservation cannot be modified. Please contact us directly."; card.appendChild(na); }\n' +
  '  card.appendChild(acts); messages.appendChild(card); messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  'function showModifyForm(res) {\n' +
  '  var ex = document.getElementById("et-modify-form"); if (ex) ex.remove();\n' +
  '  var card = document.createElement("div"); card.className = "manage-card"; card.id = "et-modify-form";\n' +
  '  var p = document.createElement("p"); p.innerText = "Update your reservation dates:"; card.appendChild(p);\n' +
  '  var ciLabel = document.createElement("div"); ciLabel.className = "field-label"; ciLabel.innerText = "New check-in"; card.appendChild(ciLabel);\n' +
  '  var ci = document.createElement("input"); ci.className = "name-input"; ci.type = "date"; ci.value = res.check_in || ""; card.appendChild(ci);\n' +
  '  var coLabel = document.createElement("div"); coLabel.className = "field-label"; coLabel.innerText = "New check-out"; card.appendChild(coLabel);\n' +
  '  var co = document.createElement("input"); co.className = "name-input"; co.type = "date"; co.value = res.check_out || ""; card.appendChild(co);\n' +
  '  var ri = document.createElement("textarea"); ri.className = "name-input"; ri.placeholder = "Any special requests?"; ri.style.cssText = "height:56px;resize:none;"; card.appendChild(ri);\n' +
  '  var err = document.createElement("div"); err.style.cssText = "color:var(--et-red);font-size:11px;margin-bottom:8px;display:none;"; card.appendChild(err);\n' +
  '  var sb = document.createElement("button"); sb.className = "confirm-btn"; sb.innerText = "Request Modification";\n' +
  '  sb.onclick = function() {\n' +
  '    err.style.display = "none";\n' +
  '    if (!ci.value || !co.value) { err.innerText = "Please select both dates."; err.style.display = "block"; return; }\n' +
  '    if (new Date(co.value) <= new Date(ci.value)) { err.innerText = "Check-out must be after check-in."; err.style.display = "block"; return; }\n' +
  '    sb.innerText = "Submitting..."; sb.disabled = true;\n' +
  '    fetch("' + apiBase + '/api/hotel/reservation/modify", { method: "POST", headers: { "Content-Type": "application/json", "x-hotel-key": "' + agencyKey + '" }, body: JSON.stringify({ reservationRef: res.reservation_ref, newCheckIn: ci.value, newCheckOut: co.value, specialRequests: ri.value.trim() || null }) })\n' +
  '    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })\n' +
  '    .then(function(result) { card.remove(); addMsg(result.ok && result.data.success ? "\u2705 Modification request submitted for "+res.reservation_ref+". We\'ll confirm the updated dates shortly." : (result.data && result.data.error) || "Unable to modify. Please contact us directly.", "bot"); })\n' +
  '    .catch(function() { card.remove(); addMsg("Network error — please contact us directly.", "bot"); });\n' +
  '  };\n' +
  '  card.appendChild(sb); messages.appendChild(card); messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  'function confirmCancellation(res, btn) {\n' +
  '  var ex = document.getElementById("et-cancel-confirm"); if (ex) ex.remove();\n' +
  '  var card = document.createElement("div"); card.className = "manage-card"; card.id = "et-cancel-confirm"; card.style.borderColor = "var(--et-red)";\n' +
  '  var p = document.createElement("p"); p.innerHTML = "Are you sure you want to cancel <strong>" + res.reservation_ref + "</strong>?";\n' +
  '  if (res.cancellation_policy) { p.innerHTML += "<br><br>" + res.cancellation_policy; }\n' +
  '  card.appendChild(p);\n' +
  '  var acts = document.createElement("div"); acts.className = "manage-actions";\n' +
  '  var confirmBtn = document.createElement("button"); confirmBtn.className = "manage-btn danger"; confirmBtn.innerText = "Yes, Cancel Booking";\n' +
  '  var keepBtn    = document.createElement("button"); keepBtn.className    = "manage-btn";        keepBtn.innerText    = "Keep My Booking";\n' +
  '  keepBtn.onclick = function() { card.remove(); addMsg("No problem — your reservation "+res.reservation_ref+" is still active.", "bot"); };\n' +
  '  confirmBtn.onclick = function() {\n' +
  '    confirmBtn.innerText = "Cancelling..."; confirmBtn.disabled = true; keepBtn.disabled = true;\n' +
  '    fetch("' + apiBase + '/api/hotel/reservation/cancel", { method: "POST", headers: { "Content-Type": "application/json", "x-hotel-key": "' + agencyKey + '" }, body: JSON.stringify({ reservationRef: res.reservation_ref, groupSlug: "' + agencyKey + '" }) })\n' +
  '    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })\n' +
  '    .then(function(result) { card.remove(); addMsg(result.ok && result.data.success ? "\u2705 Reservation "+res.reservation_ref+" has been cancelled. "+(result.data.refundNote||"Any applicable refund will be processed within 5-7 business days.") : (result.data && result.data.error) || "We couldn\'t cancel online — please call us and quote "+res.reservation_ref+".", "bot"); })\n' +
  '    .catch(function() { card.remove(); addMsg("Network error — please contact us to cancel "+res.reservation_ref+".", "bot"); });\n' +
  '  };\n' +
  '  acts.appendChild(confirmBtn); acts.appendChild(keepBtn); card.appendChild(acts);\n' +
  '  messages.appendChild(card); messages.scrollTop = messages.scrollHeight;\n' +
  '}\n' +

  // ── HOTEL PACKAGE CARD ────────────────────────────────────────────────────
  'function addHotelPackage(p, idx) {\n' +
  '  var div = document.createElement("div"); div.className = "package";\n' +
  '  var hotel = p.hotel || {}; var summary = p.summary || {};\n' +
  '  var prefs = (previousParams && previousParams.preferences) || [];\n' +
  '  var ancillaries = sortAncillariesByContext(p.ancillaryServices || [], prefs);\n' +
  '  var currency = hotel.currency || summary.currency || "KES";\n' +
  '  var nights = hotel.nights || summary.nights || 1;\n' +
  '  var passengers = summary.passengers || 1;\n' +
  '  var baseTotal = hotel.totalRate || (hotel.pricePerNight * nights) || summary.totalPrice || 0;\n' +
  '  var currentTotal = baseTotal;\n' +
  '  var selectedAnc = [];\n' +
  '  var currentMealPlan = hotel.mealPlan || "bed_and_breakfast";\n' +
  '  var mealLabels = {room_only:"Room Only",bed_and_breakfast:"Bed & Breakfast",half_board:"Half Board",full_board:"Full Board",all_inclusive:"All Inclusive"};\n' +
  '  var pkgH = document.createElement("div"); pkgH.className = "pkg-header";\n' +
  '  var pt = document.createElement("span"); pt.className = "pkg-title"; pt.innerText = "Option "+(idx+1);\n' +
  '  var pr = document.createElement("span"); pr.className = "pkg-route"; pr.innerText = hotel.location||summary.route||"Room";\n' +
  '  pkgH.appendChild(pt); pkgH.appendChild(pr);\n' +
  '  var pkgB = document.createElement("div"); pkgB.className = "pkg-body";\n' +
  '  var images = hotel.images||[];\n' +
  '  if (images.length>0) { var img = document.createElement("img"); img.src=images[0]; img.alt=hotel.roomType||"Room"; img.style.cssText="width:100%;height:160px;object-fit:cover;border-radius:10px;margin-bottom:10px;display:block;"; img.onerror=function(){this.style.display="none";}; pkgB.appendChild(img); }\n' +
  // Price match badge — shown right at top if applied
  '  if (hotel.priceMatchApplied) { pkgB.appendChild(makePriceMatchBadge(hotel.priceMatchOta, hotel.priceMatchSaving, currency)); }\n' +
  '  var stars = hotel.stars?Array(Math.min(Math.round(hotel.stars),5)+1).join("\\u2605"):"";\n' +
  '  pkgB.appendChild(makeRow("Property",(hotel.propertyName||hotel.name||"TBC")+(stars?" "+stars:""),hotel.location||hotel.address||""));\n' +
  '  var roomSub=[]; if(hotel.bedType)roomSub.push(hotel.bedType); if(hotel.view)roomSub.push(hotel.view);\n' +
  '  pkgB.appendChild(makeRow("Room",hotel.roomType||"Standard Room",roomSub.join(" \u00b7 ")));\n' +
  '  pkgB.appendChild(makeRow("Dates",(hotel.checkIn||"")+" \u2192 "+(hotel.checkOut||""),nights+" night"+(nights!==1?"s":"")+" \u00b7 "+passengers+" guest(s)"));\n' +
  '  pkgB.appendChild(makeCancelBadge(hotel.policySummary, hotel.isRefundable));\n' +
  '  var avRates = hotel.availableRates||[];\n' +
  '  var mealRow = document.createElement("div"); mealRow.className = "pkg-row";\n' +
  '  var ml = document.createElement("div"); ml.className = "pkg-label"; ml.innerText = "Meal Plan"; mealRow.appendChild(ml);\n' +
  '  if (avRates.length>1) {\n' +
  '    var ms = document.createElement("select"); ms.style.cssText = "margin-top:4px;padding:7px 10px;border:1.5px solid var(--et-border);border-radius:8px;font-size:12px;color:#2A2A2A;background:var(--et-cream);width:100%;";\n' +
  '    avRates.forEach(function(r){ var o=document.createElement("option"); o.value=r.ratePlanId; o.setAttribute("data-price",r.pricePerNight); o.setAttribute("data-meal",r.mealPlan); o.selected=r.mealPlan===currentMealPlan; o.innerText=(mealLabels[r.mealPlan]||r.mealPlan)+" \u2014 "+currency+" "+Math.round(r.pricePerNight).toLocaleString()+"/night"; ms.appendChild(o); });\n' +
  '    ms.onchange=function(){ var o=ms.options[ms.selectedIndex]; currentMealPlan=o.getAttribute("data-meal"); hotel.ratePlanId=o.value; baseTotal=parseFloat(o.getAttribute("data-price"))*nights; currentTotal=baseTotal+selectedAnc.reduce(function(s,a){return s+(a.priceBasis==="per_person"?a.price*passengers:a.priceBasis==="per_night"?a.price*nights:a.price);},0); var el=document.getElementById("htl-total-"+idx); if(el)el.innerText=currency+" "+Math.round(currentTotal).toLocaleString(); };\n' +
  '    mealRow.appendChild(ms);\n' +
  '  } else { var md=document.createElement("div"); md.className="pkg-name"; md.innerText="\uD83C\uDF7D\uFE0F "+(mealLabels[currentMealPlan]||currentMealPlan); mealRow.appendChild(md); }\n' +
  '  pkgB.appendChild(mealRow);\n' +
  '  pkgB.appendChild(makeRow("Rate",currency+" "+Math.round(hotel.pricePerNight||0).toLocaleString()+"/night","\u00d7 "+nights+" night"+(nights!==1?"s":"")+" = "+currency+" "+Math.round(baseTotal).toLocaleString()));\n' +
  '  if(ancillaries.length>0){\n' +
  '    var aRow=document.createElement("div"); aRow.className="pkg-row"; var aLbl=document.createElement("div"); aLbl.className="pkg-label"; aLbl.innerText="Add-ons"; aRow.appendChild(aLbl);\n' +
  '    if(prefs.indexOf("honeymoon")!==-1||prefs.indexOf("romantic")!==-1){var nudge=document.createElement("div");nudge.style.cssText="font-size:11px;color:var(--et-gold);margin-bottom:6px;font-style:italic;";nudge.innerText="\u2728 Curated for a romantic stay";aRow.appendChild(nudge);}\n' +
  '    var catIcons={spa:"\uD83D\uDEC6",transfer:"\uD83D\uDE97",dining:"\uD83C\uDF7D\uFE0F",activity:"\uD83C\uDFC4",upgrade:"\u2B06\uFE0F",wellness:"\uD83E\uDDD8",other:"\u2728"};\n' +
  '    ancillaries.forEach(function(a){\n' +
  '      var ai=document.createElement("div"); ai.style.cssText="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--et-border);";\n' +
  '      var cb=document.createElement("input"); cb.type="checkbox"; cb.style.cssText="margin-top:3px;flex-shrink:0;accent-color:var(--et-navy);";\n' +
  '      var inf=document.createElement("div"); inf.style.flex="1";\n' +
  '      var an=document.createElement("div"); an.style.cssText="font-size:12px;font-weight:600;color:var(--et-navy);"; an.innerText=(catIcons[a.category]||"\u2728")+" "+a.name;\n' +
  '      var basis=a.priceBasis==="per_person"?"/person":a.priceBasis==="per_night"?"/night":"";\n' +
  '      var ap=document.createElement("div"); ap.style.cssText="font-size:11px;color:var(--et-muted);"; ap.innerText=currency+" "+Math.round(a.price).toLocaleString()+basis;\n' +
  '      if(a.description){var ad=document.createElement("div");ad.style.cssText="font-size:11px;color:var(--et-muted);margin-top:2px;";ad.innerText=a.description;inf.appendChild(ad);}\n' +
  '      inf.appendChild(an); inf.appendChild(ap); ai.appendChild(cb); ai.appendChild(inf); aRow.appendChild(ai);\n' +
  '      cb.onchange=function(){ if(cb.checked){selectedAnc.push(a);}else{selectedAnc=selectedAnc.filter(function(x){return x.id!==a.id;});} currentTotal=baseTotal+selectedAnc.reduce(function(s,x){return s+(x.priceBasis==="per_person"?x.price*passengers:x.priceBasis==="per_night"?x.price*nights:x.price);},0); var el=document.getElementById("htl-total-"+idx); if(el)el.innerText=currency+" "+Math.round(currentTotal).toLocaleString(); };\n' +
  '    }); pkgB.appendChild(aRow);\n' +
  '  }\n' +
  '  var pkgF=document.createElement("div"); pkgF.className="pkg-footer";\n' +
  '  var pd=document.createElement("div"); pd.className="pkg-price";\n' +
  '  var pm=document.createElement("span"); pm.id="htl-total-"+idx; pm.innerText=currency+" "+Math.round(baseTotal).toLocaleString();\n' +
  '  var ps=document.createElement("small"); ps.innerText=currency+" "+Math.round(hotel.pricePerNight||0).toLocaleString()+"/night";\n' +
  '  pd.appendChild(pm); pd.appendChild(ps);\n' +
  '  var bk=document.createElement("button"); bk.className="book"; bk.innerText="Reserve";\n' +
  '  bk.onclick=function(){var ep=JSON.parse(JSON.stringify(p));ep.hotel.mealPlan=currentMealPlan;ep.selectedAncillaries=selectedAnc;ep.summary.totalPrice=currentTotal;showHotelGuestForm(ep,bk);};\n' +
  '  pkgF.appendChild(pd); pkgF.appendChild(bk);\n' +
  '  div.appendChild(pkgH); div.appendChild(pkgB); div.appendChild(pkgF);\n' +
  '  messages.appendChild(div);\n' +
  '  return div;\n' +
  '}\n' +

  'function addHotelItinerary(p) {\n' +
  '  var div=document.createElement("div"); div.className="package";\n' +
  '  var summary=p.summary||{}; var legs=p.legs||{}; var currency=summary.currency||"KES";\n' +
  '  var pkgH=document.createElement("div"); pkgH.className="pkg-header";\n' +
  '  var pt=document.createElement("span"); pt.className="pkg-title"; pt.innerText="Your Itinerary";\n' +
  '  var pr=document.createElement("span"); pr.className="pkg-route"; pr.innerText=summary.route||"";\n' +
  '  pkgH.appendChild(pt); pkgH.appendChild(pr);\n' +
  '  var pkgB=document.createElement("div"); pkgB.className="pkg-body";\n' +
  '  legs.forEach(function(leg,i){\n' +
  '    var sd=document.createElement("div"); sd.className="itin-stop";\n' +
  '    var st=document.createElement("div"); st.className="itin-stop-title"; st.innerText="Stop "+(i+1)+": "+titleCase(leg.destination)+" ("+(leg.nights||1)+" night"+((leg.nights||1)===1?"":"s")+")"; sd.appendChild(st);\n' +
  '    if(leg.hotel){var h=leg.hotel;var stars=h.stars?Array(Math.min(Math.round(h.stars),5)+1).join("\\u2605"):"";var hl=document.createElement("div");hl.className="itin-line";hl.innerText="\uD83C\uDFE8 "+(h.propertyName||h.name||"TBC")+(stars?" "+stars:"")+(h.view?" \u00b7 "+h.view:"")+" \u00b7 "+fmtPrice(h.pricePerNight,h.currency)+"/night \u00d7 "+(leg.nights||1);sd.appendChild(hl);if(h.policySummary)sd.appendChild(makeCancelBadge(h.policySummary,h.isRefundable));}\n' +
  '    pkgB.appendChild(sd);\n' +
  '  });\n' +
  '  var pkgF=document.createElement("div"); pkgF.className="pkg-footer";\n' +
  '  var pd=document.createElement("div"); pd.className="pkg-price"; pd.innerText=fmtPrice(Math.round(summary.totalPrice||0),currency);\n' +
  '  var ps=document.createElement("small"); ps.innerText=fmtPrice(Math.round(summary.pricePerPerson||0),currency)+"/person"; pd.appendChild(ps);\n' +
  '  var bk=document.createElement("button"); bk.className="book"; bk.innerText="Reserve Itinerary";\n' +
  '  bk.onclick=function(){showHotelGuestForm(p,bk);};\n' +
  '  pkgF.appendChild(pd); pkgF.appendChild(bk);\n' +
  '  div.appendChild(pkgH); div.appendChild(pkgB); div.appendChild(pkgF);\n' +
  '  messages.appendChild(div); return div;\n' +
  '}\n' +

  'function showHotelGuestForm(p, bookBtn) {\n' +
  '  var ex=document.getElementById("et-hotel-form"); if(ex)ex.remove();\n' +
  '  var hotel=p.hotel||{}; var summary=p.summary||{};\n' +
  '  var currency=hotel.currency||summary.currency||"KES"; var total=summary.totalPrice||hotel.totalRate||0;\n' +
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
  '    err.style.display="none"; var name=ni.value.trim(); var phone=pi.value.trim();\n' +
  '    if(!name){err.innerText="Please enter your name.";err.style.display="block";return;}\n' +
  '    if(!phone){err.innerText="Please enter your phone number.";err.style.display="block";return;}\n' +
  '    cb.innerText="Processing..."; cb.disabled=true;\n' +
  '    fetch("' + apiBase + '/api/hotel/reserve",{method:"POST",headers:{"Content-Type":"application/json","x-hotel-key":"' + agencyKey + '"},body:JSON.stringify({groupSlug:"' + agencyKey + '",pkg:p,selectedAncillaries:p.selectedAncillaries||[],guestName:name,guestPhone:phone,guestEmail:ei.value.trim()||null,specialRequests:ri.value.trim()||null,channel:"widget"})})\n' +
  '    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})\n' +
  '    .then(function(res){\n' +
  '      if(!res.ok||!res.data.success){err.innerText=(res.data&&res.data.error)||"Reservation failed.";err.style.display="block";cb.innerText="Confirm Reservation";cb.disabled=false;return;}\n' +
  '      form.remove(); var ref=res.data.reservationRef;\n' +
  '      addMsg("\uD83C\uDFE8 Reservation "+ref+" confirmed. "+currency+" "+Math.round(total).toLocaleString()+" due.","bot");\n' +
  '      if(res.data.paymentType==="mpesa"||res.data.paymentType==="both"){\n' +
  '        fetch("' + apiBase + '/api/hotel/pay",{method:"POST",headers:{"Content-Type":"application/json","x-hotel-key":"' + agencyKey + '"},body:JSON.stringify({reservationRef:ref,guestPhone:phone})})\n' +
  '        .then(function(r){return r.json();})\n' +
  '        .then(function(pd){addMsg(pd.success?pd.message||"Check your phone to complete payment.":"Reservation confirmed as "+ref+". The hotel will contact you to arrange payment.","bot");messages.scrollTop=messages.scrollHeight;});\n' +
  '      } else { addMsg("Reservation "+ref+" confirmed. The hotel will contact you to arrange payment.","bot"); }\n' +
  '      if(bookBtn){bookBtn.innerText="Reserved \u2713";bookBtn.style.background="var(--et-green)";bookBtn.disabled=true;}\n' +
  '    })\n' +
  '    .catch(function(){err.innerText="Network error.";err.style.display="block";cb.innerText="Confirm Reservation";cb.disabled=false;});\n' +
  '  };\n' +
  '  form.appendChild(cb);\n' +
  '  var tb=document.createElement("div"); tb.className="trust-badge";\n' +
  '  tb.innerHTML="<svg viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"><path d=\\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\\"/><path d=\\"M9 12l2 2 4-4\\"/></svg> Secure booking";\n' +
  '  form.appendChild(tb); messages.appendChild(form); messages.scrollTop=messages.scrollHeight;\n' +
  '}\n' +

  'function pollBookingStatus(ref,btn){ var a=0,max=40,iv=setInterval(function(){ a++; fetch("' + apiBase + '/api/trips/booking/"+ref).then(function(r){return r.json();}).then(function(d){ if(d.bookingStage==="paid"){clearInterval(iv);btn.innerText="Paid & Confirmed!";btn.style.background="#27ae60";addMsg("Payment received! Booking "+ref+" confirmed. Your e-ticket will follow shortly.","bot");messages.scrollTop=messages.scrollHeight;} else if(d.bookingStage==="failed"||d.status==="cancelled"){clearInterval(iv);btn.innerText="Payment not received";btn.style.background="var(--et-red)";addMsg("We did not receive payment for booking "+ref+".","bot");messages.scrollTop=messages.scrollHeight;} else if(a>=max){clearInterval(iv);addMsg("Still waiting on payment for "+ref+".","bot");messages.scrollTop=messages.scrollHeight;} }).catch(function(){}); },5000); }\n' +

  'function continueToPayment(data,ctx,btn){ var ref=data.bookingRef,total=data.totalPrice,cur=data.currency; addMsg("Flight held! Ref: "+ref+". Total: "+cur+" "+total.toLocaleString()+". Sending M-Pesa prompt to "+ctx.phone+"...","bot"); messages.scrollTop=messages.scrollHeight; fetch("' + apiBase + '/api/trips/book-pay",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({bookingRef:ref,phone:ctx.phone,amount:total,currency:cur,email:ctx.email,firstName:ctx.passengers[0].firstName,lastName:ctx.passengers[0].lastName})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});}).then(function(pr){ if(!pr.ok||!pr.data.success){if(btn){btn.innerText="Payment failed";btn.style.background="var(--et-red)";}addMsg("Flight held but M-Pesa prompt failed. Contact support with ref "+ref+".","bot");return;} if(btn){btn.innerText="Awaiting payment...";btn.style.background="#f0ad4e";btn.disabled=true;} addMsg("Check your phone and enter your PIN. Ref: "+ref+".","bot"); messages.scrollTop=messages.scrollHeight; pollBookingStatus(ref,btn||{innerText:"",style:{}}); }); }\n' +

  'function showNameForm(p,bookBtn){ var ex=document.getElementById("et-name-form"); if(ex)ex.remove(); var pc=(p.summary&&p.summary.passengers)?p.summary.passengers:1; var needsFlight=!!(p.transport&&(p.transport.transportType||"flight")==="flight"); var offersSeat=!p.isMultiDestination&&!!(p.transport&&p.transport.supplier==="duffel"); var form=document.createElement("div"); form.className="name-form"; form.id="et-name-form"; var fp=document.createElement("p"); fp.innerText=needsFlight?"Enter passenger details to confirm:":"Enter your details to confirm:"; form.appendChild(fp); var pInputs=[]; var yr=new Date().getFullYear(); function buildDob(){ var row=document.createElement("div"); row.className="dob-row"; var d=document.createElement("select"); d.innerHTML="<option value=\\"\\">Day</option>"+Array.from({length:31},function(_,i){return"<option value=\\""+(i+1)+"\\">"+(i+1)+"</option>";}).join(""); var m=document.createElement("select"); m.innerHTML="<option value=\\"\\">Month</option>"+["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map(function(mn,i){return"<option value=\\""+(i+1)+"\\">"+mn+"</option>";}).join(""); var y=document.createElement("select"); y.innerHTML="<option value=\\"\\">Year</option>"+Array.from({length:100},function(_,i){return yr-i;}).map(function(yy){return"<option value=\\""+yy+"\\">"+yy+"</option>";}).join(""); row.appendChild(d);row.appendChild(m);row.appendChild(y);return{row:row,d:d,m:m,y:y}; } for(var pi=0;pi<pc;pi++){ var pb=document.createElement("div"); pb.style.cssText="margin-bottom:12px;padding-bottom:10px;border-bottom:"+(pi<pc-1?"1px solid var(--et-border)":"none")+";"; if(pc>1){var pl=document.createElement("div");pl.style.cssText="font-size:11px;font-weight:700;color:var(--et-navy);margin-bottom:6px;";pl.innerText="Traveler "+(pi+1);pb.appendChild(pl);} var fn=document.createElement("input");fn.className="name-input";fn.placeholder="First name";fn.type="text";pb.appendChild(fn); var ln=document.createElement("input");ln.className="name-input";ln.placeholder="Last name";ln.type="text";pb.appendChild(ln); var dl=document.createElement("div");dl.className="field-label";dl.innerText="Date of birth";pb.appendChild(dl); var dob=buildDob();pb.appendChild(dob.row); var gs=document.createElement("select");gs.className="name-input";gs.innerHTML="<option value=\\"male\\">Male</option><option value=\\"female\\">Female</option>";pb.appendChild(gs); var cl=document.createElement("label");cl.style.cssText="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--et-navy);margin-bottom:8px;"; var cc=document.createElement("input");cc.type="checkbox";cl.appendChild(cc);cl.appendChild(document.createTextNode("This traveler is a child"));pb.appendChild(cl); var idl=document.createElement("div");idl.className="field-label";idl.innerText="Passport or National ID";pb.appendChild(idl); var ii=document.createElement("input");ii.className="name-input";ii.placeholder="Passport / ID number";ii.type="text";pb.appendChild(ii); var ss=null; if(offersSeat){var sl=document.createElement("div");sl.className="field-label";sl.innerText="Seat preference (optional)";pb.appendChild(sl);ss=document.createElement("select");ss.className="name-input";ss.innerHTML="<option value=\\"\\">No preference</option><option value=\\"window\\">Window</option><option value=\\"aisle\\">Aisle</option><option value=\\"exit_row\\">Exit row</option>";pb.appendChild(ss);} pInputs.push({fn:fn,ln:ln,d:dob.d,m:dob.m,y:dob.y,gs:gs,cc:cc,ii:ii,ss:ss}); form.appendChild(pb); } var cl2=document.createElement("div");cl2.style.cssText="font-size:11px;font-weight:700;color:var(--et-navy);margin-bottom:6px;";cl2.innerText="Contact details";form.appendChild(cl2); var phi=document.createElement("input");phi.className="name-input";phi.placeholder="Phone (e.g. 0712345678)";phi.type="tel";form.appendChild(phi); var emi=document.createElement("input");emi.className="name-input";emi.placeholder="Email";emi.type="email";form.appendChild(emi); var em=document.createElement("div");em.style.cssText="color:var(--et-red);font-size:11px;margin-bottom:8px;display:none;";form.appendChild(em); var cfb=document.createElement("button");cfb.className="confirm-btn";cfb.innerText="Confirm Booking"; cfb.onclick=function(){ em.style.display="none"; var pax=[]; for(var k=0;k<pInputs.length;k++){ var pin=pInputs[k]; var f=pin.fn.value.trim(),l=pin.ln.value.trim(); if(!f||!l){em.innerText="Please fill in all traveler names.";em.style.display="block";return;} var dd=pin.d.value,mm=pin.m.value,yy=pin.y.value; if(!dd||!mm||!yy){em.innerText="Please select a date of birth for traveler "+(k+1)+".";em.style.display="block";return;} var dstr=yy+"-"+String(mm).padStart(2,"0")+"-"+String(dd).padStart(2,"0"); var isC=pin.cc.checked,idn=pin.ii.value.trim(); if(!isC&&!idn){em.innerText="Passport/ID required for traveler "+(k+1)+".";em.style.display="block";return;} pax.push({firstName:f,lastName:l,dateOfBirth:dstr,gender:pin.gs.value,type:isC?"child":"adult",idNumber:idn||null,seatPreference:(pin.ss&&pin.ss.value)?pin.ss.value:null}); } var phone=phi.value.trim(),email=emi.value.trim(); if(!phone){em.innerText="Phone number is required.";em.style.display="block";return;} if(needsFlight&&!email){em.innerText="Email is required for flight bookings.";em.style.display="block";return;} var gn=pax[0].firstName+" "+pax[0].lastName; var ctx={guestName:gn,phone:phone,email:email,passengers:pax,pkg:p}; cfb.innerText="Processing...";cfb.disabled=true; fetch("' + apiBase + '/api/trips/book-init",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agencyId:"' + agencyKey + '",guestName:gn,guestPhone:phone,guestEmail:email,passengers:pax,package:p})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});}).then(function(res){ if(!res.ok&&res.data&&res.data.code==="PRICE_CHANGED"){form.remove();showPriceAlert(res.data,ctx,bookBtn);return;} if(!res.ok||!res.data.success){em.innerText=(res.data&&res.data.error)||"Booking failed.";em.style.display="block";cfb.innerText="Confirm Booking";cfb.disabled=false;return;} form.remove();continueToPayment(res.data,ctx,bookBtn); }).catch(function(){em.innerText="Network error.";em.style.display="block";cfb.innerText="Confirm Booking";cfb.disabled=false;}); }; form.appendChild(cfb); var tb=document.createElement("div");tb.className="trust-badge"; tb.innerHTML="<svg viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"><path d=\\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\\"/><path d=\\"M9 12l2 2 4-4\\"/></svg> Secure payment via M-Pesa"; form.appendChild(tb); messages.appendChild(form);messages.scrollTop=messages.scrollHeight; }\n' +

  'function showPriceAlert(info,ctx,btn){ var ex=document.getElementById("et-price-alert");if(ex)ex.remove(); var d=document.createElement("div");d.className="price-alert";d.id="et-price-alert"; var p=document.createElement("p");p.innerHTML="The hotel price changed: <span style=\\"text-decoration:line-through;color:var(--et-muted);\\">"+fmtPrice(info.oldPrice,info.currency)+"</span> \u2192 <strong style=\\"color:var(--et-red);\\">"+(fmtPrice(info.newPrice,info.currency))+"</strong>"+(info.flightHeld?" Your flight is held and not yet charged.":""); d.appendChild(p); var acts=document.createElement("div");acts.className="price-alert-actions"; var ap=document.createElement("button");ap.className="price-approve";ap.innerText="Approve new price"; var ca=document.createElement("button");ca.className="price-cancel";ca.innerText="Cancel"; acts.appendChild(ap);acts.appendChild(ca);d.appendChild(acts);messages.appendChild(d);messages.scrollTop=messages.scrollHeight; ca.onclick=function(){d.remove();addMsg("Booking cancelled \u2014 no charge was made.","bot");}; ap.onclick=function(){ ap.disabled=true;ca.disabled=true;ap.innerText="Processing..."; fetch("' + apiBase + '/api/trips/book-init",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agencyId:"' + agencyKey + '",guestName:ctx.guestName,guestPhone:ctx.phone,guestEmail:ctx.email,passengers:ctx.passengers,package:ctx.pkg,priceApproved:true})}).then(function(r){return r.json().then(function(data){return{ok:r.ok,data:data};});}).then(function(res){d.remove();if(!res.ok||!res.data.success){addMsg((res.data&&res.data.error)||"Booking failed at the new price.","bot");return;}continueToPayment(res.data,ctx,btn);}).catch(function(){d.remove();addMsg("Network error.","bot");}); }; }\n' +

  'function addPackage(p,i){ var div=document.createElement("div");div.className="package"; var t=p.transport||null,rt=p.returnTransport||null,h=p.hotel||null,tr=p.transfers||null,s=p.summary||{}; var cur=s.currency||"KES",total=Math.round(s.totalPrice||0),ppp=Math.round(s.pricePerPerson||0),nights=s.nights||0,pax=s.passengers||1; var route=s.route||((t&&t.origin?t.origin:"TBC")+" to "+(t&&t.destination?t.destination:"TBC")); var ph=document.createElement("div");ph.className="pkg-header"; var pt=document.createElement("span");pt.className="pkg-title";pt.innerText="Option "+(i+1); var pr=document.createElement("span");pr.className="pkg-route";pr.innerText=route; ph.appendChild(pt);ph.appendChild(pr); var pb=document.createElement("div");pb.className="pkg-body"; if(t){ var isb=(t.transportType||"").toLowerCase()==="bus"; var sub=(t.origin||"TBC")+" \u2192 "+(t.destination||"TBC")+" \u00b7 "+fmtTime(t.departureTime)+" - "+fmtTime(t.arrivalTime); if(t.stops)sub+=" \u00b7 "+t.stops;if(t.cabinClass)sub+=" \u00b7 "+t.cabinClass; if(!isb&&t.baggageSummary)sub+=" \u00b7 "+t.baggageSummary;sub+=" \u00b7 "+fmtPrice(t.price,t.currency); pb.appendChild(makeRow(isb?"Outbound Bus":"Outbound Flight",t.airline||t.provider||"TBC",sub)); if(t.policySummary)pb.appendChild(makeHL(t.policySummary,t.isRefundable===true?"good":t.isRefundable===false?"warn":"neutral")); } if(rt){ var isrb=(rt.transportType||"").toLowerCase()==="bus"; var rsub=(rt.origin||"TBC")+" \u2192 "+(rt.destination||"TBC")+" \u00b7 "+fmtTime(rt.departureTime)+" - "+fmtTime(rt.arrivalTime); if(!isrb&&rt.baggageSummary)rsub+=" \u00b7 "+rt.baggageSummary;rsub+=" \u00b7 "+fmtPrice(rt.price,rt.currency); pb.appendChild(makeRow(isrb?"Return Bus":"Return Flight",rt.airline||rt.provider||"TBC",rsub)); if(rt.policySummary)pb.appendChild(makeHL(rt.policySummary,rt.isRefundable===true?"good":rt.isRefundable===false?"warn":"neutral")); } if(h){ var stars=h.stars?Array(Math.min(Math.round(h.stars),5)+1).join("\\u2605"):""; var hsub=(h.location||"TBC");if(nights>0)hsub+=" \u00b7 "+nights+" nights \u00b7 "+fmtPrice(h.pricePerNight,h.currency)+"/night"; if(h.images&&h.images.length>0){var hi=document.createElement("img");hi.src=h.images[0];hi.alt=h.name||"Hotel";hi.style.cssText="width:100%;height:140px;object-fit:cover;border-radius:10px;margin-bottom:8px;display:block;";hi.onerror=function(){this.style.display="none";};pb.appendChild(hi);} pb.appendChild(makeRow("Hotel",(h.name||"TBC")+(stars?" "+stars:""),hsub)); if(h.mealPlan)pb.appendChild(makeHL("\uD83C\uDF7D\uFE0F Board: "+h.mealPlan,"neutral")); pb.appendChild(makeHL(h.policySummary||(h.isRefundable===false?"\u26a0\uFE0F Non-refundable":"Refund terms confirmed at booking"),h.isRefundable===false?"warn":h.isRefundable===true||h.policySummary?"good":"neutral")); } var trl=Array.isArray(tr)?tr:(tr?[tr]:[]); if(trl.length>0){var tsub=trl.map(function(x){return(x.legType==="departure"?"Departure":x.legType==="arrival"?"Arrival":(x.provider||"Transfer"))+": "+(x.description||x.location||"TBC")+" ("+fmtPrice(x.price,x.currency)+")";}).join(" \u00b7 ");pb.appendChild(makeRow("Transfer",trl[0].provider||"Bodrless Transfer",tsub));} if(p.connectionAdvisory){var ar=document.createElement("div");ar.className="pkg-row";var al=document.createElement("div");al.className="pkg-label";al.innerText="\u26a0\uFE0F Before you book";var at=document.createElement("div");at.className="pkg-sub";at.innerText=p.connectionAdvisory;ar.appendChild(al);ar.appendChild(at);pb.appendChild(ar);} var pf=document.createElement("div");pf.className="pkg-footer"; var ppd=document.createElement("div");ppd.className="pkg-price";ppd.innerText=fmtPrice(total,cur); var pps=document.createElement("small");pps.innerText=fmtPrice(ppp,cur)+"/person \u00b7 "+pax+" traveller(s)";ppd.appendChild(pps); var bk=document.createElement("button");bk.className="book";bk.innerText="Book Now"; bk.onclick=function(){showNameForm(p,bk);}; pf.appendChild(ppd);pf.appendChild(bk); div.appendChild(ph);div.appendChild(pb);div.appendChild(pf); messages.appendChild(div); return div; }\n' +

  'function addItinerary(p){ var div=document.createElement("div");div.className="package"; var s=p.summary||{},legs=p.legs||[],cur=s.currency||"KES"; var ph=document.createElement("div");ph.className="pkg-header"; var pt=document.createElement("span");pt.className="pkg-title";pt.innerText="Your Itinerary"; var pr=document.createElement("span");pr.className="pkg-route";pr.innerText=s.route||""; ph.appendChild(pt);ph.appendChild(pr); var pb=document.createElement("div");pb.className="pkg-body"; legs.forEach(function(leg,idx){ var sd=document.createElement("div");sd.className="itin-stop"+(leg.isBufferLeg?" buffer":""); var st=document.createElement("div");st.className="itin-stop-title"; st.innerText=leg.isBufferLeg?"Connection: overnight in "+titleCase(leg.destination):"Stop "+(idx+1)+": "+titleCase(leg.destination)+" ("+leg.nights+" night"+(leg.nights===1?"":"s")+")"; sd.appendChild(st); var tr=leg.transportIn; if(tr){var isb=(tr.transportType||"").toLowerCase()==="bus";var tl=document.createElement("div");tl.className="itin-line";tl.innerText=(isb?"Bus: ":"Flight: ")+(tr.airline||tr.provider||"TBC")+" \u00b7 "+(tr.origin||"TBC")+" \u2192 "+(tr.destination||"TBC")+" \u00b7 "+fmtTime(tr.departureTime)+"-"+fmtTime(tr.arrivalTime)+" \u00b7 "+fmtPrice(tr.price,tr.currency);sd.appendChild(tl);} if(leg.hotel){var h=leg.hotel;var stars=h.stars?Array(Math.min(Math.round(h.stars),5)+1).join("\\u2605"):"";var hl=document.createElement("div");hl.className="itin-line";hl.innerText="Hotel: "+(h.name||"TBC")+(stars?" "+stars:"")+(h.location?" \u00b7 "+h.location:"")+" \u00b7 "+fmtPrice(h.pricePerNight,h.currency)+"/night \u00d7 "+leg.nights;sd.appendChild(hl);} pb.appendChild(sd); }); if(p.returnTransport){var rt=p.returnTransport;var isrb=(rt.transportType||"").toLowerCase()==="bus";var rd=document.createElement("div");rd.className="itin-stop";var rtl=document.createElement("div");rtl.className="itin-stop-title";rtl.innerText="Return";rd.appendChild(rtl);var rl=document.createElement("div");rl.className="itin-line";rl.innerText=(isrb?"Bus: ":"Flight: ")+(rt.origin||"TBC")+" \u2192 "+(rt.destination||"TBC")+" \u00b7 "+fmtTime(rt.departureTime)+"-"+fmtTime(rt.arrivalTime)+" \u00b7 "+fmtPrice(rt.price,rt.currency);rd.appendChild(rl);pb.appendChild(rd);} var pf=document.createElement("div");pf.className="pkg-footer"; var ppd=document.createElement("div");ppd.className="pkg-price";ppd.innerText=fmtPrice(Math.round(s.totalPrice||0),cur); var pps=document.createElement("small");pps.innerText=fmtPrice(Math.round(s.pricePerPerson||0),cur)+"/person \u00b7 "+(s.passengers||1)+" traveller(s)";ppd.appendChild(pps); var bk=document.createElement("button");bk.className="book";bk.innerText="Book Itinerary"; bk.onclick=function(){showNameForm(p,bk);}; pf.appendChild(ppd);pf.appendChild(bk); div.appendChild(ph);div.appendChild(pb);div.appendChild(pf); messages.appendChild(div); return div; }\n' +

  // ── SEND — with scroll-to-first-result fix ────────────────────────────────
  'function send(){\n' +
  '  var text=input.value.trim(); if(!text)return;\n' +
  '  if(isHotelMode){\n' +
  '    var lower=text.toLowerCase();\n' +
  '    if(/\\b(?:cancel|modify|change|update|manage|view)\\b/.test(lower)&&/\\b(?:booking|reservation|stay|ref|reference)\\b/.test(lower)){\n' +
  '      addMsg(text,"user"); transcript.push({type:"user",text:text}); persistState(); input.value="";\n' +
  '      addMsg("Of course — let me pull up your reservation. Please provide your booking reference and the phone number you used.","bot");\n' +
  '      showManageBookingForm(); return;\n' +
  '    }\n' +
  '  }\n' +
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
  // No packages — show bot text
  '    if(!pkgs.length){\n' +
  '      var nt=(data&&data.text)?data.text:"No rooms available for those dates. Try adjusting your dates or tell me more about what you\'re looking for.";\n' +
  '      addMsg(nt,"bot"); transcript.push({type:"bot",text:nt}); persistState(); return;\n' +
  '    }\n' +
  // Bot reply text — use engine's replyText directly (Claude wrote it)
  '    var rm = data.text || (isHD ? "Here\'s what we have available:" : (isIt ? "Here is your itinerary:" : "I found "+pkgs.length+" option(s) for you:"));\n' +
  '    var botMsg = addMsg(rm,"bot"); transcript.push({type:"bot",text:rm});\n' +
  // Render packages and track the FIRST card for scroll
  '    var firstCard = null;\n' +
  '    if(isHD&&isIt){ firstCard=addHotelItinerary(pkgs[0]); transcript.push({type:"hotel_itinerary",pkg:pkgs[0]}); }\n' +
  '    else if(isHD){ pkgs.forEach(function(p,i){ var card=addHotelPackage(p,i); if(i===0)firstCard=card; }); transcript.push({type:"hotel_packages",packages:pkgs}); }\n' +
  '    else if(isIt){ firstCard=addItinerary(pkgs[0]); transcript.push({type:"itinerary",pkg:pkgs[0]}); }\n' +
  '    else{ pkgs.slice(0,4).forEach(function(p,i){ var card=addPackage(p,i); if(i===0)firstCard=card; }); transcript.push({type:"packages",packages:pkgs.slice(0,4)}); }\n' +
  // ── KEY SCROLL FIX: scroll to bot message (just above first card) ──────
  '    scrollToEl(botMsg);\n' +
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