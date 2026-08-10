const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
    console.log('[HOTEL WIDGET ROUTE] hit — key:',
  const groupSlug   = req.query.key   || 'sarova';
  const hotelName   = req.query.name  || 'Sarova Hotels';
  const embedTarget = req.query.embed || null;
  const apiBase     = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';

  if (!req.query.key) {
    console.warn('[BODRLESS] hotel widget loaded without ?key= — defaulting to', groupSlug);
  }

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  const styles = `
:root{
  --bd-navy:#1C2B4A;
  --bd-navy-hover:#243560;
  --bd-gold:#A8824A;
  --bd-gold-hover:#C9A96E;
  --bd-cream:#F8F6F2;
  --bd-warm-white:#FDFCFB;
  --bd-border:#E6E0D6;
  --bd-border-strong:#D4CCBF;
  --bd-muted:#8C8279;
  --bd-green:#1F7A4A;
  --bd-green-bg:#EAF5EF;
  --bd-red:#A03030;
  --bd-red-bg:#FDF0F0;
  --bd-text:#1A1A1A;
}

#bd-hotel-root *{box-sizing:border-box;font-family:'Inter',system-ui,-apple-system,sans-serif;}

/* ── Chat container ── */
#bd-hotel-chat{
  background:var(--bd-warm-white);
  z-index:999999;
  display:none;
  flex-direction:column;
  border-radius:20px;
  overflow:hidden;
  border:1px solid var(--bd-border);
}
#bd-hotel-chat.open{display:flex;}
#bd-hotel-chat.floating{
  position:fixed;bottom:88px;right:24px;
  width:400px;height:660px;
}
#bd-hotel-chat.embedded{
  position:relative;width:100%;height:760px;
  display:flex;border-radius:0;border:none;
}

/* ── Header ── */
#bd-hotel-header{
  background:var(--bd-navy);
  padding:14px 18px;
  display:flex;align-items:center;justify-content:space-between;
  flex-shrink:0;
}
#bd-hotel-header .bd-hdr-left{display:flex;align-items:center;gap:11px;}
#bd-hotel-header .bd-avatar{
  width:38px;height:38px;border-radius:50%;
  background:var(--bd-gold);
  color:#fff;display:flex;align-items:center;justify-content:center;
  font-size:15px;font-weight:700;flex-shrink:0;letter-spacing:-.5px;
}
#bd-hotel-header .bd-hdr-name{font-size:13px;font-weight:600;color:#fff;letter-spacing:.1px;}
#bd-hotel-header .bd-hdr-sub{
  font-size:9px;color:rgba(255,255,255,.4);
  letter-spacing:1.8px;text-transform:uppercase;margin-top:2px;
}
#bd-hotel-header .bd-close{
  width:26px;height:26px;border-radius:50%;
  background:rgba(255,255,255,.08);border:none;
  color:rgba(255,255,255,.55);cursor:pointer;
  font-size:14px;display:flex;align-items:center;justify-content:center;
  transition:background .15s;
}
#bd-hotel-header .bd-close:hover{background:rgba(255,255,255,.15);}

/* ── Messages ── */
#bd-hotel-messages{
  flex:1;padding:14px 12px;overflow-y:auto;
  display:flex;flex-direction:column;gap:10px;
  background:var(--bd-cream);min-height:0;
}

/* ── Input area ── */
#bd-hotel-input-area{
  display:flex;border-top:1px solid var(--bd-border);
  background:var(--bd-warm-white);padding:10px 12px;gap:8px;align-items:center;
  flex-shrink:0;
}
#bd-hotel-input{
  flex:1;padding:9px 14px;
  border:1.5px solid var(--bd-border);border-radius:20px;
  outline:none;font-size:12px;background:var(--bd-cream);color:var(--bd-text);
  transition:border-color .15s;
}
#bd-hotel-input:focus{border-color:var(--bd-navy);}
#bd-hotel-input::placeholder{color:var(--bd-muted);font-size:11.5px;}
#bd-hotel-send{
  background:var(--bd-navy);color:#fff;border:none;
  width:36px;height:36px;border-radius:50%;cursor:pointer;
  font-size:14px;display:flex;align-items:center;justify-content:center;
  flex-shrink:0;transition:background .2s;
}
#bd-hotel-send:hover{background:var(--bd-gold);}

/* ── Typing indicator ── */
@keyframes bd-bounce{
  0%,60%,100%{transform:translateY(0);opacity:.4;}
  30%{transform:translateY(-5px);opacity:1;}
}
.bd-typing{
  background:var(--bd-warm-white);border:1px solid var(--bd-border);
  padding:11px 15px;border-radius:14px;border-bottom-left-radius:4px;
  display:flex;gap:5px;align-items:center;width:fit-content;
}
.bd-typing span{
  width:6px;height:6px;background:var(--bd-navy);
  border-radius:50%;animation:bd-bounce 1.2s infinite;
}
.bd-typing span:nth-child(2){animation-delay:.2s;background:var(--bd-gold);}
.bd-typing span:nth-child(3){animation-delay:.4s;}

/* ── Message bubbles ── */
.bd-msg{
  padding:10px 14px;border-radius:16px;
  max-width:84%;font-size:12.5px;line-height:1.6;
}
.bd-user{
  background:var(--bd-navy);color:#fff;
  margin-left:auto;border-bottom-right-radius:4px;
}
.bd-bot{
  background:var(--bd-warm-white);color:var(--bd-text);
  border:1px solid var(--bd-border);border-bottom-left-radius:4px;
}

/* ── Welcome card ── */
.bd-welcome{
  background:var(--bd-warm-white);border-radius:16px;
  padding:18px 16px;border:1px solid var(--bd-border);
}
.bd-eyebrow{
  font-size:9px;font-weight:700;letter-spacing:3px;
  text-transform:uppercase;color:var(--bd-gold);margin-bottom:9px;
}
.bd-welcome-title{
  font-size:16px;font-weight:600;color:var(--bd-navy);
  margin-bottom:7px;line-height:1.3;
}
.bd-welcome-body{
  font-size:12px;color:var(--bd-muted);
  line-height:1.65;margin-bottom:15px;
}
.bd-divider{height:1px;background:var(--bd-border);margin-bottom:13px;}
.bd-prompts-label{
  font-size:9px;font-weight:700;letter-spacing:2px;
  text-transform:uppercase;color:var(--bd-muted);margin-bottom:10px;
}
.bd-starter{
  width:100%;background:var(--bd-cream);
  border:1px solid var(--bd-border);border-radius:10px;
  padding:11px 13px;text-align:left;cursor:pointer;
  transition:all .18s;margin-bottom:7px;display:block;
}
.bd-starter:last-child{margin-bottom:0;}
.bd-starter:hover{background:var(--bd-navy);border-color:var(--bd-navy);}
.bd-starter:hover .bd-st-title,
.bd-starter:hover .bd-st-body{color:#fff;}
.bd-st-title{font-size:12px;font-weight:600;color:var(--bd-navy);margin-bottom:2px;transition:color .18s;}
.bd-st-body{font-size:11px;color:var(--bd-muted);line-height:1.45;transition:color .18s;}

/* ── Room card ── */
.bd-pkg{
  background:var(--bd-warm-white);border:1px solid var(--bd-border);
  border-radius:16px;overflow:hidden;margin-bottom:6px;
}
.bd-pkg:last-child{margin-bottom:0;}

/* Image zone */
.bd-pkg-img{
  width:100%;height:140px;overflow:hidden;position:relative;
  background:var(--bd-navy);display:flex;align-items:center;justify-content:center;
}
.bd-pkg-img img{width:100%;height:100%;object-fit:cover;display:block;}
.bd-pkg-img-placeholder{font-size:32px;opacity:.15;}
.bd-pkg-badge{
  position:absolute;top:10px;left:10px;
  background:var(--bd-gold);color:#fff;
  font-size:9px;font-weight:700;letter-spacing:1px;
  text-transform:uppercase;padding:4px 10px;border-radius:20px;
}

/* Card body */
.bd-pkg-body{padding:13px 14px 10px;}
.bd-pkg-name{font-size:13px;font-weight:600;color:var(--bd-navy);margin-bottom:3px;}
.bd-pkg-meta{font-size:11px;color:var(--bd-muted);margin-bottom:10px;line-height:1.4;}
.bd-tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;}
.bd-tag{
  font-size:10px;color:var(--bd-muted);
  background:var(--bd-cream);border:1px solid var(--bd-border);
  border-radius:6px;padding:3px 8px;
}

/* Meal plan highlight */
.bd-meal{
  font-size:11px;font-weight:600;color:var(--bd-navy);
  background:#EEF0F7;border-radius:7px;
  padding:5px 9px;margin-bottom:8px;display:inline-block;
}

/* Cancellation policy */
.bd-cancel{
  display:flex;align-items:center;gap:6px;
  font-size:11px;padding:6px 9px;border-radius:8px;margin-bottom:2px;
  line-height:1.4;
}
.bd-cancel-ok{background:var(--bd-green-bg);color:var(--bd-green);}
.bd-cancel-no{background:var(--bd-red-bg);color:var(--bd-red);}
.bd-cancel-neutral{background:#F0EDE8;color:#5A4A3A;}
.bd-cancel-icon{font-size:12px;flex-shrink:0;}

/* Price match banner */
.bd-price-match{
  font-size:10.5px;font-weight:600;color:var(--bd-green);
  background:var(--bd-green-bg);
  border-radius:7px;padding:5px 9px;margin-top:6px;
  display:flex;align-items:center;gap:5px;
}

/* Card footer */
.bd-pkg-footer{
  padding:10px 14px;background:#F4F2EE;
  border-top:1px solid var(--bd-border);
  display:flex;justify-content:space-between;align-items:center;
}
.bd-pkg-price-main{font-size:20px;font-weight:700;color:var(--bd-navy);line-height:1;}
.bd-pkg-price-sub{font-size:10px;color:var(--bd-muted);margin-top:2px;}
.bd-reserve-btn{
  background:var(--bd-navy);color:#fff;border:none;
  padding:10px 20px;border-radius:20px;cursor:pointer;
  font-size:12px;font-weight:600;letter-spacing:.2px;
  transition:background .2s,opacity .2s;
}
.bd-reserve-btn:hover{background:var(--bd-gold);}
.bd-reserve-btn:disabled{opacity:.6;cursor:not-allowed;background:var(--bd-navy);}
.bd-reserve-btn.selected{background:#1F7A4A;}

/* ── Available rates switcher ── */
.bd-rates{margin-top:10px;border-top:1px solid var(--bd-border);padding-top:10px;}
.bd-rates-label{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--bd-muted);margin-bottom:7px;}
.bd-rate-row{
  display:flex;justify-content:space-between;align-items:center;
  padding:7px 10px;border-radius:8px;cursor:pointer;
  border:1px solid transparent;margin-bottom:4px;transition:all .15s;
  background:var(--bd-cream);
}
.bd-rate-row:hover{border-color:var(--bd-border-strong);}
.bd-rate-row.active{border-color:var(--bd-navy);background:#EEF0F7;}
.bd-rate-meal{font-size:11.5px;font-weight:500;color:var(--bd-navy);}
.bd-rate-price{font-size:12px;font-weight:700;color:var(--bd-navy);}
.bd-rate-badge{font-size:9px;color:var(--bd-muted);background:var(--bd-border);border-radius:4px;padding:2px 6px;margin-left:6px;}

/* ── Guest form ── */
.bd-form{
  background:var(--bd-warm-white);border:1px solid var(--bd-border);
  border-radius:16px;padding:16px;margin-top:4px;
}
.bd-form-title{font-size:12px;font-weight:600;color:var(--bd-navy);margin-bottom:12px;}
.bd-input{
  width:100%;padding:9px 12px;
  border:1.5px solid var(--bd-border);border-radius:10px;
  outline:none;font-size:12px;color:var(--bd-text);
  box-sizing:border-box;margin-bottom:9px;
  font-family:'Inter',system-ui,sans-serif;
  background:var(--bd-cream);transition:border-color .15s;
}
.bd-input:focus{border-color:var(--bd-navy);}
.bd-input::placeholder{color:var(--bd-muted);}
.bd-textarea{height:56px;resize:none;}
.bd-confirm-btn{
  background:var(--bd-navy);color:#fff;border:none;
  padding:11px 18px;border-radius:20px;cursor:pointer;
  font-size:12px;font-weight:600;width:100%;
  transition:background .2s;letter-spacing:.2px;
}
.bd-confirm-btn:hover{background:var(--bd-gold);}
.bd-confirm-btn:disabled{opacity:.6;cursor:not-allowed;}
.bd-err{color:#A03030;font-size:11px;margin-bottom:8px;display:none;}

/* ── Upsell cards (shown post-selection) ── */
.bd-upsell-section{margin-top:4px;}
.bd-upsell-label{
  font-size:9px;font-weight:700;letter-spacing:2px;
  text-transform:uppercase;color:var(--bd-muted);margin-bottom:8px;
}
.bd-upsell-card{
  background:var(--bd-warm-white);border:1px solid var(--bd-border);
  border-radius:12px;padding:11px 13px;margin-bottom:6px;
  display:flex;justify-content:space-between;align-items:center;gap:10px;
}
.bd-upsell-card:last-child{margin-bottom:0;}
.bd-upsell-name{font-size:12px;font-weight:600;color:var(--bd-navy);}
.bd-upsell-desc{font-size:11px;color:var(--bd-muted);line-height:1.4;margin-top:2px;}
.bd-upsell-badge{
  font-size:9px;font-weight:600;color:var(--bd-gold);
  background:#F8F2E8;border-radius:5px;padding:2px 7px;
  display:inline-block;margin-bottom:4px;
}
.bd-upsell-price{font-size:12px;font-weight:700;color:var(--bd-navy);white-space:nowrap;}
.bd-upsell-add{
  background:transparent;color:var(--bd-navy);
  border:1.5px solid var(--bd-border-strong);
  padding:6px 12px;border-radius:16px;cursor:pointer;
  font-size:11px;font-weight:600;white-space:nowrap;
  transition:all .15s;flex-shrink:0;
}
.bd-upsell-add:hover{background:var(--bd-navy);color:#fff;border-color:var(--bd-navy);}
.bd-upsell-add.added{background:var(--bd-green-bg);color:var(--bd-green);border-color:var(--bd-green);cursor:default;}

/* ── Powered by ── */
.bd-powered{
  text-align:center;padding:7px 0 4px;
  font-size:10px;color:var(--bd-muted);letter-spacing:.3px;flex-shrink:0;
}
.bd-powered a{color:var(--bd-gold);text-decoration:none;font-weight:600;}

/* ── Trigger button ── */
#bd-hotel-trigger{
  position:fixed;bottom:24px;right:24px;
  background:var(--bd-navy);color:#fff;border:none;
  padding:14px 22px;border-radius:30px;cursor:pointer;
  font-size:14px;font-weight:600;
  box-shadow:0 4px 20px rgba(28,43,74,.25);
  z-index:999998;transition:background .2s,transform .15s;
  letter-spacing:.1px;
}
#bd-hotel-trigger:hover{background:var(--bd-gold);transform:translateY(-1px);}
`;

  const MEAL_LABELS = {
    room_only:         'Room only',
    bed_and_breakfast: 'Bed & breakfast',
    half_board:        'Half board',
    full_board:        'Full board',
    all_inclusive:     'All inclusive',
  };

  const widgetCode = `(function(){
function initHotelWidget(){
  if(!document.body){setTimeout(initHotelWidget,50);return;}
  if(document.getElementById('bd-hotel-root'))return;

  var groupSlug   = ${JSON.stringify(groupSlug)};
  var hotelName   = ${JSON.stringify(hotelName)};
  var embedTarget = ${JSON.stringify(embedTarget)};
  var apiBase     = ${JSON.stringify(apiBase)};
  var sessionId   = null;
  var conversationHistory = [];
  var previousParams      = null;

  var MEAL_LABELS = {
    room_only:'Room only',bed_and_breakfast:'Bed & breakfast',
    half_board:'Half board',full_board:'Full board',all_inclusive:'All inclusive',
  };

  // ── Inject styles ──────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.innerHTML = ${JSON.stringify(styles)};
  document.head.appendChild(style);

  // ── Build DOM ──────────────────────────────────────────────────────────
  var root = document.createElement('div'); root.id = 'bd-hotel-root';
  var chat = document.createElement('div'); chat.id = 'bd-hotel-chat';
  chat.classList.add(embedTarget ? 'embedded' : 'floating');

  // Header
  var hdr = document.createElement('div'); hdr.id = 'bd-hotel-header';
  var hdrLeft = document.createElement('div'); hdrLeft.className = 'bd-hdr-left';
  var avatar = document.createElement('div'); avatar.className = 'bd-avatar';
  avatar.innerText = hotelName.charAt(0);
  var hdrText = document.createElement('div');
  hdrText.innerHTML = '<div class="bd-hdr-name">'+hotelName+'</div><div class="bd-hdr-sub">Concierge</div>';
  hdrLeft.appendChild(avatar); hdrLeft.appendChild(hdrText);
  var closeBtn = document.createElement('button'); closeBtn.className = 'bd-close';
  closeBtn.innerHTML = '&#215;'; closeBtn.setAttribute('aria-label','Close chat');
  if(embedTarget) closeBtn.style.display = 'none';
  hdr.appendChild(hdrLeft); hdr.appendChild(closeBtn);

  // Messages
  var msgs = document.createElement('div'); msgs.id = 'bd-hotel-messages';

  // Powered by
  var powered = document.createElement('div'); powered.className = 'bd-powered';
  powered.innerHTML = "Powered by <a href='https://bodrless.com' target='_blank'>Bodrless</a>";

  // Input area
  var inputArea = document.createElement('div'); inputArea.id = 'bd-hotel-input-area';
  var input = document.createElement('input'); input.id = 'bd-hotel-input';
  input.placeholder = 'Ask about availability, dates, upgrades…';
  input.type = 'text'; input.setAttribute('autocomplete','off');
  var sendBtn = document.createElement('button'); sendBtn.id = 'bd-hotel-send';
  sendBtn.innerHTML = '&#10148;'; sendBtn.setAttribute('aria-label','Send message');
  inputArea.appendChild(input); inputArea.appendChild(sendBtn);

  chat.appendChild(hdr);
  chat.appendChild(msgs);
  chat.appendChild(powered);
  chat.appendChild(inputArea);
  root.appendChild(chat);

  if(embedTarget){
    var mount = document.getElementById(embedTarget);
    (mount||document.body).appendChild(root);
  } else {
    document.body.appendChild(root);
  }

  // Trigger button (floating only)
  if(!embedTarget){
    var trigger = document.createElement('button');
    trigger.id = 'bd-hotel-trigger'; trigger.innerText = 'Book a room';
    document.body.appendChild(trigger);
    trigger.onclick = function(){ chat.classList.add('open'); input.focus(); showWelcome(); };
    closeBtn.onclick = function(){ chat.classList.remove('open'); };
  } else {
    chat.classList.add('open'); showWelcome();
  }

  // ── Welcome card ────────────────────────────────────────────────────────
  var welcomeShown = false;
  function showWelcome(){
    if(welcomeShown) return; welcomeShown = true;
    var card = document.createElement('div'); card.className = 'bd-welcome';

    var ey = document.createElement('div'); ey.className = 'bd-eyebrow'; ey.innerText = 'Your personal concierge';
    var tt = document.createElement('div'); tt.className = 'bd-welcome-title'; tt.innerText = 'Welcome to '+hotelName;
    var bd = document.createElement('div'); bd.className = 'bd-welcome-body';
    bd.innerText = "Tell me the occasion, your preferred dates, and how many guests — I'll find the perfect room.";
    var dv = document.createElement('div'); dv.className = 'bd-divider';
    var pl = document.createElement('div'); pl.className = 'bd-prompts-label'; pl.innerText = 'Popular requests';

    var starters = [
      {title:'Honeymoon stay',   text:"We're honeymooners — what's your most romantic room for 5 nights?"},
      {title:'Family holiday',   text:'Family room for 2 adults and 2 children, full board, arriving next weekend.'},
      {title:'Business trip',    text:'Single business room for tomorrow night, early check-in if possible.'},
    ];
    card.appendChild(ey); card.appendChild(tt); card.appendChild(bd);
    card.appendChild(dv); card.appendChild(pl);
    starters.forEach(function(s){
      var btn = document.createElement('button'); btn.className = 'bd-starter';
      var t = document.createElement('div'); t.className = 'bd-st-title'; t.innerText = s.title;
      var b = document.createElement('div'); b.className = 'bd-st-body'; b.innerText = s.text;
      btn.appendChild(t); btn.appendChild(b);
      btn.onclick = function(){ input.value = s.text; send(); };
      card.appendChild(btn);
    });
    msgs.appendChild(card); msgs.scrollTop = msgs.scrollHeight;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function addMsg(text, type){
    var d = document.createElement('div');
    d.className = 'bd-msg '+(type==='user'?'bd-user':'bd-bot');
    d.innerText = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  function showTyping(){
    var d = document.createElement('div'); d.className = 'bd-typing'; d.id = 'bd-typing';
    d.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight;
  }
  function hideTyping(){ var t = document.getElementById('bd-typing'); if(t) t.remove(); }

  function fmtPrice(n, cur){ return (cur||'KES')+' '+Math.round(Number(n)||0).toLocaleString(); }

  function mealLabel(key){ return MEAL_LABELS[key]||key||''; }

  // ── Room card ────────────────────────────────────────────────────────────
  function addRoomCard(p, idx){
    var hotel   = p.hotel||{};
    var summary = p.summary||{};
    var currency= hotel.currency||summary.currency||'KES';
    var nights  = hotel.nights||summary.nights||1;
    var total   = hotel.totalRate||(hotel.pricePerNight*nights)||summary.totalPrice||0;
    var perNight= hotel.pricePerNight||0;

    var wrap = document.createElement('div'); wrap.className = 'bd-pkg';

    // ── Image zone
    var imgZone = document.createElement('div'); imgZone.className = 'bd-pkg-img';
    var images = hotel.images||[];
    if(images.length>0){
      var img = document.createElement('img');
      img.src = images[0]; img.alt = hotel.roomType||'Room';
      img.onerror = function(){ this.style.display='none'; };
      imgZone.appendChild(img);
    } else {
      var ph = document.createElement('div'); ph.className = 'bd-pkg-img-placeholder';
      ph.innerText = '🛏'; imgZone.appendChild(ph);
    }
    if(hotel.priceMatchApplied){
      var badge = document.createElement('div'); badge.className = 'bd-pkg-badge';
      badge.innerText = 'Price matched'; imgZone.appendChild(badge);
    } else if(idx===0){
      var badge = document.createElement('div'); badge.className = 'bd-pkg-badge';
      badge.innerText = 'Best value'; imgZone.appendChild(badge);
    }
    wrap.appendChild(imgZone);

    // ── Card body
    var body = document.createElement('div'); body.className = 'bd-pkg-body';

    var nameEl = document.createElement('div'); nameEl.className = 'bd-pkg-name';
    var stars  = hotel.stars ? Array(Math.min(Math.round(hotel.stars),5)+1).join('★') : '';
    nameEl.innerText = (hotel.roomType||hotel.name||'Room')+(stars?' '+stars:'');

    var meta = document.createElement('div'); meta.className = 'bd-pkg-meta';
    meta.innerText = (hotel.checkIn||'')+(hotel.checkOut?' → '+hotel.checkOut:'')+' · '+nights+' night'+(nights!==1?'s':'')+' · '+(summary.passengers||hotel.adults||1)+' guest'+(( summary.passengers||1)!==1?'s':'');

    body.appendChild(nameEl); body.appendChild(meta);

    // Tags (bed type, view, amenities)
    var tags = [];
    if(hotel.bedType)  tags.push(hotel.bedType);
    if(hotel.view)     tags.push(hotel.view+' view');
    (hotel.amenities||[]).slice(0,3).forEach(function(a){ tags.push(a); });
    if(tags.length){
      var tagRow = document.createElement('div'); tagRow.className = 'bd-tags';
      tags.forEach(function(t){
        var tg = document.createElement('span'); tg.className = 'bd-tag'; tg.innerText = t;
        tagRow.appendChild(tg);
      });
      body.appendChild(tagRow);
    }

    // Meal plan
    if(hotel.mealPlan){
      var ml = document.createElement('div'); ml.className = 'bd-meal';
      ml.innerText = '🍽 '+mealLabel(hotel.mealPlan); body.appendChild(ml);
    }

    // Cancellation policy
    var canEl = document.createElement('div');
    if(hotel.isRefundable===true){ canEl.className='bd-cancel bd-cancel-ok'; canEl.innerHTML='<span class="bd-cancel-icon">✓</span>'+(hotel.policySummary||'Free cancellation available'); }
    else if(hotel.isRefundable===false){ canEl.className='bd-cancel bd-cancel-no'; canEl.innerHTML='<span class="bd-cancel-icon">✕</span>'+(hotel.policySummary||'Non-refundable'); }
    else{ canEl.className='bd-cancel bd-cancel-neutral'; canEl.innerText = hotel.policySummary||'Cancellation policy confirmed at booking'; }
    body.appendChild(canEl);

    // Price match saving
    if(hotel.priceMatchApplied && hotel.priceMatchSaving){
      var pm = document.createElement('div'); pm.className = 'bd-price-match';
      pm.innerHTML = '✓ Saving '+currency+' '+Math.round(hotel.priceMatchSaving).toLocaleString()+'/night vs '+hotel.priceMatchOta;
      body.appendChild(pm);
    }

    // Alternate rates switcher
    var availRates = hotel.availableRates||[];
    if(availRates.length>1){
      var ratesEl = document.createElement('div'); ratesEl.className = 'bd-rates';
      var rLbl = document.createElement('div'); rLbl.className = 'bd-rates-label'; rLbl.innerText = 'Other meal plans';
      ratesEl.appendChild(rLbl);
      availRates.forEach(function(r, ri){
        var row = document.createElement('div'); row.className = 'bd-rate-row'+(ri===0?' active':'');
        var ml2 = document.createElement('div'); ml2.className = 'bd-rate-meal'; ml2.innerText = mealLabel(r.mealPlan);
        var rp  = document.createElement('div'); rp.className = 'bd-rate-price'; rp.innerText = currency+' '+Math.round(r.pricePerNight).toLocaleString()+'/night';
        if(!r.isRefundable){ var rb=document.createElement('span');rb.className='bd-rate-badge';rb.innerText='Non-refundable';rp.appendChild(rb); }
        row.appendChild(ml2); row.appendChild(rp);
        row.onclick = function(){
          ratesEl.querySelectorAll('.bd-rate-row').forEach(function(x){x.classList.remove('active');});
          row.classList.add('active');
          priceMain.innerText = currency+' '+Math.round(r.pricePerNight*nights).toLocaleString();
          priceSub.innerText  = currency+' '+Math.round(r.pricePerNight).toLocaleString()+'/night';
          // Update the package ref for reservation
          p.hotel.ratePlanId    = r.ratePlanId;
          p.hotel.pricePerNight = r.pricePerNight;
          p.hotel.totalRate     = r.pricePerNight * nights;
          p.hotel.mealPlan      = r.mealPlan;
          p.hotel.isRefundable  = r.isRefundable;
          canEl.className       = r.isRefundable===false?'bd-cancel bd-cancel-no':'bd-cancel bd-cancel-ok';
          canEl.innerText       = r.isRefundable===false?'✕ Non-refundable':'✓ Flexible cancellation';
        };
        ratesEl.appendChild(row);
      });
      body.appendChild(ratesEl);
    }

    wrap.appendChild(body);

    // ── Footer
    var footer = document.createElement('div'); footer.className = 'bd-pkg-footer';
    var priceWrap = document.createElement('div');
    var priceMain = document.createElement('div'); priceMain.className = 'bd-pkg-price-main';
    priceMain.innerText = fmtPrice(total, currency);
    var priceSub = document.createElement('div'); priceSub.className = 'bd-pkg-price-sub';
    priceSub.innerText = fmtPrice(perNight, currency)+'/night';
    priceWrap.appendChild(priceMain); priceWrap.appendChild(priceSub);

    var reserveBtn = document.createElement('button'); reserveBtn.className = 'bd-reserve-btn';
    reserveBtn.innerText = 'Reserve';
    reserveBtn.onclick = function(){
      reserveBtn.innerText = 'Selected ✓';
      reserveBtn.classList.add('selected');
      reserveBtn.disabled = true;
      loadUpsellsThenForm(p, currency, total, wrap);
    };

    footer.appendChild(priceWrap); footer.appendChild(reserveBtn);
    wrap.appendChild(footer);

    msgs.appendChild(wrap);
    return wrap;
  }

  // ── Upsells + guest form ─────────────────────────────────────────────────
  function loadUpsellsThenForm(p, currency, total, cardEl){
    fetch(apiBase+'/api/hotel/upsells',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-hotel-key':groupSlug},
      body: JSON.stringify({ packageId:p.packageId, selectedPackage:p, tripParams:previousParams||{} }),
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      var upsells = data.upsells||[];
      if(upsells.length){
        var sec = document.createElement('div'); sec.className = 'bd-upsell-section';
        var lbl = document.createElement('div'); lbl.className = 'bd-upsell-label'; lbl.innerText = 'Add to your stay';
        sec.appendChild(lbl);
        var selectedUpsells = [];
        upsells.forEach(function(u){
          var uc = document.createElement('div'); uc.className = 'bd-upsell-card';
          var uLeft = document.createElement('div');
          if(u.badge){ var ub=document.createElement('div');ub.className='bd-upsell-badge';ub.innerText=u.badge;uLeft.appendChild(ub); }
          var un = document.createElement('div'); un.className = 'bd-upsell-name'; un.innerText = u.name;
          var ud = document.createElement('div'); ud.className = 'bd-upsell-desc'; ud.innerText = u.description||'';
          uLeft.appendChild(un); uLeft.appendChild(ud);
          var uRight = document.createElement('div'); uRight.style.cssText='text-align:right;flex-shrink:0;';
          var up = document.createElement('div'); up.className = 'bd-upsell-price';
          up.innerText = (u.currency||currency)+' '+Math.round(u.price).toLocaleString()+(u.priceBasis==='per_person'?'/person':u.priceBasis==='per_night'?'/night':'');
          var ua = document.createElement('button'); ua.className = 'bd-upsell-add'; ua.innerText = '+ Add';
          ua.onclick = function(){
            if(ua.classList.contains('added')){ return; }
            ua.classList.add('added'); ua.innerText = '✓ Added';
            selectedUpsells.push(u);
            total += u.priceBasis==='per_person'
              ? u.price*(previousParams&&previousParams.adults||1)
              : u.priceBasis==='per_night' ? u.price*(p.hotel.nights||1) : u.price;
          };
          uRight.appendChild(up); uRight.appendChild(ua);
          uc.appendChild(uLeft); uc.appendChild(uRight);
          sec.appendChild(uc);
        });
        msgs.appendChild(sec);
      }
      showGuestForm(p, currency, total);
      msgs.scrollTop = msgs.scrollHeight;
    })
    .catch(function(){
      showGuestForm(p, currency, total);
    });
  }

  // ── Guest form ────────────────────────────────────────────────────────────
  function showGuestForm(p, currency, total){
    var ex = document.getElementById('bd-hotel-form'); if(ex) ex.remove();
    var form = document.createElement('div'); form.className = 'bd-form'; form.id = 'bd-hotel-form';

    var ft = document.createElement('div'); ft.className = 'bd-form-title'; ft.innerText = 'Complete your reservation'; form.appendChild(ft);

    var ni = document.createElement('input'); ni.className = 'bd-input'; ni.placeholder = 'Full name'; ni.type = 'text'; form.appendChild(ni);
    var pi = document.createElement('input'); pi.className = 'bd-input'; pi.placeholder = 'Phone number'; pi.type = 'tel'; form.appendChild(pi);
    var ei = document.createElement('input'); ei.className = 'bd-input'; ei.placeholder = 'Email — voucher will be sent here'; ei.type = 'email'; form.appendChild(ei);
    var ri = document.createElement('textarea'); ri.className = 'bd-input bd-textarea'; ri.placeholder = 'Special requests (optional)'; form.appendChild(ri);

    var err = document.createElement('div'); err.className = 'bd-err'; form.appendChild(err);

    var cb = document.createElement('button'); cb.className = 'bd-confirm-btn';
    cb.innerText = 'Confirm reservation — '+fmtPrice(total, currency);
    cb.onclick = function(){
      err.style.display = 'none';
      var name = ni.value.trim(), phone = pi.value.trim();
      if(!name){ err.innerText = 'Please enter your name.'; err.style.display='block'; return; }
      if(!phone){ err.innerText = 'Please enter your phone number.'; err.style.display='block'; return; }
      cb.innerText = 'Processing…'; cb.disabled = true;
      fetch(apiBase+'/api/hotel/reserve',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-hotel-key':groupSlug},
        body: JSON.stringify({
          groupSlug, pkg:p,
          guestName:ni.value.trim(), guestPhone:pi.value.trim(),
          guestEmail:ei.value.trim()||null,
          specialRequests:ri.value.trim()||null,
          channel:'widget',
        }),
      })
      .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,data:d}; }); })
      .then(function(res){
        if(!res.ok||!res.data.success){
          err.innerText = (res.data&&res.data.error)||'Reservation failed. Please try again.';
          err.style.display='block'; cb.innerText='Confirm reservation'; cb.disabled=false; return;
        }
        form.remove();
        addMsg('Reservation '+res.data.reservationRef+' confirmed. '+fmtPrice(total,currency)+' due at check-in. Your voucher has been sent.','bot');
      })
      .catch(function(){
        err.innerText = 'Network error. Please try again.';
        err.style.display='block'; cb.innerText='Confirm reservation'; cb.disabled=false;
      });
    };
    form.appendChild(cb);
    msgs.appendChild(form); msgs.scrollTop = msgs.scrollHeight;
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  function send(){
    var text = input.value.trim(); if(!text) return;
    addMsg(text,'user'); input.value=''; showTyping();

    fetch(apiBase+'/api/hotel/orchestrate',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-hotel-key':groupSlug},
      body: JSON.stringify({
        prompt:text, groupSlug, sessionId,
        conversationHistory, previousParams,
      }),
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      hideTyping();
      if(data.sessionId)           sessionId           = data.sessionId;
      if(data.tripParams)          previousParams      = data.tripParams;
      if(data.conversationHistory) conversationHistory = data.conversationHistory;

      var pkgs = data.packages||[];
      if(data.needsClarification||!pkgs.length){
        addMsg(data.text||"Could you share a bit more — dates and how many guests?", 'bot');
        return;
      }
      addMsg(data.text||"Here's what we have available:",'bot');
      pkgs.forEach(function(p,i){ addRoomCard(p, i); });
      msgs.scrollTop = msgs.scrollHeight;
    })
    .catch(function(e){
      hideTyping();
      console.error('[BODRLESS hotel]',e);
      addMsg('Unable to load options right now. Please try again.','bot');
    });
  }

  sendBtn.onclick = send;
  input.addEventListener('keypress', function(e){ if(e.key==='Enter') send(); });
  console.log('[BODRLESS] Hotel widget v2 loaded — group:'+groupSlug);
}

if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded',initHotelWidget); }
else { initHotelWidget(); }
})();`;

  res.send(widgetCode);
});

module.exports = router;