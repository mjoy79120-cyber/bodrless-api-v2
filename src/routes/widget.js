const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  const agencyKey  = req.query.key  || 'epic-travels';
  const agencyName = req.query.name || 'Epic Travels';
  const apiBase    = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';
  const isHotelDirect = req.query.mode === 'hotel_direct';
  const embedTarget   = req.query.embed || null; // container id for embedded mode

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  // ─── HOTEL DIRECT PALETTE (Sarova brand) ─────────────────────
  // Forest green #114B43, ivory #F8F5EE, gold #C9A84C, warm white #FFFFFF
  // ─────────────────────────────────────────────────────────────
  const HOTEL_CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Inter:wght@300;400;500;600&display=swap');
    :root {
      --h-green:   #114B43;
      --h-green2:  #1a6b5e;
      --h-gold:    #C9A84C;
      --h-gold2:   #e8c97a;
      --h-ivory:   #F8F5EE;
      --h-ivory2:  #EDE9DF;
      --h-cream:   #FDFCF9;
      --h-text:    #1a1a1a;
      --h-muted:   #6b6460;
      --h-border:  #ddd8cc;
    }
    #bodrless-chat.hotel-mode {
      font-family: 'Inter', sans-serif !important;
      background: var(--h-cream) !important;
      border: none !important;
      box-shadow: 0 24px 80px rgba(17,75,67,0.18) !important;
      border-radius: 20px !important;
    }
    .hotel-mode #et-header {
      background: var(--h-green) !important;
      border-bottom: 2px solid var(--h-gold) !important;
    }
    .hotel-mode #et-header-text h3 { color: #fff !important; font-family: 'Cormorant Garamond', serif !important; font-size: 17px !important; letter-spacing: 1px !important; }
    .hotel-mode #et-header-text h3 span { color: var(--h-gold) !important; }
    .hotel-mode #et-header-text p { color: rgba(255,255,255,0.55) !important; letter-spacing: 2px !important; }
    .hotel-mode #et-close { background: rgba(255,255,255,0.1) !important; }
    .hotel-mode #bodrless-messages { background: var(--h-cream) !important; }
    .hotel-mode .msg.bot {
      background: #fff !important;
      border: 1px solid var(--h-border) !important;
      color: var(--h-text) !important;
      border-radius: 4px 16px 16px 16px !important;
      font-size: 13px !important;
      line-height: 1.65 !important;
    }
    .hotel-mode .msg.user {
      background: var(--h-green) !important;
      color: #fff !important;
      border: none !important;
      border-radius: 16px 4px 16px 16px !important;
    }
    .hotel-mode .typing { background: #fff !important; border: 1px solid var(--h-border) !important; }
    .hotel-mode .typing span { background: var(--h-green) !important; }
    .hotel-mode .typing span:nth-child(2) { background: var(--h-gold) !important; }
    .hotel-mode #bodrless-input-area { background: #fff !important; border-top: 1px solid var(--h-border) !important; }
    .hotel-mode #bodrless-input { background: var(--h-ivory) !important; border: 1.5px solid var(--h-border) !important; color: var(--h-text) !important; }
    .hotel-mode #bodrless-input:focus { border-color: var(--h-green) !important; }
    .hotel-mode #bodrless-input::placeholder { color: var(--h-muted) !important; }
    .hotel-mode #bodrless-send { background: var(--h-green) !important; border: none !important; }
    .hotel-mode #bodrless-send:hover { background: var(--h-green2) !important; }
    .hotel-mode .et-welcome {
      background: var(--h-green) !important;
      border-left: 3px solid var(--h-gold) !important;
      border-radius: 16px !important;
    }
    .hotel-mode .et-welcome h4 { font-family: 'Cormorant Garamond', serif !important; font-size: 18px !important; font-weight: 500 !important; letter-spacing: 0.5px !important; }
    .hotel-mode .et-suggestion {
      background: rgba(255,255,255,0.08) !important;
      border: 1px solid rgba(201,168,76,0.4) !important;
      color: rgba(255,255,255,0.85) !important;
      border-radius: 20px !important;
      font-size: 11px !important;
      padding: 5px 12px !important;
      cursor: pointer !important;
    }
    .hotel-mode .et-suggestion:hover { background: rgba(201,168,76,0.2) !important; }
    .hotel-mode .package {
      background: #fff !important;
      border: 1px solid var(--h-border) !important;
      box-shadow: 0 4px 20px rgba(17,75,67,0.08) !important;
      border-radius: 16px !important;
    }
    .hotel-mode .pkg-header { background: var(--h-green) !important; border-radius: 15px 15px 0 0 !important; }
    .hotel-mode .pkg-title { font-family: 'Cormorant Garamond', serif !important; font-size: 15px !important; font-weight: 500 !important; letter-spacing: 0.5px !important; }
    .hotel-mode .pkg-route { background: var(--h-gold) !important; color: #2a1f00 !important; }
    .hotel-mode .pkg-label { color: var(--h-green) !important; }
    .hotel-mode .pkg-name { color: var(--h-text) !important; font-family: 'Cormorant Garamond', serif !important; font-size: 15px !important; }
    .hotel-mode .pkg-sub { color: var(--h-muted) !important; }
    .hotel-mode .pkg-row { border-bottom-color: var(--h-border) !important; }
    .hotel-mode .pkg-footer { background: var(--h-ivory) !important; border-top-color: var(--h-border) !important; border-radius: 0 0 15px 15px !important; }
    .hotel-mode .pkg-price { color: var(--h-green) !important; }
    .hotel-mode .pkg-price small { color: var(--h-muted) !important; }
    .hotel-mode .book { background: var(--h-green) !important; color: #fff !important; font-family: 'Inter', sans-serif !important; letter-spacing: 0.5px !important; }
    .hotel-mode .book:hover { background: var(--h-green2) !important; }
    .hotel-mode .name-form { background: var(--h-ivory) !important; border: 1px solid var(--h-border) !important; border-radius: 16px !important; }
    .hotel-mode .name-input { background: #fff !important; border: 1.5px solid var(--h-border) !important; color: var(--h-text) !important; }
    .hotel-mode .name-input:focus { border-color: var(--h-green) !important; outline: none !important; }
    .hotel-mode .confirm-btn { background: var(--h-green) !important; }
    .hotel-mode .confirm-btn:hover { background: var(--h-green2) !important; }
    .hotel-mode .trust-badge { color: var(--h-muted) !important; }
    .hotel-mode .h-addon-chip {
      display: inline-flex; align-items: center; gap: 5px;
      background: var(--h-ivory); border: 1px solid var(--h-border);
      color: var(--h-muted); font-size: 10px; border-radius: 20px;
      padding: 4px 10px; cursor: pointer; transition: all 0.2s; margin: 3px 3px 3px 0;
    }
    .hotel-mode .h-addon-chip.on { background: rgba(17,75,67,0.08); border-color: var(--h-green); color: var(--h-green); }
    .hotel-mode .h-manage-bar { background: var(--h-ivory); border: 1px solid var(--h-border); border-radius: 14px; padding: 12px 14px; margin-top: 4px; }
    .hotel-mode .h-manage-title { font-size: 10px; color: var(--h-gold); letter-spacing: 2px; text-transform: uppercase; margin-bottom: 10px; font-weight: 600; }
    .hotel-mode .h-manage-btn {
      background: #fff; border: 1px solid var(--h-border); border-radius: 8px;
      padding: 7px 12px; font-size: 11px; color: var(--h-muted); cursor: pointer;
      transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px;
      margin: 3px; font-family: 'Inter', sans-serif;
    }
    .hotel-mode .h-manage-btn:hover { border-color: var(--h-green); color: var(--h-green); background: var(--h-ivory); }
    .hotel-mode .h-policy-strip { font-size: 11px; padding: 7px 10px; border-radius: 8px; margin-top: 6px; display: flex; align-items: flex-start; gap: 6px; line-height: 1.5; }
    .hotel-mode .h-policy-green { background: #edf7ed; color: #2d6a2d; border: 1px solid #b8dcb8; }
    .hotel-mode .h-policy-amber { background: #fff8e6; color: #7a5c00; border: 1px solid #f0d88a; }
    .hotel-mode .h-meal-select { width: 100%; padding: 8px 10px; border: 1.5px solid var(--h-border); border-radius: 8px; font-size: 12px; color: var(--h-text); background: #fff; margin-top: 4px; }
    .hotel-mode .h-room-img { width: 100%; height: 150px; object-fit: cover; border-radius: 10px; margin-bottom: 10px; display: block; }
    .hotel-mode .h-stars { color: var(--h-gold); font-size: 11px; letter-spacing: 2px; }
    .hotel-mode .h-divider { text-align: center; font-size: 10px; color: var(--h-muted); letter-spacing: 2px; text-transform: uppercase; padding: 6px 0 10px; }
  `;

  const code = `(function(){
function initWidget(){
  if(!document.body){setTimeout(initWidget,50);return;}
  if(document.getElementById('bodrless-widget-root'))return;

  var IS_HOTEL = ${isHotelDirect ? 'true' : 'false'};
  var EMBED_TARGET = ${embedTarget ? `'${embedTarget}'` : 'null'};
  var conversationHistory=[], previousParams=null, sessionId=null;
  var STORAGE_KEY='bodrless_${agencyKey}';
  var transcript=[], hasRestored=false;

  function save(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify({v:1,savedAt:Date.now(),transcript:transcript.slice(-20),conversationHistory,previousParams,sessionId}));}catch(e){}}
  function load(){try{var r=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');if(!r||r.v!==1||(Date.now()-r.savedAt)>86400000)return null;return r;}catch(e){return null;}}
  var _r=load();
  if(_r){conversationHistory=_r.conversationHistory||[];previousParams=_r.previousParams||null;sessionId=_r.sessionId||null;transcript=_r.transcript||[];hasRestored=transcript.length>0;}

  /* ── HOTEL CSS inject ── */
  if(IS_HOTEL){
    var hStyle=document.createElement('style');
    hStyle.innerHTML=${JSON.stringify(HOTEL_CSS)};
    document.head.appendChild(hStyle);
  }

  /* ── Agency CSS ── */
  var style=document.createElement('style');
  style.innerHTML=[
    ':root{--et-navy:#1E2A5E;--et-red:#C0392B;--et-white:#FFFFFF;--et-cream:#F8F9FC;--et-border:#E4E8F0;--et-muted:#8892A4;--et-green:#27ae60;}',
    '#bodrless-chat{position:fixed;bottom:90px;right:24px;width:390px;height:630px;background:var(--et-cream);z-index:999999;display:none;flex-direction:column;border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(30,42,94,0.18);font-family:Arial,sans-serif;}',
    '#bodrless-chat.embedded{position:relative;bottom:auto;right:auto;width:100%;height:620px;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.1);}',
    '#bodrless-chat.open{display:flex;}',
    '@keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:0.6;}30%{transform:translateY(-6px);opacity:1;}}',
    '#et-header{background:var(--et-navy);padding:14px 18px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;border-bottom:3px solid var(--et-red);}',
    '#et-header-left{display:flex;align-items:center;gap:12px;}',
    '#et-logo-wrap{width:42px;height:42px;background:rgba(255,255,255,0.15);border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;color:white;font-weight:700;font-size:18px;}',
    '#et-header-text h3{font-size:15px;color:white;margin:0 0 2px 0;}',
    '#et-header-text h3 span{color:var(--et-red);}',
    '#et-header-text p{font-size:10px;color:rgba(255,255,255,0.6);margin:0;letter-spacing:0.8px;text-transform:uppercase;}',
    '#et-close{background:rgba(255,255,255,0.1);border:none;color:white;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:13px;}',
    '#bodrless-messages{flex:1;padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;}',
    '.msg{padding:10px 14px;border-radius:14px;max-width:85%;font-size:13px;line-height:1.5;}',
    '.user{background:var(--et-navy);color:white;margin-left:auto;border-bottom-right-radius:4px;}',
    '.bot{background:var(--et-white);color:var(--et-navy);border:1px solid var(--et-border);border-bottom-left-radius:4px;}',
    '.typing{background:var(--et-white);border:1px solid var(--et-border);padding:12px 16px;border-radius:14px;display:flex;gap:5px;align-items:center;width:fit-content;}',
    '.typing span{width:7px;height:7px;background:var(--et-navy);border-radius:50%;animation:bounce 1.2s infinite;}',
    '.typing span:nth-child(2){animation-delay:0.2s;background:var(--et-red);}',
    '.typing span:nth-child(3){animation-delay:0.4s;}',
    '.et-welcome{background:linear-gradient(135deg,#1E2A5E 0%,#2d3f82 100%);border-radius:16px;padding:16px;color:white;border-left:4px solid #C0392B;}',
    '.et-welcome h4{font-size:14px;margin:0 0 6px 0;}',
    '.et-welcome p{font-size:12px;margin:0 0 12px 0;color:rgba(255,255,255,0.7);line-height:1.5;}',
    '.et-suggestions{display:flex;flex-wrap:wrap;gap:6px;}',
    '.et-suggestion{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.9);padding:5px 10px;border-radius:20px;font-size:11px;cursor:pointer;}',
    '.package{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;overflow:visible;height:auto;box-shadow:0 2px 10px rgba(30,42,94,0.07);margin-bottom:8px;}',
    '.pkg-header{background:var(--et-navy);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-radius:14px 14px 0 0;}',
    '.pkg-title{color:white;font-size:13px;font-weight:600;}',
    '.pkg-route{background:var(--et-red);color:white;font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.pkg-body{padding:12px 14px;display:flex;flex-direction:column;height:auto;}',
    '.pkg-row{display:flex;flex-direction:column;padding:8px 0;border-bottom:1px dashed var(--et-border);}',
    '.pkg-row:last-child{border-bottom:none;}',
    '.pkg-label{font-size:10px;font-weight:700;color:var(--et-red);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;}',
    '.pkg-name{font-size:13px;font-weight:600;color:var(--et-navy);margin-bottom:2px;}',
    '.pkg-sub{font-size:11px;color:var(--et-muted);line-height:1.4;}',
    '.pkg-footer{padding:10px 14px;background:var(--et-cream);display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--et-border);height:auto;border-radius:0 0 14px 14px;}',
    '.pkg-price{font-size:20px;font-weight:700;color:var(--et-navy);line-height:1;}',
    '.pkg-price small{font-size:10px;color:var(--et-muted);display:block;font-weight:400;margin-top:2px;}',
    '.book{background:var(--et-red);color:white;border:none;padding:9px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;}',
    '.book:disabled{opacity:0.7;cursor:not-allowed;}',
    '#bodrless-input-area{display:flex;border-top:1px solid var(--et-border);background:var(--et-white);padding:10px 12px;gap:8px;flex-shrink:0;}',
    '#bodrless-input{flex:1;padding:10px 14px;border:1.5px solid var(--et-border);border-radius:20px;outline:none;font-size:13px;background:var(--et-cream);color:var(--et-navy);}',
    '#bodrless-input:focus{border-color:var(--et-navy);}',
    '#bodrless-input::placeholder{color:var(--et-muted);font-size:12px;}',
    '#bodrless-send{background:var(--et-navy);color:white;border:none;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '#bodrless-trigger{display:none !important;}',
    '.name-form{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;padding:14px;margin-top:8px;}',
    '.name-form p{font-size:12px;color:var(--et-navy);margin:0 0 10px 0;font-weight:500;}',
    '.name-input{width:100%;padding:9px 12px;border:1.5px solid var(--et-border);border-radius:10px;outline:none;font-size:12px;color:var(--et-navy);box-sizing:border-box;margin-bottom:10px;}',
    '.dob-row{display:flex;gap:6px;margin-bottom:10px;}',
    '.dob-row select{flex:1;padding:9px 4px;border:1.5px solid var(--et-border);border-radius:10px;outline:none;font-size:12px;color:var(--et-navy);box-sizing:border-box;background:white;}',
    '.field-label{font-size:10px;color:var(--et-muted);margin-bottom:4px;font-weight:600;}',
    '.confirm-btn{background:var(--et-navy);color:white;border:none;padding:9px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;width:100%;}',
    '.trust-badge{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:10px;font-size:10px;color:var(--et-muted);}',
    '.trust-badge svg{width:13px;height:13px;flex-shrink:0;}',
    '.price-alert{background:#FFF7E6;border:1px solid #F0C36D;border-radius:12px;padding:12px;margin-top:8px;}',
    '.price-alert p{font-size:12px;color:#5A4A1A;margin:0 0 10px 0;line-height:1.5;}',
    '.price-alert .old{text-decoration:line-through;color:var(--et-muted);}',
    '.price-alert .new{color:var(--et-red);font-weight:700;}',
    '.price-alert-actions{display:flex;gap:8px;}',
    '.price-approve{flex:1;background:var(--et-navy);color:white;border:none;padding:9px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;}',
    '.price-cancel{flex:1;background:white;color:var(--et-navy);border:1.5px solid var(--et-border);padding:9px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;}'
  ].join('');
  document.head.appendChild(style);

  /* ── DOM BUILD ── */
  var root=document.createElement('div');root.id='bodrless-widget-root';
  var chatDiv=document.createElement('div');chatDiv.id='bodrless-chat';
  if(IS_HOTEL) chatDiv.classList.add('hotel-mode');

  var header=document.createElement('div');header.id='et-header';
  var hLeft=document.createElement('div');hLeft.id='et-header-left';
  var logoWrap=document.createElement('div');logoWrap.id='et-logo-wrap';
  logoWrap.innerText='${agencyName.charAt(0).toUpperCase()}';
  var hText=document.createElement('div');hText.id='et-header-text';
  hText.innerHTML='<h3><span>${agencyName}</span></h3><p>${isHotelDirect ? 'Private Concierge' : 'Premium Travel'}</p>';
  var closeBtn=document.createElement('button');closeBtn.id='et-close';closeBtn.innerText='✕';
  hLeft.appendChild(logoWrap);hLeft.appendChild(hText);
  header.appendChild(hLeft);header.appendChild(closeBtn);

  var messages=document.createElement('div');messages.id='bodrless-messages';
  var inputArea=document.createElement('div');inputArea.id='bodrless-input-area';
  var input=document.createElement('input');input.id='bodrless-input';
  input.placeholder=IS_HOTEL?'Tell me how you\\'d like to stay…':'Where would you like to go?';
  var sendBtn=document.createElement('button');sendBtn.id='bodrless-send';sendBtn.innerHTML='&#9658;';
  inputArea.appendChild(input);inputArea.appendChild(sendBtn);
  chatDiv.appendChild(header);chatDiv.appendChild(messages);chatDiv.appendChild(inputArea);
  root.appendChild(chatDiv);
  document.body.appendChild(root);

  /* ── EMBED or FLOATING ── */
  if(EMBED_TARGET){
    chatDiv.classList.add('embedded','open');
    var mountEl=document.getElementById(EMBED_TARGET);
    if(mountEl){mountEl.appendChild(chatDiv);}else{document.body.appendChild(chatDiv);}
  } else {
    var triggerBtn=document.createElement('button');
    triggerBtn.id='bodrless-trigger';
    triggerBtn.innerText=IS_HOTEL?'Book a Room':'Plan Your Trip';
    document.body.appendChild(triggerBtn);
    var welcomeShown=false;
    triggerBtn.onclick=function(){chatDiv.classList.add('open');input.focus();if(!welcomeShown){welcomeShown=true;if(hasRestored){replayTranscript();}else{showWelcome();}}};
    closeBtn.onclick=function(){chatDiv.classList.remove('open');};
  }

  if(EMBED_TARGET && !hasRestored){showWelcome();}
  else if(EMBED_TARGET && hasRestored){replayTranscript();}

  /* ── WELCOME ── */
  function showWelcome(){
    var div=document.createElement('div');div.className='et-welcome';
    var h4=document.createElement('h4');
    var p=document.createElement('p');
    var sd=document.createElement('div');sd.className='et-suggestions';
    if(IS_HOTEL){
      h4.innerHTML='Welcome to ${agencyName} &mdash; I\\'m your personal concierge.';
      p.innerText='Tell me what you\\'re looking for and I\\'ll take care of the rest.';
      var starters=window.bodrlessStarters||[
        {text:'Book me a room for two this weekend, all inclusive'},
        {text:'Honeymoon suite with spa package'},
        {text:'Family room for 4 nights, full board'},
        {text:'What\\'s your best suite available?'}
      ];
      starters.slice(0,3).forEach(function(s){
        var btn=document.createElement('span');btn.className='et-suggestion';
        btn.innerText=s.text;
        btn.onclick=function(){input.value=s.text;send();};
        sd.appendChild(btn);
      });
    } else {
      h4.innerText='Welcome to ${agencyName}';
      p.innerText='Tell me your dream destination and I will find the perfect package.';
      ['Nairobi to Zanzibar','Cape Town 5 nights','Masai Mara Safari'].forEach(function(s){
        var btn=document.createElement('span');btn.className='et-suggestion';
        btn.innerText=s;btn.onclick=function(){input.value=s;send();};
        sd.appendChild(btn);
      });
    }
    div.appendChild(h4);div.appendChild(p);div.appendChild(sd);
    messages.appendChild(div);
  }

  /* ── REPLAY ── */
  function replayTranscript(){
    var note=document.createElement('div');note.className='msg bot';
    note.style.fontStyle='italic';note.style.opacity='0.6';
    note.innerText='\\u2014 Continuing your session \\u2014';
    messages.appendChild(note);
    transcript.forEach(function(e){
      if(!e||!e.type)return;
      if(e.type==='user'||e.type==='bot'){addMsg(e.text||'',e.type);}
      else if(e.type==='hotel_packages'&&Array.isArray(e.packages)){e.packages.forEach(function(p,i){addHotelPackage(p,i);});}
      else if(e.type==='hotel_itinerary'&&e.pkg){addHotelItinerary(e.pkg);}
      else if(e.type==='packages'&&Array.isArray(e.packages)){e.packages.forEach(function(p,i){addPackage(p,i);});}
      else if(e.type==='itinerary'&&e.pkg){addItinerary(e.pkg);}
    });
    messages.scrollTop=messages.scrollHeight;
  }

  /* ── HELPERS ── */
  function addMsg(text,type){var d=document.createElement('div');d.className='msg '+type;d.innerText=text;messages.appendChild(d);messages.scrollTop=messages.scrollHeight;}
  function showTyping(){var d=document.createElement('div');d.className='typing';d.id='et-typing';d.innerHTML='<span></span><span></span><span></span>';messages.appendChild(d);messages.scrollTop=messages.scrollHeight;}
  function hideTyping(){var t=document.getElementById('et-typing');if(t)t.remove();}
  function fmtTime(iso){if(!iso)return'TBC';try{var d=new Date(iso);if(isNaN(d))return iso;return d.toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'});}catch(e){return iso;}}
  function fmtPrice(n,cur){return(cur||'KES')+' '+(Math.round(Number(n)||0)).toLocaleString();}
  function titleCase(str){if(!str)return'';return String(str).replace(/\\b\\w/g,function(c){return c.toUpperCase();});}
  function makeRow(label,name,sub){var row=document.createElement('div');row.className='pkg-row';var lEl=document.createElement('div');lEl.className='pkg-label';lEl.innerText=label;var nEl=document.createElement('div');nEl.className='pkg-name';nEl.innerText=name;var sEl=document.createElement('div');sEl.className='pkg-sub';sEl.innerText=sub;row.appendChild(lEl);row.appendChild(nEl);row.appendChild(sEl);return row;}
  function makeHighlight(text,tone){var d=document.createElement('div');var bg=tone==='good'?'#E8F8EE':tone==='warn'?'#FFF3E0':'#EEF1F8';var fg=tone==='good'?'#1B7A3D':tone==='warn'?'#B05A00':'#3A4A7A';d.style.cssText='background:'+bg+';color:'+fg+';padding:7px 10px;border-radius:8px;font-size:11px;font-weight:700;margin-top:6px;';d.innerText=text;return d;}

  /* ══════════════════════════════════════════
     HOTEL DIRECT — ROOM CARD
     Sarova palette, concierge voice, smart add-ons
  ══════════════════════════════════════════ */
  function addHotelPackage(p,i){
    var hotel=p.hotel||{}, summary=p.summary||{}, ancs=p.ancillaryServices||[];
    var currency=hotel.currency||summary.currency||'KES';
    var nights=hotel.nights||summary.nights||1;
    var passengers=summary.passengers||1;
    var baseTotal=hotel.totalRate||(hotel.pricePerNight*nights)||summary.totalPrice||0;
    var currentTotal=baseTotal;
    var selectedAncs=[];
    var isHoneymoon=hotel.mealPlan==='honeymoon'||(p.preferences||[]).includes('honeymoon')||(hotel.roomType||'').toLowerCase().includes('suite');

    var div=document.createElement('div');div.className='package';
    if(isHoneymoon) div.style.borderColor='#e8b4b4';

    var pkgHeader=document.createElement('div');pkgHeader.className='pkg-header';
    var pkgTitle=document.createElement('span');pkgTitle.className='pkg-title';
    pkgTitle.innerText='Option '+(i+1)+(isHoneymoon?' \\u2728':'');
    var pkgRoute=document.createElement('span');pkgRoute.className='pkg-route';
    pkgRoute.innerText=hotel.location||summary.route||'Room';
    pkgHeader.appendChild(pkgTitle);pkgHeader.appendChild(pkgRoute);

    var pkgBody=document.createElement('div');pkgBody.className='pkg-body';pkgBody.style.height='auto';

    /* Room image */
    var images=hotel.images||[];
    if(images.length>0){var img=document.createElement('img');img.src=images[0];img.alt=hotel.roomType||hotel.name||'Room';img.className='h-room-img';img.onerror=function(){this.style.display='none';};pkgBody.appendChild(img);}

    /* Hotel name + stars */
    var stars=hotel.stars?'\\u2605'.repeat(Math.min(Math.round(hotel.stars),5)):'';
    pkgBody.appendChild(makeRow('Property',(hotel.propertyName||hotel.name||'TBC')+(stars?' '+stars:''),hotel.location||hotel.address||''));

    /* Room type */
    var roomSub=[];if(hotel.bedType)roomSub.push(hotel.bedType);if(hotel.view)roomSub.push(hotel.view);if(hotel.amenities&&hotel.amenities.length)roomSub.push(hotel.amenities.slice(0,3).join(', '));
    pkgBody.appendChild(makeRow('Room',hotel.roomType||'Standard Room',roomSub.join(' \\u00b7 ')||''));

    /* Dates */
    pkgBody.appendChild(makeRow('Dates',(hotel.checkIn||'')+'\\u2192'+(hotel.checkOut||''),nights+' night'+(nights!==1?'s':'')+' \\u00b7 '+passengers+' guest'+(passengers>1?'s':'')));

    /* Meal plan — dropdown if multiple rates available */
    var mealLabels={'room_only':'Room Only','bed_and_breakfast':'Bed & Breakfast','half_board':'Half Board','full_board':'Full Board','all_inclusive':'All Inclusive'};
    var rates=hotel.availableRates||[];
    var mealPlan=hotel.mealPlan||(rates[0]&&rates[0].mealPlan)||'bed_and_breakfast';
    var mealRow=document.createElement('div');mealRow.className='pkg-row';
    var mealLbl=document.createElement('div');mealLbl.className='pkg-label';mealLbl.innerText='Meal Plan';mealRow.appendChild(mealLbl);
    if(rates.length<=1){var mealD=document.createElement('div');mealD.className='pkg-name';mealD.innerText='\\uD83C\\uDF7D\\uFE0F '+(mealLabels[mealPlan]||mealPlan);mealRow.appendChild(mealD);}
    else{var sel=document.createElement('select');sel.className='h-meal-select';rates.forEach(function(rate){var opt=document.createElement('option');opt.value=rate.ratePlanId;opt.setAttribute('data-ppn',rate.pricePerNight);opt.setAttribute('data-meal',rate.mealPlan);opt.selected=rate.mealPlan===mealPlan;opt.innerText=(mealLabels[rate.mealPlan]||rate.mealPlan)+' \\u2014 '+currency+' '+Math.round(rate.pricePerNight).toLocaleString()+'/night';sel.appendChild(opt);});sel.onchange=function(){var o=sel.options[sel.selectedIndex];var ppn=parseFloat(o.getAttribute('data-ppn'))||0;mealPlan=o.getAttribute('data-meal');hotel.ratePlanId=o.value;baseTotal=ppn*nights;currentTotal=baseTotal+calcAncs();updateTotal();};mealRow.appendChild(sel);}
    pkgBody.appendChild(mealRow);

    /* Cancellation policy */
    if(hotel.policySummary){var isRefund=hotel.isRefundable;var strip=document.createElement('div');strip.className='h-policy-strip '+(isRefund===false?'h-policy-amber':'h-policy-green');strip.innerHTML=(isRefund===false?'\\u26a0\\ufe0f ':'\\u2705 ')+hotel.policySummary;pkgBody.appendChild(strip);}

    /* Rate per night */
    pkgBody.appendChild(makeRow('Rate',currency+' '+Math.round(hotel.pricePerNight||0).toLocaleString()+'/night','\\u00d7 '+nights+' nights = '+currency+' '+Math.round(baseTotal).toLocaleString()));

    /* Add-ons — smart: show spa/romance for honeymoon */
    if(ancs.length>0){
      var ancRow=document.createElement('div');ancRow.className='pkg-row';
      var ancLbl=document.createElement('div');ancLbl.className='pkg-label';ancLbl.innerText='Enhance your stay';ancRow.appendChild(ancLbl);
      var ancWrap=document.createElement('div');ancWrap.style.marginTop='6px';
      ancs.forEach(function(anc){
        var chip=document.createElement('span');chip.className='h-addon-chip';
        var basisStr=anc.priceBasis==='per_person'?'/person':anc.priceBasis==='per_night'?'/night':'';
        chip.innerHTML='+ '+anc.name+' <em style="color:inherit;opacity:0.7">'+currency+' '+Math.round(anc.price).toLocaleString()+basisStr+'</em>';
        chip.onclick=function(){
          chip.classList.toggle('on');
          if(chip.classList.contains('on')){selectedAncs.push(anc);}else{selectedAncs=selectedAncs.filter(function(a){return a.id!==anc.id;});}
          currentTotal=baseTotal+calcAncs();updateTotal();
        };
        ancWrap.appendChild(chip);
      });
      ancRow.appendChild(ancWrap);pkgBody.appendChild(ancRow);
    }

    /* Footer */
    var pkgFooter=document.createElement('div');pkgFooter.className='pkg-footer';pkgFooter.style.height='auto';
    var priceDiv=document.createElement('div');priceDiv.className='pkg-price';
    var priceMain=document.createElement('span');priceMain.id='htl-total-'+i;priceMain.innerText=currency+' '+Math.round(baseTotal).toLocaleString();
    var priceSub=document.createElement('small');priceSub.innerText=currency+' '+Math.round(hotel.pricePerNight||0).toLocaleString()+'/night';
    priceDiv.appendChild(priceMain);priceDiv.appendChild(priceSub);
    var bookBtn=document.createElement('button');bookBtn.className='book';bookBtn.innerText='Reserve';
    bookBtn.onclick=function(){var ep=JSON.parse(JSON.stringify(p));ep.hotel.mealPlan=mealPlan;ep.selectedAncillaries=selectedAncs;ep.summary.totalPrice=currentTotal;ep.summary.currency=currency;showHotelGuestForm(ep,bookBtn);};
    pkgFooter.appendChild(priceDiv);pkgFooter.appendChild(bookBtn);

    function calcAncs(){return selectedAncs.reduce(function(s,a){if(a.priceBasis==='per_person')return s+(a.price*passengers);if(a.priceBasis==='per_night')return s+(a.price*nights);return s+a.price;},0);}
    function updateTotal(){var el=document.getElementById('htl-total-'+i);if(el)el.innerText=currency+' '+Math.round(currentTotal).toLocaleString();}

    div.appendChild(pkgHeader);div.appendChild(pkgBody);div.appendChild(pkgFooter);
    messages.appendChild(div);messages.scrollTop=messages.scrollHeight;
  }

  /* ── HOTEL MULTI-PROPERTY ITINERARY ── */
  function addHotelItinerary(p){
    var div=document.createElement('div');div.className='package';
    var summary=p.summary||{};var legs=p.legs||[];var currency=summary.currency||'KES';
    var pkgH=document.createElement('div');pkgH.className='pkg-header';
    var t=document.createElement('span');t.className='pkg-title';t.innerText='Your Sarova Itinerary';
    var r=document.createElement('span');r.className='pkg-route';r.innerText=summary.route||'';
    pkgH.appendChild(t);pkgH.appendChild(r);
    var pkgB=document.createElement('div');pkgB.className='pkg-body';pkgB.style.height='auto';
    var divL=document.createElement('div');divL.className='h-divider';divL.innerText=legs.length+' propert'+(legs.length===1?'y':'ies')+' \\u00b7 '+summary.totalNights+' nights total';pkgB.appendChild(divL);
    legs.forEach(function(leg,idx){
      var stopDiv=document.createElement('div');stopDiv.style.cssText='padding:10px 0;border-bottom:1px dashed var(--h-border,#ddd8cc);';
      var stopTitle=document.createElement('div');stopTitle.style.cssText='font-weight:600;font-size:13px;margin-bottom:4px;';
      stopTitle.innerText='Stop '+(idx+1)+': '+titleCase(leg.destination||'')+' ('+(leg.nights||1)+' night'+((leg.nights||1)===1?'':'s')+')';
      stopDiv.appendChild(stopTitle);
      if(leg.hotel){var h=leg.hotel;var hl=document.createElement('div');hl.style.cssText='font-size:11px;opacity:0.7;line-height:1.5;';hl.innerText=(h.propertyName||h.name||'')+(h.roomType?' \\u2014 '+h.roomType:'')+(h.mealPlan?' \\u00b7 '+(h.mealPlan.replace(/_/g,' ')):'')+'  '+fmtPrice(h.pricePerNight,h.currency)+'/night';stopDiv.appendChild(hl);}
      pkgB.appendChild(stopDiv);
    });
    var pkgF=document.createElement('div');pkgF.className='pkg-footer';pkgF.style.height='auto';
    var pp=document.createElement('div');pp.className='pkg-price';pp.innerText=fmtPrice(Math.round(summary.totalPrice||0),currency);
    var bb=document.createElement('button');bb.className='book';bb.innerText='Book Itinerary';
    bb.onclick=function(){addMsg('To book this multi-property itinerary, our reservations team will contact you to confirm each leg.','bot');};
    pkgF.appendChild(pp);pkgF.appendChild(bb);
    div.appendChild(pkgH);div.appendChild(pkgB);div.appendChild(pkgF);
    messages.appendChild(div);messages.scrollTop=messages.scrollHeight;
  }

  /* ── MANAGE BAR (hotel) ── */
  function showManageBar(){
    var d=document.createElement('div');d.className='h-manage-bar';
    var t=document.createElement('div');t.className='h-manage-title';t.innerText='Manage your booking';d.appendChild(t);
    var wrap=document.createElement('div');
    [['\\uD83D\\uDCC5 Change dates','I\\'d like to change my dates'],['\\uD83D\\uDEC6 Add spa','Please add a spa package'],['\\uD83D\\uDCCB Cancellation policy','What is your cancellation policy?'],['\\u2715 Cancel','I need to cancel my reservation']].forEach(function(pair){
      var btn=document.createElement('button');btn.className='h-manage-btn';btn.innerText=pair[0];
      btn.onclick=function(){input.value=pair[1];send();};
      wrap.appendChild(btn);
    });
    d.appendChild(wrap);
    var wrapper=document.createElement('div');wrapper.className='msg bot';wrapper.style.cssText='max-width:100%;width:100%;padding:0;background:transparent;border:none;';
    wrapper.appendChild(d);messages.appendChild(wrapper);messages.scrollTop=messages.scrollHeight;
  }

  /* ── HOTEL GUEST FORM ── */
  function showHotelGuestForm(p,bookBtn){
    var ex=document.getElementById('et-hotel-form');if(ex)ex.remove();
    var hotel=p.hotel||{};var summary=p.summary||{};var currency=hotel.currency||summary.currency||'KES';var total=summary.totalPrice||hotel.totalRate||0;
    var form=document.createElement('div');form.className='name-form';form.id='et-hotel-form';
    var fp=document.createElement('p');fp.innerText='Complete your reservation:';form.appendChild(fp);
    var strip=document.createElement('div');strip.style.cssText='background:var(--h-ivory,#F8F5EE);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--h-text,#1a1a1a);margin-bottom:12px;border:1px solid var(--h-border,#ddd8cc);';
    var ancNames=(p.selectedAncillaries||[]).map(function(a){return a.name;});
    strip.innerHTML='<strong>'+(hotel.propertyName||hotel.name||'')+'</strong><br>'+(hotel.roomType||'')+(hotel.mealPlan?' \\u00b7 '+hotel.mealPlan.replace(/_/g,' '):'')+'<br>'+(hotel.checkIn||'')+' \\u2192 '+(hotel.checkOut||'')+(ancNames.length?'<br>Add-ons: '+ancNames.join(', '):'')+'<br><strong>Total: '+currency+' '+Math.round(total).toLocaleString()+'</strong>';
    form.appendChild(strip);
    var nameI=document.createElement('input');nameI.className='name-input';nameI.placeholder='Full name';nameI.type='text';form.appendChild(nameI);
    var phoneI=document.createElement('input');phoneI.className='name-input';phoneI.placeholder='Phone number';phoneI.type='tel';form.appendChild(phoneI);
    var emailI=document.createElement('input');emailI.className='name-input';emailI.placeholder='Email (confirmation voucher)';emailI.type='email';form.appendChild(emailI);
    var reqI=document.createElement('textarea');reqI.className='name-input';reqI.placeholder='Special requests \\u2014 late check-in, dietary needs, celebrations\\u2026';reqI.style.height='60px';reqI.style.resize='none';form.appendChild(reqI);
    var errD=document.createElement('div');errD.style.cssText='color:#c0392b;font-size:11px;margin-bottom:8px;display:none;';form.appendChild(errD);
    var confirmBtn=document.createElement('button');confirmBtn.className='confirm-btn';confirmBtn.innerText='Confirm Reservation';
    confirmBtn.onclick=function(){
      errD.style.display='none';
      var name=nameI.value.trim();var phone=phoneI.value.trim();var email=emailI.value.trim();
      if(!name){errD.innerText='Please enter your name.';errD.style.display='block';return;}
      if(!phone){errD.innerText='Please enter your phone number.';errD.style.display='block';return;}
      confirmBtn.innerText='Processing\\u2026';confirmBtn.disabled=true;
      fetch('${apiBase}/api/hotel/reserve',{method:'POST',headers:{'Content-Type':'application/json','x-hotel-key':'${agencyKey}'},body:JSON.stringify({groupSlug:'${agencyKey}',pkg:p,selectedAncillaries:p.selectedAncillaries||[],guestName:name,guestPhone:phone,guestEmail:email||null,specialRequests:reqI.value.trim()||null,channel:'widget'})})
      .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
      .then(function(result){
        if(!result.ok||!result.data.success){errD.innerText=(result.data&&result.data.error)||'Reservation failed. Please try again.';errD.style.display='block';confirmBtn.innerText='Confirm Reservation';confirmBtn.disabled=false;return;}
        form.remove();
        var ref=result.data.reservationRef;
        addMsg('\\uD83C\\uDFE8 Reservation '+ref+' confirmed. '+currency+' '+Math.round(total).toLocaleString()+' due.','bot');
        if(result.data.paymentType==='mpesa'||result.data.paymentType==='both'){
          fetch('${apiBase}/api/hotel/pay',{method:'POST',headers:{'Content-Type':'application/json','x-hotel-key':'${agencyKey}'},body:JSON.stringify({reservationRef:ref,guestPhone:phone})})
          .then(function(r){return r.json();}).then(function(d){addMsg(d.success?(d.paymentLink?'Pay here: '+d.paymentLink:d.message||'Check your phone.'):'Reservation confirmed as '+ref+'. Contact the hotel to arrange payment.','bot');messages.scrollTop=messages.scrollHeight;});
        } else {addMsg('Your reservation '+ref+' is confirmed. The hotel will contact you to arrange payment.','bot');}
        if(bookBtn){bookBtn.innerText='Reserved \\u2713';bookBtn.style.background='#114B43';bookBtn.disabled=true;}
        setTimeout(function(){showManageBar();},500);
      }).catch(function(){errD.innerText='Network error. Please try again.';errD.style.display='block';confirmBtn.innerText='Confirm Reservation';confirmBtn.disabled=false;});
    };
    form.appendChild(confirmBtn);
    var trust=document.createElement('div');trust.className='trust-badge';trust.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg> Secure booking';
    form.appendChild(trust);messages.appendChild(form);messages.scrollTop=messages.scrollHeight;
  }

  /* ══════════════════════════════════════════
     AGENCY FLOW — unchanged from original
  ══════════════════════════════════════════ */
  function pollBookingStatus(bookingRef,bookBtn){var attempts=0;var interval=setInterval(function(){attempts++;fetch('${apiBase}/api/trips/booking/'+bookingRef).then(function(r){return r.json();}).then(function(data){if(data.bookingStage==='paid'){clearInterval(interval);bookBtn.innerText='Paid & Confirmed!';bookBtn.style.background='#27ae60';addMsg('Payment received! Booking '+bookingRef+' is confirmed. Your e-ticket will arrive shortly.','bot');messages.scrollTop=messages.scrollHeight;}else if(data.bookingStage==='failed'||data.status==='cancelled'){clearInterval(interval);bookBtn.innerText='Payment not received';bookBtn.style.background='#C0392B';addMsg('Payment was not received for booking '+bookingRef+'. The hold has been released.','bot');messages.scrollTop=messages.scrollHeight;}else if(attempts>=40){clearInterval(interval);addMsg('Still waiting on payment for booking '+bookingRef+'. If you have paid, this will update shortly.','bot');messages.scrollTop=messages.scrollHeight;}}).catch(function(){});},5000);}

  function showPriceApprovalAlert(priceInfo,bookCtx,bookBtn){var ex=document.getElementById('et-price-alert');if(ex)ex.remove();var div=document.createElement('div');div.className='price-alert';div.id='et-price-alert';var p=document.createElement('p');p.innerHTML='The hotel price changed: <span class="old">'+fmtPrice(priceInfo.oldPrice,priceInfo.currency)+'</span> \\u2192 <span class="new">'+fmtPrice(priceInfo.newPrice,priceInfo.currency)+'</span>.';div.appendChild(p);var actions=document.createElement('div');actions.className='price-alert-actions';var approveBtn=document.createElement('button');approveBtn.className='price-approve';approveBtn.innerText='Approve new price';var cancelBtn=document.createElement('button');cancelBtn.className='price-cancel';cancelBtn.innerText='Cancel';actions.appendChild(approveBtn);actions.appendChild(cancelBtn);div.appendChild(actions);messages.appendChild(div);messages.scrollTop=messages.scrollHeight;cancelBtn.onclick=function(){div.remove();addMsg('Booking cancelled \\u2014 no payment taken.','bot');};approveBtn.onclick=function(){approveBtn.disabled=true;cancelBtn.disabled=true;approveBtn.innerText='Processing\\u2026';fetch('${apiBase}/api/trips/book-init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agencyId:'${agencyKey}',guestName:bookCtx.guestName,guestPhone:bookCtx.phone,guestEmail:bookCtx.email,passengers:bookCtx.passengers,package:bookCtx.pkg,priceApproved:true})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});}).then(function(result){div.remove();if(!result.ok||!result.data.success){addMsg((result.data&&result.data.error)||'Booking failed at the new price.','bot');return;}continueToPayment(result.data,bookCtx,bookBtn);}).catch(function(){div.remove();addMsg('Network error. Please try again.','bot');});});}

  function continueToPayment(data,bookCtx,bookBtn){var bookingRef=data.bookingRef;var totalPrice=data.totalPrice;var currency=data.currency;addMsg('Flight held and hotel confirmed! Ref: '+bookingRef+'. Total: '+currency+' '+totalPrice.toLocaleString()+'. Sending M-Pesa prompt to '+bookCtx.phone+'\\u2026','bot');messages.scrollTop=messages.scrollHeight;fetch('${apiBase}/api/trips/book-pay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bookingRef:bookingRef,phone:bookCtx.phone,amount:totalPrice,currency:currency,email:bookCtx.email,firstName:bookCtx.passengers[0].firstName,lastName:bookCtx.passengers[0].lastName})}).then(function(pr){return pr.json().then(function(pdata){return{ok:pr.ok,data:pdata};});}).then(function(payResult){if(!payResult.ok||!payResult.data.success){if(bookBtn){bookBtn.innerText='Payment failed to send';bookBtn.style.background='#C0392B';}addMsg('Your booking is held as '+bookingRef+', but we could not send the payment prompt. Please contact support.','bot');return;}if(bookBtn){bookBtn.innerText='Awaiting payment\\u2026';bookBtn.style.background='#f0ad4e';bookBtn.disabled=true;}addMsg('Check your phone and enter your M-Pesa PIN. Booking '+bookingRef+' is held for 30 minutes.','bot');messages.scrollTop=messages.scrollHeight;pollBookingStatus(bookingRef,bookBtn||{innerText:'',style:{}});});}

  function showNameForm(p,bookBtn){var ex=document.getElementById('et-name-form');if(ex)ex.remove();var passengerCount=(p.summary&&p.summary.passengers)?p.summary.passengers:1;var needsFlight=p.isMultiDestination?(p.legs||[]).some(function(l){return l.transportIn&&(l.transportIn.transportType||'flight')==='flight';})||!!(p.returnTransport&&(p.returnTransport.transportType||'flight')==='flight'):!!(p.transport&&(p.transport.transportType||'flight')==='flight');var offersSeat=!p.isMultiDestination&&!!(p.transport&&p.transport.supplier==='duffel');var form=document.createElement('div');form.className='name-form';form.id='et-name-form';var formP=document.createElement('p');formP.innerText=needsFlight?'Enter passenger details:':'Enter your details:';form.appendChild(formP);var passengerInputs=[];var currentYear=new Date().getFullYear();function buildDobRow(){var row=document.createElement('div');row.className='dob-row';var daySel=document.createElement('select');daySel.innerHTML='<option value="">Day</option>'+Array.from({length:31},function(_,i){return'<option value="'+(i+1)+'">'+(i+1)+'</option>';}).join('');var monthNames=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];var monthSel=document.createElement('select');monthSel.innerHTML='<option value="">Month</option>'+monthNames.map(function(m,i){return'<option value="'+(i+1)+'">'+m+'</option>';}).join('');var yearSel=document.createElement('select');yearSel.innerHTML='<option value="">Year</option>'+Array.from({length:100},function(_,i){return currentYear-i;}).map(function(y){return'<option value="'+y+'">'+y+'</option>';}).join('');row.appendChild(daySel);row.appendChild(monthSel);row.appendChild(yearSel);return{row:row,daySel:daySel,monthSel:monthSel,yearSel:yearSel};}
  for(var pi=0;pi<passengerCount;pi++){var pBlock=document.createElement('div');pBlock.style.marginBottom='12px';pBlock.style.paddingBottom='10px';pBlock.style.borderBottom=pi<passengerCount-1?'1px dashed #E4E8F0':'none';if(passengerCount>1){var pLabel=document.createElement('div');pLabel.style.cssText='font-size:11px;font-weight:700;color:var(--et-navy,#1E2A5E);margin-bottom:6px;';pLabel.innerText='Traveler '+(pi+1);pBlock.appendChild(pLabel);}var fnI=document.createElement('input');fnI.className='name-input';fnI.placeholder='First name';fnI.type='text';pBlock.appendChild(fnI);var lnI=document.createElement('input');lnI.className='name-input';lnI.placeholder='Last name';lnI.type='text';pBlock.appendChild(lnI);var dobLbl=document.createElement('div');dobLbl.className='field-label';dobLbl.innerText='Date of birth';pBlock.appendChild(dobLbl);var dob=buildDobRow();pBlock.appendChild(dob.row);var gSel=document.createElement('select');gSel.className='name-input';gSel.innerHTML='<option value="male">Male</option><option value="female">Female</option>';pBlock.appendChild(gSel);var cRow=document.createElement('label');cRow.style.cssText='display:flex;align-items:center;gap:6px;font-size:11px;color:var(--et-navy,#1E2A5E);margin-bottom:8px;';var cCb=document.createElement('input');cCb.type='checkbox';cRow.appendChild(cCb);cRow.appendChild(document.createTextNode('Child'));pBlock.appendChild(cRow);var idLbl=document.createElement('div');idLbl.className='field-label';idLbl.innerText='Passport or National ID';pBlock.appendChild(idLbl);var idI=document.createElement('input');idI.className='name-input';idI.placeholder='Passport / ID number';idI.type='text';pBlock.appendChild(idI);var seatSel=null;if(offersSeat){var seatLbl=document.createElement('div');seatLbl.className='field-label';seatLbl.innerText='Seat preference (optional)';pBlock.appendChild(seatLbl);seatSel=document.createElement('select');seatSel.className='name-input';seatSel.innerHTML='<option value="">No preference</option><option value="window">Window</option><option value="aisle">Aisle</option><option value="exit_row">Exit row</option>';pBlock.appendChild(seatSel);}passengerInputs.push({fnI:fnI,lnI:lnI,daySel:dob.daySel,monthSel:dob.monthSel,yearSel:dob.yearSel,gSel:gSel,cCb:cCb,idI:idI,seatSel:seatSel});form.appendChild(pBlock);}
  var cLbl=document.createElement('div');cLbl.style.cssText='font-size:11px;font-weight:700;color:var(--et-navy,#1E2A5E);margin-bottom:6px;';cLbl.innerText='Contact';form.appendChild(cLbl);var phoneI=document.createElement('input');phoneI.className='name-input';phoneI.placeholder='Phone (e.g. 0712345678)';phoneI.type='tel';form.appendChild(phoneI);var emailI=document.createElement('input');emailI.className='name-input';emailI.placeholder='Email';emailI.type='email';form.appendChild(emailI);var errD=document.createElement('div');errD.style.cssText='color:#C0392B;font-size:11px;margin-bottom:8px;display:none;';form.appendChild(errD);var confirmBtn=document.createElement('button');confirmBtn.className='confirm-btn';confirmBtn.innerText='Confirm Booking';
  confirmBtn.onclick=function(){errD.style.display='none';var passengers=[];for(var k=0;k<passengerInputs.length;k++){var pin=passengerInputs[k];var fn=pin.fnI.value.trim();var ln=pin.lnI.value.trim();if(!fn||!ln){errD.innerText='Please fill in all traveler names.';errD.style.display='block';return;}var day=pin.daySel.value,month=pin.monthSel.value,year=pin.yearSel.value;if(!day||!month||!year){errD.innerText='Please select a complete date of birth for traveler '+(k+1)+'.';errD.style.display='block';return;}var dobStr=year+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');var isChild=pin.cCb.checked;var idNum=pin.idI.value.trim();if(!isChild&&!idNum){errD.innerText='Passport/ID required for traveler '+(k+1)+'.';errD.style.display='block';return;}passengers.push({firstName:fn,lastName:ln,dateOfBirth:dobStr,gender:pin.gSel.value,type:isChild?'child':'adult',idNumber:idNum||null,seatPreference:(pin.seatSel&&pin.seatSel.value)?pin.seatSel.value:null});}var phone=phoneI.value.trim();var email=emailI.value.trim();if(!phone){errD.innerText='Phone number is required.';errD.style.display='block';return;}if(needsFlight&&!email){errD.innerText='Email is required for flight bookings.';errD.style.display='block';return;}var guestName=passengers[0].firstName+' '+passengers[0].lastName;var bookCtx={guestName:guestName,phone:phone,email:email,passengers:passengers,pkg:p};confirmBtn.innerText='Processing\\u2026';confirmBtn.disabled=true;fetch('${apiBase}/api/trips/book-init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agencyId:'${agencyKey}',guestName:guestName,guestPhone:phone,guestEmail:email,passengers:passengers,package:p})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});}).then(function(result){if(!result.ok&&result.data&&result.data.code==='PRICE_CHANGED'){form.remove();showPriceApprovalAlert(result.data,bookCtx,bookBtn);return;}if(!result.ok||!result.data.success){var msg=(result.data&&result.data.error)?result.data.error:'Booking failed. Please try again.';errD.innerText=msg;errD.style.display='block';confirmBtn.innerText='Confirm Booking';confirmBtn.disabled=false;return;}form.remove();continueToPayment(result.data,bookCtx,bookBtn);}).catch(function(){errD.innerText='Network error. Please try again.';errD.style.display='block';confirmBtn.innerText='Confirm Booking';confirmBtn.disabled=false;});};
  form.appendChild(confirmBtn);var trust=document.createElement('div');trust.className='trust-badge';trust.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg> Secure payment via M-Pesa';form.appendChild(trust);messages.appendChild(form);messages.scrollTop=messages.scrollHeight;}

  function addPackage(p,i){var div=document.createElement('div');div.className='package';div.style.height='auto';var transport=p.transport||null;var returnTransport=p.returnTransport||null;var hotel=p.hotel||null;var transfers=p.transfers||null;var summary=p.summary||{};var totalCurrency=summary.currency||'KES';var total=Math.round(summary.totalPrice||0);var ppp=Math.round(summary.pricePerPerson||0);var nights=summary.nights||0;var passengers=summary.passengers||1;var route=summary.route||((transport&&transport.origin?transport.origin:'TBC')+' to '+(transport&&transport.destination?transport.destination:'TBC'));var pkgHeader=document.createElement('div');pkgHeader.className='pkg-header';var pkgTitle=document.createElement('span');pkgTitle.className='pkg-title';pkgTitle.innerText='Option '+(i+1);var pkgRoute=document.createElement('span');pkgRoute.className='pkg-route';pkgRoute.innerText=route;pkgHeader.appendChild(pkgTitle);pkgHeader.appendChild(pkgRoute);var pkgBody=document.createElement('div');pkgBody.className='pkg-body';pkgBody.style.height='auto';if(transport){var isbus=(transport.transportType||'').toLowerCase()==='bus';var tLabel=isbus?'Outbound Bus':'Outbound Flight';var tName=transport.airline||transport.provider||'TBC';var tSub=(transport.origin||'TBC')+' \\u2192 '+(transport.destination||'TBC')+' | '+fmtTime(transport.departureTime)+' - '+fmtTime(transport.arrivalTime);if(transport.stops)tSub+=' | '+transport.stops;if(transport.cabinClass)tSub+=' | '+transport.cabinClass;if(!isbus&&transport.baggageSummary)tSub+=' | '+transport.baggageSummary;tSub+=' | '+fmtPrice(transport.price,transport.currency);pkgBody.appendChild(makeRow(tLabel,tName,tSub));var tPolicyText=transport.policySummary||(isbus?transport.cancellationPolicy:null);if(tPolicyText){var tTone=transport.isRefundable===true?'good':transport.isRefundable===false?'warn':'neutral';pkgBody.appendChild(makeHighlight(tPolicyText,tTone));}}if(returnTransport){var isRetBus=(returnTransport.transportType||'').toLowerCase()==='bus';var rtLabel=isRetBus?'Return Bus':'Return Flight';var rtName=returnTransport.airline||returnTransport.provider||'TBC';var rtSub=(returnTransport.origin||'TBC')+' \\u2192 '+(returnTransport.destination||'TBC')+' | '+fmtTime(returnTransport.departureTime)+' - '+fmtTime(returnTransport.arrivalTime);if(!isRetBus&&returnTransport.baggageSummary)rtSub+=' | '+returnTransport.baggageSummary;rtSub+=' | '+fmtPrice(returnTransport.price,returnTransport.currency);pkgBody.appendChild(makeRow(rtLabel,rtName,rtSub));var rtPolicyText=returnTransport.policySummary||(isRetBus?returnTransport.cancellationPolicy:null);if(rtPolicyText){var rtTone=returnTransport.isRefundable===true?'good':returnTransport.isRefundable===false?'warn':'neutral';pkgBody.appendChild(makeHighlight(rtPolicyText,rtTone));}}if(hotel){var stars=hotel.stars?'\\u2605'.repeat(Math.min(Math.round(hotel.stars),5)):'';var hName=(hotel.name||'TBC')+(stars?' '+stars:'');var hSub=(hotel.location||'TBC');if(nights>0)hSub+=' | '+nights+' nights | '+fmtPrice(hotel.pricePerNight,hotel.currency)+'/night';if(hotel.rating)hSub+=' | Rating: '+hotel.rating+'/5';if(hotel.images&&hotel.images.length>0){var hotelImg=document.createElement('img');hotelImg.src=hotel.images[0];hotelImg.alt=hotel.name||'Hotel';hotelImg.style.cssText='width:100%;height:140px;object-fit:cover;border-radius:10px;margin-bottom:8px;display:block;';hotelImg.onerror=function(){this.style.display='none';};pkgBody.appendChild(hotelImg);}pkgBody.appendChild(makeRow('Hotel',hName,hSub));if(hotel.mealPlan){pkgBody.appendChild(makeHighlight('\\uD83C\\uDF7D\\uFE0F Board: '+hotel.mealPlan,'neutral'));}var hPolicyTone=hotel.isRefundable===false?'warn':hotel.isRefundable===true||hotel.policySummary?'good':'neutral';var hPolicyText=hotel.policySummary||(hotel.isRefundable===false?'\\u26a0\\ufe0f Non-refundable':'Refund terms confirmed at booking');pkgBody.appendChild(makeHighlight(hPolicyText,hPolicyTone));}var transferList=Array.isArray(transfers)?transfers:(transfers?[transfers]:[]);if(transferList.length>0){var transferSub=transferList.map(function(t){var legLabel=t.legType==='departure'?'Departure':t.legType==='arrival'?'Arrival':(t.provider||'Transfer');return legLabel+': '+(t.description||t.location||'TBC')+' ('+fmtPrice(t.price,t.currency)+')';}).join(' | ');pkgBody.appendChild(makeRow('Transfer',transferList[0].provider||'Bodrless Standard Transfer',transferSub));}if(p.connectionAdvisory){var advRow=document.createElement('div');advRow.className='pkg-row';var advLbl=document.createElement('div');advLbl.className='pkg-label';advLbl.innerText='\\u26a0\\ufe0f Before you book';var advTxt=document.createElement('div');advTxt.className='pkg-sub';advTxt.innerText=p.connectionAdvisory;advRow.appendChild(advLbl);advRow.appendChild(advTxt);pkgBody.appendChild(advRow);}var pkgFooter=document.createElement('div');pkgFooter.className='pkg-footer';pkgFooter.style.height='auto';var pkgPrice=document.createElement('div');pkgPrice.className='pkg-price';pkgPrice.innerText=fmtPrice(total,totalCurrency);var pkgPriceSub=document.createElement('small');pkgPriceSub.innerText=fmtPrice(ppp,totalCurrency)+'/person | '+passengers+' traveller(s)';pkgPrice.appendChild(pkgPriceSub);var bookBtn=document.createElement('button');bookBtn.className='book';bookBtn.innerText='Book Now';bookBtn.onclick=function(){showNameForm(p,bookBtn);};pkgFooter.appendChild(pkgPrice);pkgFooter.appendChild(bookBtn);div.appendChild(pkgHeader);div.appendChild(pkgBody);div.appendChild(pkgFooter);messages.appendChild(div);messages.scrollTop=messages.scrollHeight;}

  function addItinerary(p){var div=document.createElement('div');div.className='package';div.style.height='auto';var summary=p.summary||{};var legs=p.legs||[];var totalCurrency=summary.currency||'KES';var total=Math.round(summary.totalPrice||0);var ppp=Math.round(summary.pricePerPerson||0);var passengers=summary.passengers||1;var pkgHeader=document.createElement('div');pkgHeader.className='pkg-header';var pkgTitle=document.createElement('span');pkgTitle.className='pkg-title';pkgTitle.innerText='Your Itinerary';var pkgRoute=document.createElement('span');pkgRoute.className='pkg-route';pkgRoute.innerText=summary.route||'';pkgHeader.appendChild(pkgTitle);pkgHeader.appendChild(pkgRoute);var pkgBody=document.createElement('div');pkgBody.className='pkg-body';pkgBody.style.height='auto';legs.forEach(function(leg,idx){var stopDiv=document.createElement('div');stopDiv.className='itin-stop'+(leg.isBufferLeg?' buffer':'');var titleDiv=document.createElement('div');titleDiv.className='itin-stop-title'+(leg.isBufferLeg?' buffer':'');titleDiv.innerText=leg.isBufferLeg?'Connection: '+titleCase(leg.destination):'Stop '+(idx+1)+': '+titleCase(leg.destination)+' ('+(leg.nights||1)+' night'+((leg.nights||1)===1?'':'s')+')';stopDiv.appendChild(titleDiv);var t=leg.transportIn;if(t){var isbus=(t.transportType||'').toLowerCase()==='bus';var tLine=document.createElement('div');tLine.style.cssText='font-size:11px;color:var(--et-muted,#8892A4);line-height:1.5;margin-bottom:2px;';tLine.innerText=(isbus?'Bus: ':'Flight: ')+(t.airline||t.provider||'TBC')+' | '+(t.origin||'TBC')+' \\u2192 '+(t.destination||'TBC')+' | '+fmtTime(t.departureTime)+'-'+fmtTime(t.arrivalTime)+' | '+fmtPrice(t.price,t.currency);stopDiv.appendChild(tLine);}if(leg.hotel){var h=leg.hotel;var stars=h.stars?'\\u2605'.repeat(Math.min(Math.round(h.stars),5)):'';var hLine=document.createElement('div');hLine.style.cssText='font-size:11px;color:var(--et-muted,#8892A4);line-height:1.5;';hLine.innerText='Hotel: '+(h.name||'TBC')+(stars?' '+stars:'')+(h.location?' | '+h.location:'')+' | '+fmtPrice(h.pricePerNight,h.currency)+'/night \\u00d7 '+(leg.nights||1);stopDiv.appendChild(hLine);}pkgBody.appendChild(stopDiv);});if(p.returnTransport){var rt=p.returnTransport;var isRetBus=(rt.transportType||'').toLowerCase()==='bus';var returnDiv=document.createElement('div');returnDiv.style.padding='10px 0';var returnTitle=document.createElement('div');returnTitle.style.fontWeight='600';returnTitle.style.fontSize='12px';returnTitle.style.marginBottom='4px';returnTitle.innerText='Return';returnDiv.appendChild(returnTitle);var returnLine=document.createElement('div');returnLine.style.cssText='font-size:11px;color:var(--et-muted,#8892A4);';returnLine.innerText=(isRetBus?'Bus: ':'Flight: ')+(rt.origin||'TBC')+' \\u2192 '+(rt.destination||'TBC')+' | '+fmtTime(rt.departureTime)+'-'+fmtTime(rt.arrivalTime)+' | '+fmtPrice(rt.price,rt.currency);returnDiv.appendChild(returnLine);pkgBody.appendChild(returnDiv);}var pkgFooter=document.createElement('div');pkgFooter.className='pkg-footer';pkgFooter.style.height='auto';var pkgPrice=document.createElement('div');pkgPrice.className='pkg-price';pkgPrice.innerText=fmtPrice(total,totalCurrency);var pkgPriceSub=document.createElement('small');pkgPriceSub.innerText=fmtPrice(ppp,totalCurrency)+'/person | '+passengers+' traveller(s)';pkgPrice.appendChild(pkgPriceSub);var bookBtn=document.createElement('button');bookBtn.className='book';bookBtn.innerText='Book This Itinerary';bookBtn.onclick=function(){showNameForm(p,bookBtn);};pkgFooter.appendChild(pkgPrice);pkgFooter.appendChild(bookBtn);div.appendChild(pkgHeader);div.appendChild(pkgBody);div.appendChild(pkgFooter);messages.appendChild(div);messages.scrollTop=messages.scrollHeight;}

  /* ── SEND ── */
  function send(){
    var text=input.value.trim();if(!text)return;
    addMsg(text,'user');transcript.push({type:'user',text:text});save();input.value='';
    showTyping();
    var endpoint=IS_HOTEL?'${apiBase}/api/hotel/orchestrate':'${apiBase}/api/trips/orchestrate';
    var authHeader=IS_HOTEL?{'x-hotel-key':'${agencyKey}'}:{'x-api-key':'${agencyKey}'};
    var body=IS_HOTEL?JSON.stringify({prompt:text,groupSlug:'${agencyKey}',conversationHistory:conversationHistory,previousParams:previousParams}):JSON.stringify({prompt:text,agencyId:'${agencyKey}',channelType:'widget',sessionId:sessionId,conversationHistory:conversationHistory,previousParams:previousParams});
    fetch(endpoint,{method:'POST',headers:Object.assign({'Content-Type':'application/json'},authHeader),body:body})
    .then(function(res){return res.json();})
    .then(function(data){
      hideTyping();
      if(data.sessionId)sessionId=data.sessionId;
      if(data.tripParams)previousParams=data.tripParams;
      if(data.conversationHistory)conversationHistory=data.conversationHistory;
      if(data.needsClarification){var ct=data.text||'Could you give me a bit more detail?';addMsg(ct,'bot');transcript.push({type:'bot',text:ct});save();return;}
      var pkgs=data&&data.packages?data.packages:[];
      var isHotelResp=data.isHotelDirect||(pkgs.length>0&&pkgs[0]&&pkgs[0].isHotelDirect);
      var isMultiProp=isHotelResp&&pkgs.length===1&&pkgs[0]&&pkgs[0].isMultiDestination;
      var isItin=!isHotelResp&&pkgs.length===1&&pkgs[0]&&pkgs[0].isMultiDestination;
      if(!pkgs.length){var nt=(data&&data.text)?data.text:'No options found for those dates.';addMsg(nt,'bot');transcript.push({type:'bot',text:nt});save();return;}
      var responseMsg=data.text||(isHotelResp?'Here are the available rooms:':'I found '+pkgs.length+' option'+(pkgs.length>1?'s':'')+' for you:');
      addMsg(responseMsg,'bot');transcript.push({type:'bot',text:responseMsg});
      if(isHotelResp&&isMultiProp){addHotelItinerary(pkgs[0]);transcript.push({type:'hotel_itinerary',pkg:pkgs[0]});}
      else if(isHotelResp){pkgs.forEach(function(p,i){addHotelPackage(p,i);});transcript.push({type:'hotel_packages',packages:pkgs});if(IS_HOTEL)setTimeout(showManageBar,300);}
      else if(isItin){addItinerary(pkgs[0]);transcript.push({type:'itinerary',pkg:pkgs[0]});}
      else{pkgs.slice(0,6).forEach(function(p,i){addPackage(p,i);});transcript.push({type:'packages',packages:pkgs.slice(0,6)});}
      save();
    })
    .catch(function(e){hideTyping();console.log('Widget error:',e);addMsg('Unable to load right now. Please try again.','bot');});
  }

  sendBtn.onclick=send;
  input.addEventListener('keypress',function(e){if(e.key==='Enter')send();});
  console.log('[BODRLESS] Widget loaded: ${agencyKey} | hotel: ${isHotelDirect}');
}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',initWidget);}else{initWidget();}
})();`;

  res.send(code);
});

module.exports = router;