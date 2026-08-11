const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  const mode        = req.query.mode  || 'agency';
  const isHotelMode = mode === 'hotel_direct';
  const agencyKey   = req.query.key   || (isHotelMode ? 'sarova' : 'epic-travels');
  const agencyName  = req.query.name  || (isHotelMode ? 'Sarova Hotels' : 'Epic Travels');
  const embedTarget = req.query.embed || null;
  const apiBase     = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';

  // Permanent fix: reject hotel_direct requests with no key or an unknown-looking key
  // This surfaces a clear error instead of silently using the wrong hotel group
  if (isHotelMode && !req.query.key) {
    console.warn('[BODRLESS] hotel_direct widget loaded without ?key= — defaulting to sarova');
  }

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  // ── STYLES ──────────────────────────────────────────────────────────────
  const styles = `
:root{--et-navy:#1E2A5E;--et-red:#C0392B;--et-white:#FFFFFF;--et-cream:#F9F7F4;--et-border:#E8E3DA;--et-muted:#9A9088;--et-green:#27ae60;--et-gold:#B8964A;}
#bodrless-chat{background:var(--et-white);z-index:999999;display:none;flex-direction:column;border-radius:18px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.14);font-family:'Inter',Arial,sans-serif;}
#bodrless-chat.open{display:flex;}
#bodrless-chat.floating{position:fixed;bottom:90px;right:24px;width:390px;height:640px;}
#bodrless-chat.embedded{position:relative;width:100%;height:760px;display:flex;border-radius:0;}
@keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:0.5;}30%{transform:translateY(-5px);opacity:1;}}
#et-header{background:var(--et-navy);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
#et-header-left{display:flex;align-items:center;gap:12px;}
#et-header-text h3{font-size:14px;color:white;margin:0 0 1px 0;font-weight:600;}
#et-header-text p{font-size:10px;color:rgba(255,255,255,0.5);margin:0;letter-spacing:1px;text-transform:uppercase;}
#et-close{background:rgba(255,255,255,0.08);border:none;color:rgba(255,255,255,0.7);width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;}
#et-close:hover{background:rgba(255,255,255,0.18);}
#bodrless-messages{flex:1;padding:20px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:12px;background:var(--et-cream);}
.msg{padding:11px 15px;border-radius:16px;max-width:82%;font-size:13.5px;line-height:1.55;}
.user{background:var(--et-navy);color:white;margin-left:auto;border-bottom-right-radius:4px;}
.bot{background:var(--et-white);color:#2A2A2A;border:1px solid var(--et-border);border-bottom-left-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,0.05);}
.typing{background:var(--et-white);border:1px solid var(--et-border);padding:12px 16px;border-radius:16px;display:flex;gap:5px;align-items:center;width:fit-content;}
.typing span{width:6px;height:6px;background:var(--et-navy);border-radius:50%;animation:bounce 1.2s infinite;}
.typing span:nth-child(2){animation-delay:0.2s;background:var(--et-gold);}
.typing span:nth-child(3){animation-delay:0.4s;}
.et-welcome{background:var(--et-white);border-radius:14px;padding:20px;border:1px solid var(--et-border);}
.et-welcome-eyebrow{font-size:10px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:var(--et-gold);margin-bottom:10px;}
.et-welcome-title{font-size:18px;font-weight:600;color:var(--et-navy);margin-bottom:8px;line-height:1.3;}
.et-welcome-body{font-size:13px;color:#5A5A5A;line-height:1.65;margin-bottom:18px;}
.et-divider{height:1px;background:var(--et-border);margin:4px 0 16px 0;}
.et-prompts-label{font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--et-muted);margin-bottom:12px;}
.et-starter{width:100%;background:var(--et-cream);border:1px solid var(--et-border);border-radius:12px;padding:14px 16px;text-align:left;cursor:pointer;transition:all 0.2s;margin-bottom:8px;display:block;}
.et-starter:hover{background:var(--et-navy);border-color:var(--et-navy);}
.et-starter:hover .st-title,.et-starter:hover .st-body{color:white;}
.et-starter:hover .st-body{color:rgba(255,255,255,0.7);}
.st-title{font-size:13px;font-weight:600;color:var(--et-navy);margin-bottom:3px;}
.st-body{font-size:12px;color:var(--et-muted);line-height:1.45;}
.et-agency-welcome{background:linear-gradient(135deg,#1E2A5E 0%,#2d3f82 100%);border-radius:16px;padding:16px;color:white;border-left:4px solid #C0392B;}
.et-agency-welcome h4{font-size:14px;margin:0 0 6px 0;}
.et-agency-welcome p{font-size:12px;margin:0 0 12px 0;color:rgba(255,255,255,0.7);}
.et-suggestions{display:flex;flex-wrap:wrap;gap:6px;}
.et-suggestion{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.9);padding:5px 10px;border-radius:20px;font-size:11px;cursor:pointer;}
.leg-section{border:1px solid var(--et-border);border-radius:14px;overflow:hidden;margin-bottom:12px;background:var(--et-white);box-shadow:0 2px 8px rgba(0,0,0,0.05);}
.leg-header{padding:10px 14px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;}
.leg-header.arrival{background:#1E2A5E;}.leg-header.departure{background:#2d3f82;}.leg-header.internal{background:#34495e;}.leg-header.return_stay{background:#2c3e50;}.leg-header.stopover{background:#7f8c8d;}
.leg-header-left{display:flex;align-items:center;gap:10px;}
.leg-icon{font-size:16px;}
.leg-title{font-size:13px;font-weight:700;color:white;}
.leg-subtitle{font-size:10px;color:rgba(255,255,255,0.65);margin-top:1px;}
.leg-status{font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;}
.leg-status.locked{background:var(--et-green);color:white;}.leg-status.active{background:var(--et-gold);color:white;}.leg-status.pending{background:rgba(255,255,255,0.15);color:rgba(255,255,255,0.7);}
.leg-selected-summary{padding:10px 14px;background:#f0f4ff;border-bottom:1px solid var(--et-border);display:flex;align-items:center;justify-content:space-between;}
.leg-selected-detail{font-size:12px;color:var(--et-navy);font-weight:500;flex:1;}
.leg-change-btn{font-size:11px;color:var(--et-gold);font-weight:600;cursor:pointer;border:none;background:none;padding:4px 8px;border-radius:8px;flex-shrink:0;}
.leg-change-btn:hover{background:rgba(184,150,74,0.1);}
.leg-body{padding:0;}.leg-body.collapsed{display:none;}
.upsell-section{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;overflow:hidden;margin-top:8px;}
.upsell-section-header{background:linear-gradient(135deg,#1E2A5E,#2d3f82);padding:12px 16px;}
.upsell-section-title{color:white;font-size:13px;font-weight:700;margin-bottom:2px;}
.upsell-section-sub{color:rgba(255,255,255,0.65);font-size:11px;}
.upsell-grid{padding:12px;display:flex;flex-direction:column;gap:8px;}
.upsell-card{border:1px solid var(--et-border);border-radius:12px;padding:12px;background:var(--et-cream);display:flex;align-items:center;justify-content:space-between;gap:10px;}
.upsell-card.selected{border-color:var(--et-green);background:#E8F8EE;}
.upsell-card-left{flex:1;}
.upsell-badge{font-size:10px;font-weight:700;color:var(--et-gold);letter-spacing:0.5px;margin-bottom:4px;text-transform:uppercase;}
.upsell-name{font-size:13px;font-weight:600;color:var(--et-navy);margin-bottom:2px;}
.upsell-desc{font-size:11px;color:var(--et-muted);line-height:1.4;}
.upsell-price{font-size:12px;font-weight:700;color:var(--et-navy);margin-top:4px;}
.upsell-add-btn{background:var(--et-navy);color:white;border:none;padding:7px 14px;border-radius:20px;cursor:pointer;font-size:11px;font-weight:600;flex-shrink:0;transition:all 0.2s;}
.upsell-add-btn:hover{background:var(--et-gold);}
.upsell-add-btn.added{background:var(--et-green);}
.upsell-add-btn.removed{background:var(--et-cream);color:var(--et-navy);border:1.5px solid var(--et-border);}
.transfer-prompt{background:var(--et-white);border:1px solid var(--et-gold);border-radius:14px;padding:14px 16px;margin-top:8px;}
.transfer-prompt h4{font-size:13px;font-weight:700;color:var(--et-navy);margin:0 0 6px 0;}
.transfer-prompt p{font-size:12px;color:var(--et-muted);margin:0 0 10px 0;}
.transfer-options{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;}
.transfer-option{padding:6px 12px;border-radius:20px;border:1.5px solid var(--et-border);background:var(--et-cream);font-size:12px;cursor:pointer;color:var(--et-navy);transition:all 0.2s;}
.transfer-option.selected{background:var(--et-navy);color:white;border-color:var(--et-navy);}
.transfer-confirm-btn{background:var(--et-gold);color:white;border:none;padding:9px 20px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;width:100%;}
.transfer-skip{display:block;text-align:center;font-size:11px;color:var(--et-muted);cursor:pointer;margin-top:8px;background:none;border:none;width:100%;}
.multi-prop-bar{background:var(--et-navy);border-radius:14px;padding:12px 16px;margin-bottom:8px;position:sticky;top:0;z-index:10;}
.multi-prop-bar-title{color:white;font-size:12px;font-weight:700;margin-bottom:8px;}
.multi-prop-slots{display:flex;gap:8px;flex-wrap:wrap;}
.multi-prop-slot{flex:1;min-width:120px;background:rgba(255,255,255,0.08);border:1.5px solid rgba(255,255,255,0.2);border-radius:10px;padding:8px 10px;}
.multi-prop-slot.done{background:rgba(39,174,96,0.2);border-color:var(--et-green);}
.multi-prop-slot-name{font-size:10px;color:rgba(255,255,255,0.6);margin-bottom:3px;}
.multi-prop-slot-status{font-size:12px;font-weight:600;color:white;}
.multi-prop-slot.done .multi-prop-slot-status{color:#6ee8a0;}
.multi-prop-checkout-btn{width:100%;margin-top:10px;padding:11px;border-radius:20px;background:var(--et-gold);color:white;border:none;font-size:13px;font-weight:700;cursor:pointer;display:none;transition:all 0.2s;}
.multi-prop-checkout-btn.visible{display:block;}
.multi-prop-checkout-btn:hover{opacity:0.88;}
.package{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;overflow:visible;box-shadow:0 2px 12px rgba(0,0,0,0.06);margin-bottom:8px;}
.pkg-header{background:var(--et-navy);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-radius:14px 14px 0 0;}
.pkg-title{color:white;font-size:13px;font-weight:600;}
.pkg-route{background:rgba(255,255,255,0.15);color:white;font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pkg-body{padding:12px 14px;}
.pkg-row{display:flex;flex-direction:column;padding:8px 0;border-bottom:1px solid var(--et-border);}
.pkg-row:last-child{border-bottom:none;}
.pkg-label{font-size:10px;font-weight:700;color:var(--et-gold);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;}
.pkg-name{font-size:13px;font-weight:600;color:var(--et-navy);margin-bottom:2px;}
.pkg-sub{font-size:11px;color:var(--et-muted);line-height:1.4;}
.pkg-footer{padding:10px 14px;background:#FAFAF8;display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--et-border);border-radius:0 0 14px 14px;}
.pkg-price{font-size:20px;font-weight:700;color:var(--et-navy);line-height:1;}
.pkg-price small{font-size:10px;color:var(--et-muted);display:block;font-weight:400;margin-top:2px;}
.select-btn{background:var(--et-gold);color:white;border:none;padding:10px 20px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;transition:opacity 0.2s;}
.select-btn:hover{opacity:0.88;}.select-btn.selected{background:var(--et-green);}.select-btn:disabled{opacity:0.6;cursor:not-allowed;}
.book{background:var(--et-gold);color:white;border:none;padding:10px 20px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;letter-spacing:0.3px;transition:opacity 0.2s;}
.book:hover{opacity:0.88;}.book:disabled{opacity:0.6;cursor:not-allowed;}
.trip-summary{background:var(--et-white);border:2px solid var(--et-navy);border-radius:16px;overflow:hidden;margin-top:8px;}
.trip-summary-header{background:var(--et-navy);padding:14px 16px;}
.trip-summary-title{color:white;font-size:15px;font-weight:700;margin-bottom:2px;}
.trip-summary-sub{color:rgba(255,255,255,0.65);font-size:11px;}
.trip-summary-legs{padding:12px 16px;}
.ts-leg{padding:10px 0;border-bottom:1px solid var(--et-border);}
.ts-leg:last-child{border-bottom:none;}
.ts-leg-label{font-size:11px;font-weight:700;color:var(--et-gold);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;}
.ts-leg-detail{font-size:13px;color:var(--et-navy);font-weight:600;margin-bottom:2px;}
.ts-leg-sub{font-size:11px;color:var(--et-muted);}
.ts-leg-price{font-size:13px;font-weight:700;color:var(--et-navy);margin-top:4px;}
.trip-summary-total{padding:12px 16px;background:#f0f4ff;border-top:2px solid var(--et-navy);}
.ts-total-price{font-size:22px;font-weight:700;color:var(--et-navy);}
.ts-total-sub{font-size:11px;color:var(--et-muted);margin-top:2px;}
.deposit-breakdown{background:var(--et-cream);border-radius:10px;padding:12px;margin:10px 0;}
.deposit-row{display:flex;justify-content:space-between;font-size:12px;padding:3px 0;color:#3A3A3A;}
.deposit-row.total{font-weight:700;color:var(--et-navy);font-size:13px;border-top:1px solid var(--et-border);margin-top:6px;padding-top:8px;}
.deposit-row.balance{color:var(--et-muted);}
.summary-actions{padding:12px 16px;display:flex;flex-direction:column;gap:8px;}
.summary-action-btn{width:100%;padding:12px 16px;border-radius:20px;cursor:pointer;font-size:13px;font-weight:600;border:none;transition:all 0.2s;}
.summary-action-btn.primary{background:var(--et-navy);color:white;}
.summary-action-btn.primary:hover{background:var(--et-gold);}
.summary-action-btn.secondary{background:var(--et-cream);color:var(--et-navy);border:1.5px solid var(--et-border);}
.summary-action-btn.secondary:hover{background:var(--et-navy);color:white;border-color:var(--et-navy);}
.restore-banner{background:linear-gradient(135deg,#1E2A5E,#2d3f82);border-radius:14px;padding:14px 16px;color:white;}
.restore-banner h4{font-size:14px;font-weight:700;margin:0 0 6px 0;}
.restore-banner p{font-size:12px;color:rgba(255,255,255,0.75);margin:0 0 12px 0;line-height:1.5;}
.restore-banner-actions{display:flex;gap:8px;}
.restore-btn{flex:1;padding:9px 12px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:none;}
.restore-btn.yes{background:var(--et-gold);color:white;}.restore-btn.no{background:rgba(255,255,255,0.12);color:white;border:1px solid rgba(255,255,255,0.25);}
.price-nudge{border-radius:10px;padding:10px 12px;margin:4px 0;font-size:12px;line-height:1.5;}
.price-nudge.down{background:#E8F8EE;color:#1B7A3D;border:1px solid #A8D8B8;}
.price-nudge.up{background:#FFF8EC;color:#B05A00;border:1px solid #E8C96D;}
.cancel-policy{display:flex;align-items:center;gap:6px;font-size:11px;padding:8px 10px;border-radius:8px;margin-top:4px;}
.cancel-policy.refundable{background:#E8F8EE;color:#1B7A3D;}.cancel-policy.non-refundable{background:#FFF0F0;color:#A02020;}.cancel-policy.neutral{background:#F0EDE8;color:#5A4A3A;}
.hl{padding:7px 10px;border-radius:8px;font-size:11px;font-weight:600;margin-top:6px;}
.hl-good{background:#E8F8EE;color:#1B7A3D;}.hl-warn{background:#FFF3E0;color:#B05A00;}.hl-neutral{background:#F0EDE8;color:#5A4A3A;}
#bodrless-input-area{display:flex;border-top:1px solid var(--et-border);background:var(--et-white);padding:12px;gap:8px;flex-shrink:0;}
#bodrless-input{flex:1;padding:10px 14px;border:1.5px solid var(--et-border);border-radius:20px;outline:none;font-size:13px;background:var(--et-cream);color:#2A2A2A;font-family:'Inter',Arial,sans-serif;}
#bodrless-input:focus{border-color:var(--et-navy);}
#bodrless-input::placeholder{color:var(--et-muted);font-size:12px;}
#bodrless-send{background:var(--et-navy);color:white;border:none;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 0.2s;}
#bodrless-send:hover{background:var(--et-gold);}
.name-form{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;padding:16px;margin-top:8px;}
.name-form p{font-size:12px;color:var(--et-navy);margin:0 0 12px 0;font-weight:500;}
.name-input{width:100%;padding:9px 12px;border:1.5px solid var(--et-border);border-radius:10px;outline:none;font-size:12px;color:#2A2A2A;box-sizing:border-box;margin-bottom:10px;font-family:'Inter',Arial,sans-serif;background:var(--et-cream);}
.name-input:focus{border-color:var(--et-navy);}
.dob-row{display:flex;gap:6px;margin-bottom:10px;}
.dob-row select{flex:1;padding:9px 4px;border:1.5px solid var(--et-border);border-radius:10px;outline:none;font-size:12px;color:#2A2A2A;background:white;}
.field-label{font-size:10px;color:var(--et-muted);margin-bottom:4px;font-weight:600;letter-spacing:0.3px;}
.confirm-btn{background:var(--et-navy);color:white;border:none;padding:11px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;width:100%;transition:background 0.2s;}
.confirm-btn:hover{background:var(--et-gold);}
.trust-badge{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:10px;font-size:10px;color:var(--et-muted);}
.price-alert{background:#FFF8EC;border:1px solid #E8C96D;border-radius:12px;padding:12px;margin-top:8px;}
.price-alert p{font-size:12px;color:#5A4A1A;margin:0 0 10px 0;line-height:1.5;}
.price-alert-actions{display:flex;gap:8px;}
.price-approve{flex:1;background:var(--et-navy);color:white;border:none;padding:9px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;}
.price-cancel{flex:1;background:white;color:var(--et-navy);border:1.5px solid var(--et-border);padding:9px 14px;border-radius:20px;cursor:pointer;font-size:12px;}
.bodrless-powered{text-align:center;padding:8px 0 4px;font-size:10px;color:var(--et-muted);letter-spacing:0.5px;}
.bodrless-powered a{color:var(--et-muted);text-decoration:none;font-weight:600;}
.bodrless-powered a:hover{color:var(--et-navy);}
`;

  const widgetCode = `(function () {
function initWidget() {
  if (!document.body) { setTimeout(initWidget, 50); return; }
  if (document.getElementById('bodrless-widget-root')) return;

  var conversationHistory = [];
  var previousParams      = null;
  var sessionId           = null;
  var isHotelMode         = ${String(isHotelMode)};
  var embedTarget         = ${JSON.stringify(embedTarget)};
  var agencyKey           = '${agencyKey}';
  var apiBase             = '${apiBase}';
  var legFlow             = null;
  var itineraryId         = null;
  var pendingRestoreId    = null;
  var transcript          = [];
  var hasRestoredHistory  = false;

  // ── PERMANENT FIX: validate hotel key on load ─────────────────────────
  // Each hotel embed MUST pass ?key=<slug>&mode=hotel_direct in the script URL.
  // Example for Sarova:   <script src="...widget.js?key=sarova&mode=hotel_direct"></script>
  // Example for PrideInn: <script src="...widget.js?key=prideinn&mode=hotel_direct"></script>
  // If key is missing the widget will warn in console and use the server-side default.
  if (isHotelMode) {
    console.log('[BODRLESS] Hotel widget loaded — group: ' + agencyKey);
  }

  var hotelSelections     = {};
  var hotelLegMeta        = null;
  var selectedUpsells     = {};

  var STORAGE_KEY = 'bodrless_widget_' + agencyKey;

  function persistState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: 2, savedAt: Date.now(),
        transcript: transcript.slice(-20),
        conversationHistory, previousParams, sessionId,
        legFlow, itineraryId,
      }));
    } catch(e) {}
  }

  function loadPersistedState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || p.v !== 2) return null;
      if (Date.now() - (p.savedAt || 0) > 24 * 60 * 60 * 1000) return null;
      return p;
    } catch(e) { return null; }
  }

  var __r = loadPersistedState();
  if (__r) {
    conversationHistory = __r.conversationHistory || [];
    previousParams      = __r.previousParams      || null;
    sessionId           = __r.sessionId           || null;
    transcript          = __r.transcript          || [];
    legFlow             = __r.legFlow             || null;
    itineraryId         = __r.itineraryId         || null;
    hasRestoredHistory  = transcript.length > 0;
  }

  var style = document.createElement('style');
  style.innerHTML = ${JSON.stringify(styles)};
  document.head.appendChild(style);

  var root    = document.createElement('div'); root.id = 'bodrless-widget-root';
  var chatDiv = document.createElement('div'); chatDiv.id = 'bodrless-chat';
  chatDiv.classList.add(embedTarget ? 'embedded' : 'floating');
  var header     = document.createElement('div'); header.id = 'et-header';
  var headerLeft = document.createElement('div'); headerLeft.id = 'et-header-left';
  var logoWrap   = document.createElement('div');
  logoWrap.style.cssText = 'display:flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:50%;background:#0F4C3A;color:#fff;font-family:Playfair Display,serif;font-size:22px;font-weight:700;box-shadow:0 6px 16px rgba(0,0,0,.18);flex-shrink:0;';
  logoWrap.innerText = '${agencyName.charAt(0)}';
  var headerText = document.createElement('div'); headerText.id = 'et-header-text';
  headerText.innerHTML = '<h3>${agencyName}</h3><p>' + (isHotelMode ? 'Concierge' : 'Travel Specialist') + '</p>';
  headerLeft.appendChild(logoWrap); headerLeft.appendChild(headerText);
  var closeBtn = document.createElement('button'); closeBtn.id = 'et-close'; closeBtn.innerHTML = '&#215;';
  if (embedTarget) closeBtn.style.display = 'none';
  header.appendChild(headerLeft); header.appendChild(closeBtn);
  var messages  = document.createElement('div'); messages.id = 'bodrless-messages';
  var poweredBy = document.createElement('div'); poweredBy.className = 'bodrless-powered';
  poweredBy.innerHTML = "Powered by <a href='https://bodrless.com' target='_blank'>Bodrless</a>";
  var inputArea = document.createElement('div'); inputArea.id = 'bodrless-input-area';
  var input     = document.createElement('input'); input.id = 'bodrless-input';
  input.placeholder = isHotelMode ? 'How can I help you plan your stay?' : 'Where would you like to go?';
  var sendBtn = document.createElement('button'); sendBtn.id = 'bodrless-send'; sendBtn.innerHTML = '&#10148;';
  inputArea.appendChild(input); inputArea.appendChild(sendBtn);
  chatDiv.appendChild(header); chatDiv.appendChild(messages); chatDiv.appendChild(poweredBy); chatDiv.appendChild(inputArea);
  root.appendChild(chatDiv);
  if (embedTarget) {
    var mount = document.getElementById(embedTarget);
    (mount || document.body).appendChild(root);
  } else { document.body.appendChild(root); }

  var welcomeShown = false;
  if (!embedTarget) {
    var triggerBtn = document.createElement('button'); triggerBtn.id = 'bodrless-trigger';
triggerBtn.innerText = isHotelMode ? 'Book a Room' : '✈️ Plan Your Trip';
triggerBtn.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1E2A5E;color:white;border:none;padding:14px 24px;border-radius:30px;cursor:pointer;font-size:15px;font-weight:600;box-shadow:0 8px 32px rgba(0,0,0,0.25);z-index:999998;font-family:Inter,Arial,sans-serif;transition:all 0.2s;letter-spacing:0.3px;';
triggerBtn.onmouseover = function(){ this.style.background='#B8964A'; this.style.transform='scale(1.04)'; };
triggerBtn.onmouseout  = function(){ this.style.background='#1E2A5E'; this.style.transform='scale(1)'; };
document.body.appendChild(triggerBtn);
triggerBtn.onclick = function() {
  triggerBtn.style.display = 'none';
  chatDiv.classList.add('open');
  input.focus();
  if (!welcomeShown) { welcomeShown = true; _initView(); }
};
closeBtn.onclick = function() {
  chatDiv.classList.remove('open');
  triggerBtn.style.display = 'block';
};
  } else { chatDiv.classList.add('open'); if (!welcomeShown) { welcomeShown = true; _initView(); } }

  function _initView() {
    if (isHotelMode) { showHotelEntry(); return; }
    if (legFlow && legFlow.legs && legFlow.legs.length > 0) { _showRestoreBanner(); }
    else if (hasRestoredHistory) { replayTranscript(); }
    else { showAgencyWelcome(); }
  }

  function addMsg(text, type) {
    var div = document.createElement('div'); div.className = 'msg ' + type;
    div.innerText = text; messages.appendChild(div); messages.scrollTop = messages.scrollHeight;
    return div;
  }
  function showTyping() { var d = document.createElement('div'); d.className = 'typing'; d.id = 'et-typing'; d.innerHTML = '<span></span><span></span><span></span>'; messages.appendChild(d); messages.scrollTop = messages.scrollHeight; }
  function hideTyping() { var t = document.getElementById('et-typing'); if (t) t.remove(); }
  function scrollToEl(el) { if (!el) return; setTimeout(function() { messages.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' }); }, 80); }
  function fmtTime(iso) { if (!iso) return 'TBC'; try { var d = new Date(iso); if (isNaN(d)) return iso; return d.toLocaleTimeString('en-KE', {hour:'2-digit',minute:'2-digit'}); } catch(e) { return iso; } }
  function fmtPrice(n, cur) { return (cur||'KES')+' '+(Math.round(Number(n)||0)).toLocaleString(); }
  function titleCase(s) { if(!s)return''; return String(s).replace(/\b\w/g, function(c){return c.toUpperCase();}); }
  function makeRow(label, name, sub) { var row = document.createElement('div'); row.className = 'pkg-row'; var l = document.createElement('div'); l.className = 'pkg-label'; l.innerText = label; var n = document.createElement('div'); n.className = 'pkg-name'; n.innerText = name; var s = document.createElement('div'); s.className = 'pkg-sub'; s.innerText = sub; row.appendChild(l); row.appendChild(n); row.appendChild(s); return row; }
  function makeHL(text, tone) { var d = document.createElement('div'); d.className = 'hl ' + (tone==='good'?'hl-good':tone==='warn'?'hl-warn':'hl-neutral'); d.innerText = text; return d; }
  function makeCancelBadge(policySummary, isRefundable) { var d = document.createElement('div'); var icon; var cls = 'cancel-policy '; if (isRefundable === true) { cls += 'refundable'; icon = '✅'; } else if (isRefundable === false) { cls += 'non-refundable'; icon = '❌'; } else { cls += 'neutral'; icon = 'ℹ️'; } d.className = cls; d.innerText = icon + '  ' + (policySummary || 'Cancellation policy confirmed at booking.'); return d; }

  function showUpsellSection(pkg, tripParams, onDone) {
    var packageId = pkg.packageId || pkg.hotel && pkg.hotel.propertyId || 'pkg';
    fetch(apiBase + '/api/hotel/upsells', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hotel-key': agencyKey },
      body: JSON.stringify({ packageId: packageId, package: pkg, tripParams: tripParams }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var upsells       = data.upsells || [];
      var transferPrompt = data.transferPrompt || null;
      if (!upsells.length && !transferPrompt) { onDone([], null); return; }
      var section = document.createElement('div'); section.className = 'upsell-section'; section.id = 'upsell-section-' + packageId;
      var hdr = document.createElement('div'); hdr.className = 'upsell-section-header';
      var ht  = document.createElement('div'); ht.className = 'upsell-section-title'; ht.innerText = '✨ Enhance your stay';
      var hs  = document.createElement('div'); hs.className = 'upsell-section-sub';
      var occasion = tripParams && tripParams.preferences && tripParams.preferences[0];
      hs.innerText = occasion ? 'Curated for your ' + occasion : 'Add these to make it memorable';
      hdr.appendChild(ht); hdr.appendChild(hs);
      section.appendChild(hdr);
      var grid = document.createElement('div'); grid.className = 'upsell-grid';
      var addedUpsells = [];
      upsells.forEach(function(u) {
        var card = document.createElement('div'); card.className = 'upsell-card';
        var left = document.createElement('div'); left.className = 'upsell-card-left';
        if (u.badge) { var badge = document.createElement('div'); badge.className = 'upsell-badge'; badge.innerText = u.badge; left.appendChild(badge); }
        var uname = document.createElement('div'); uname.className = 'upsell-name'; uname.innerText = u.name;
        var udesc = document.createElement('div'); udesc.className = 'upsell-desc'; udesc.innerText = u.description || '';
        var uprice = document.createElement('div'); uprice.className = 'upsell-price';
        uprice.innerText = fmtPrice(u.price, u.currency) + (u.priceBasis === 'per_person' ? '/person' : u.priceBasis === 'per_night' ? '/night' : '');
        left.appendChild(uname); left.appendChild(udesc); left.appendChild(uprice);
        var addBtn = document.createElement('button'); addBtn.className = 'upsell-add-btn'; addBtn.innerText = '+ Add';
        var isAdded = false;
        addBtn.onclick = function() {
          isAdded = !isAdded;
          if (isAdded) { addBtn.innerText = '✓ Added'; addBtn.className = 'upsell-add-btn added'; card.classList.add('selected'); addedUpsells.push(u.id); }
          else { addBtn.innerText = '+ Add'; addBtn.className = 'upsell-add-btn'; card.classList.remove('selected'); addedUpsells = addedUpsells.filter(function(id) { return id !== u.id; }); }
        };
        card.appendChild(left); card.appendChild(addBtn);
        grid.appendChild(card);
      });
      section.appendChild(grid);
      var selectedPickup = null;
      if (transferPrompt) {
        var tp = document.createElement('div'); tp.className = 'transfer-prompt';
        var th = document.createElement('h4'); th.innerText = '🚗 ' + transferPrompt.question;
        var tps = document.createElement('p'); tps.innerText = transferPrompt.followUp || 'Where will you be arriving from?';
        var topts = document.createElement('div'); topts.className = 'transfer-options';
        var selectedOptBtn = null;
        transferPrompt.options.forEach(function(opt) {
          var ob = document.createElement('div'); ob.className = 'transfer-option';
          ob.innerText = opt;
          ob.onclick = function() { if (selectedOptBtn) selectedOptBtn.classList.remove('selected'); ob.classList.add('selected'); selectedOptBtn = ob; selectedPickup = opt !== 'No transfer needed' ? opt : null; };
          topts.appendChild(ob);
        });
        var tcBtn = document.createElement('button'); tcBtn.className = 'transfer-confirm-btn';
        tcBtn.innerText = 'Confirm transfer preference';
        tcBtn.onclick = function() { tp.style.display = 'none'; if (selectedPickup) { var note = document.createElement('div'); note.style.cssText = 'background:#E8F8EE;border-radius:10px;padding:10px 12px;font-size:12px;color:#1B7A3D;margin-top:8px;'; note.innerText = '✅ Transfer from ' + selectedPickup + ' added.'; section.appendChild(note); } _showUpsellContinueBtn(section, addedUpsells, selectedPickup, transferPrompt, onDone); };
        var skipBtn = document.createElement('button'); skipBtn.className = 'transfer-skip';
        skipBtn.innerText = 'Skip transfer';
        skipBtn.onclick = function() { tp.style.display = 'none'; _showUpsellContinueBtn(section, addedUpsells, null, null, onDone); };
        tp.appendChild(th); tp.appendChild(tps); tp.appendChild(topts); tp.appendChild(tcBtn); tp.appendChild(skipBtn);
        section.appendChild(tp);
      } else {
        _showUpsellContinueBtn(section, addedUpsells, null, null, onDone);
      }
      messages.appendChild(section);
      scrollToEl(section);
    })
    .catch(function() { onDone([], null); });
  }

  function _showUpsellContinueBtn(section, addedUpsells, pickup, transferData, onDone) {
    var continueBtn = document.createElement('button');
    continueBtn.style.cssText = 'width:100%;margin:12px 0 4px;padding:12px;border-radius:20px;background:var(--et-navy);color:white;border:none;font-size:13px;font-weight:700;cursor:pointer;';
    continueBtn.innerText = 'Continue to details →';
    continueBtn.onclick = function() { section.style.opacity = '0.5'; continueBtn.disabled = true; onDone(addedUpsells, pickup ? { location: pickup, service: transferData } : null); };
    section.appendChild(continueBtn);
    scrollToEl(continueBtn);
  }

  var multiPropBar = null;

  function _showMultiPropBar(legSummaries, checkoutCallback) {
    if (multiPropBar) multiPropBar.remove();
    multiPropBar = document.createElement('div'); multiPropBar.className = 'multi-prop-bar'; multiPropBar.id = 'multi-prop-bar';
    var title = document.createElement('div'); title.className = 'multi-prop-bar-title';
    title.innerText = 'Select a room at each property:';
    var slots = document.createElement('div'); slots.className = 'multi-prop-slots';
    legSummaries.forEach(function(leg, i) {
      var slot = document.createElement('div'); slot.className = 'multi-prop-slot'; slot.id = 'prop-slot-' + i;
      var sn = document.createElement('div'); sn.className = 'multi-prop-slot-name'; sn.innerText = leg.propertyName || ('Property ' + (i+1));
      var ss = document.createElement('div'); ss.className = 'multi-prop-slot-status'; ss.innerText = 'Not selected';
      slot.appendChild(sn); slot.appendChild(ss); slots.appendChild(slot);
    });
    var checkoutBtn = document.createElement('button'); checkoutBtn.className = 'multi-prop-checkout-btn'; checkoutBtn.id = 'multi-checkout-btn';
    checkoutBtn.innerText = '✓ Confirm selections & continue';
    checkoutBtn.onclick = function() { checkoutCallback(); };
    multiPropBar.appendChild(title); multiPropBar.appendChild(slots); multiPropBar.appendChild(checkoutBtn);
    messages.insertBefore(multiPropBar, messages.firstChild);
  }

  function _updateMultiPropSlot(legIndex, propertyName, selected) {
    var slot = document.getElementById('prop-slot-' + legIndex);
    if (!slot) return;
    var ss = slot.querySelector('.multi-prop-slot-status');
    if (selected) { slot.classList.add('done'); if (ss) ss.innerText = '✓ Selected'; }
    else { slot.classList.remove('done'); if (ss) ss.innerText = 'Not selected'; }
    var allDone = Object.keys(hotelSelections).length >= (hotelLegMeta && hotelLegMeta.legCount || 1);
    var cb = document.getElementById('multi-checkout-btn');
    if (cb) cb.className = 'multi-prop-checkout-btn' + (allDone ? ' visible' : '');
  }

  function _showRestoreBanner() {
    var legs = legFlow.legs || [];
    var selCount = Object.keys(legFlow.selections || {}).length;
    var total    = legFlow.runningTotalKES || 0;
    var dest     = legFlow.tripParams && legFlow.tripParams.destination ? titleCase(legFlow.tripParams.destination) : 'your trip';
    var banner = document.createElement('div'); banner.className = 'restore-banner'; banner.id = 'et-restore-banner';
    var h4 = document.createElement('h4'); h4.innerText = '👋 Welcome back!';
    var p  = document.createElement('p');
    p.innerText = 'You have a saved trip to ' + dest + ' — ' + selCount + ' of ' + legs.length + ' legs selected' + (total > 0 ? ' · KES ' + Math.round(total).toLocaleString() + ' so far' : '') + '.';
    var acts = document.createElement('div'); acts.className = 'restore-banner-actions';
    var yesBtn = document.createElement('button'); yesBtn.className = 'restore-btn yes'; yesBtn.innerText = 'Continue trip';
    var noBtn  = document.createElement('button'); noBtn.className  = 'restore-btn no';  noBtn.innerText  = 'Start fresh';
    yesBtn.onclick = function() { banner.remove(); _renderLegFlow(); };
    noBtn.onclick  = function() { banner.remove(); _abandonLegFlow(); showAgencyWelcome(); };
    acts.appendChild(yesBtn); acts.appendChild(noBtn);
    banner.appendChild(h4); banner.appendChild(p); banner.appendChild(acts);
    messages.appendChild(banner); messages.scrollTop = messages.scrollHeight;
  }

  function _abandonLegFlow() {
    if (itineraryId) {
      fetch(apiBase + '/api/trips/itinerary/' + itineraryId + '/abandon', { method: 'POST', headers: {'Content-Type':'application/json','x-api-key': agencyKey} }).catch(function(){});
    }
    legFlow = null; itineraryId = null; persistState();
  }

  function showAgencyWelcome() {
    var div = document.createElement('div'); div.className = 'et-agency-welcome';
    var h4  = document.createElement('h4'); h4.innerText = 'Welcome to ${agencyName}';
    var p   = document.createElement('p');  p.innerText  = 'Tell me your dream destination and I will find the perfect package.';
    var sug = document.createElement('div'); sug.className = 'et-suggestions';
    ['Nairobi to Zanzibar','Cape Town 5 nights','Masai Mara Safari','Kigali Rwanda','Cairo Egypt'].forEach(function(s) {
      var btn = document.createElement('span'); btn.className = 'et-suggestion'; btn.innerText = s;
      btn.onclick = function() { input.value = s; send(); };
      sug.appendChild(btn);
    });
    div.appendChild(h4); div.appendChild(p); div.appendChild(sug);
    messages.appendChild(div);
  }

  function replayTranscript() {
    var note = document.createElement('div'); note.className = 'msg bot'; note.style.cssText = 'font-style:italic;opacity:0.6;'; note.innerText = '— Continuing where you left off —'; messages.appendChild(note);
    for (var i = 0; i < transcript.length; i++) { var e = transcript[i]; if (!e || !e.type) continue; if (e.type === 'user' || e.type === 'bot') { addMsg(e.text || '', e.type); } else if (e.type === 'packages' && Array.isArray(e.packages)) { e.packages.slice(0,4).forEach(function(p,idx){ addPackage(p, idx, null, null); }); } }
    messages.scrollTop = messages.scrollHeight;
  }

  var LEG_CONFIG = { arrival:{icon:'✈️',label:'Outbound + Hotel + Transfers',cls:'arrival'}, departure:{icon:'🛫',label:'Return Flight',cls:'departure'}, internal:{icon:'🔀',label:'Next Leg',cls:'internal'}, return_stay:{icon:'🏨',label:'Return Stay',cls:'return_stay'}, stopover:{icon:'⏱️',label:'Stopover',cls:'stopover'} };
  var legFlowContainer = null;

  function _renderLegFlow() {
    if (!legFlow || !legFlow.legs) return;
    if (legFlowContainer) legFlowContainer.remove();
    legFlowContainer = document.createElement('div'); legFlowContainer.id = 'leg-flow-container';
    messages.appendChild(legFlowContainer);
    legFlow.legs.forEach(function(leg, idx) { _renderLegSection(leg, idx); });
    messages.scrollTop = messages.scrollHeight;
  }

  function _renderLegSection(leg, idx) {
    var cfg = LEG_CONFIG[leg.role] || { icon: '📍', label: leg.role, cls: 'internal' };
    var sel = legFlow.selections && legFlow.selections[idx];
    var isCurrent = idx === legFlow.currentLegIndex;
    var isLocked  = !!sel;
    var isPending = !isLocked && !isCurrent;
    var section = document.createElement('div'); section.className = 'leg-section'; section.id = 'leg-section-' + idx;
    var hdr = document.createElement('div'); hdr.className = 'leg-header ' + cfg.cls;
    var hdrLeft = document.createElement('div'); hdrLeft.className = 'leg-header-left';
    var icon = document.createElement('span'); icon.className = 'leg-icon'; icon.innerText = cfg.icon;
    var titleWrap = document.createElement('div');
    var title = document.createElement('div'); title.className = 'leg-title'; title.innerText = (idx + 1) + '. ' + (leg.label || leg.roleLabel || cfg.label);
   var subtitle = document.createElement('div'); subtitle.className = 'leg-subtitle'; subtitle.innerText = leg.text ? leg.text.replace(/\\*\\*/g, '').split('\\n')[0] : cfg.label;
    titleWrap.appendChild(title); titleWrap.appendChild(subtitle);
    hdrLeft.appendChild(icon); hdrLeft.appendChild(titleWrap);
    var statusBadge = document.createElement('span'); statusBadge.className = 'leg-status ' + (isLocked ? 'locked' : isCurrent ? 'active' : 'pending');
    statusBadge.innerText = isLocked ? '✓ Selected' : isCurrent ? 'Choose' : 'Pending';
    hdr.appendChild(hdrLeft); hdr.appendChild(statusBadge);
    var body = document.createElement('div'); body.className = 'leg-body'; if (isPending) body.classList.add('collapsed');
    if (isLocked) {
      var selBar = document.createElement('div'); selBar.className = 'leg-selected-summary';
      var selDetail = document.createElement('div'); selDetail.className = 'leg-selected-detail';
      var pkg = sel.package; var parts = [];
      if (pkg.transport) parts.push(pkg.transport.airline || pkg.transport.provider || 'Flight');
      if (pkg.hotel)     parts.push(pkg.hotel.name || 'Hotel');
      parts.push('KES ' + Math.round(pkg.summary && pkg.summary.totalPrice || 0).toLocaleString());
      selDetail.innerText = parts.join(' · ');
      var changeBtn = document.createElement('button'); changeBtn.className = 'leg-change-btn'; changeBtn.innerText = '✏️ Change';
      changeBtn.onclick = function(e) { e.stopPropagation(); _unlockLeg(idx); };
      selBar.appendChild(selDetail); selBar.appendChild(changeBtn);
      section.appendChild(hdr); section.appendChild(selBar); section.appendChild(body);
    } else { section.appendChild(hdr); section.appendChild(body); }
    hdr.onclick = function() { if (body.classList.contains('collapsed')) { body.classList.remove('collapsed'); } else if (!isCurrent) { body.classList.add('collapsed'); } };
    var pkgs = leg.packages || [];
    if (pkgs.length === 0) {
      var noOpts = document.createElement('div'); noOpts.style.cssText = 'padding:14px;font-size:12px;color:var(--et-muted);text-align:center;'; noOpts.innerText = 'No options found for this leg. Reply to search again.'; body.appendChild(noOpts);
    } else {
      var pkgWrap = document.createElement('div'); pkgWrap.style.padding = '12px';
      pkgs.forEach(function(pkg, pkgIdx) {
        var card = addPackage(pkg, pkgIdx, idx, isLocked ? null : function(selectedPkg) { _selectLegPackage(idx, selectedPkg); });
        if (isLocked && sel && pkg.packageId !== sel.packageId) card.style.opacity = '0.45';
        pkgWrap.appendChild(card);
      });
      body.appendChild(pkgWrap);
    }
    legFlowContainer.appendChild(section);
    return section;
  }

  function _selectLegPackage(legIdx, pkg) {
    if (!legFlow) return;
    if (!legFlow.selections) legFlow.selections = {};
    var leg = legFlow.legs[legIdx];
    legFlow.selections[legIdx] = { packageId: pkg.packageId, package: pkg, label: leg && leg.label || 'Leg ' + (legIdx + 1), role: leg && leg.role || 'internal' };
    legFlow.runningTotalKES = (legFlow.runningTotalKES || 0) + (pkg.summary && pkg.summary.totalPrice || 0);
    var nextIdx = legIdx + 1;
    while (nextIdx < legFlow.legs.length && legFlow.selections[nextIdx]) nextIdx++;
    legFlow.currentLegIndex = nextIdx;
    persistState();
    _syncItineraryToServer();
    _renderLegFlow();
    var allSelected = legFlow.legs.every(function(_, i) { return !!legFlow.selections[i]; });
    if (allSelected) { setTimeout(function() { _showTripSummary(); }, 300); }
    else { setTimeout(function() { var ns = document.getElementById('leg-section-' + legFlow.currentLegIndex); if (ns) scrollToEl(ns); }, 150); }
  }

  function _unlockLeg(legIdx) {
    if (!legFlow || !legFlow.selections) return;
    var sel = legFlow.selections[legIdx];
    if (sel && sel.package && sel.package.summary) legFlow.runningTotalKES = Math.max(0, (legFlow.runningTotalKES || 0) - (sel.package.summary.totalPrice || 0));
    delete legFlow.selections[legIdx];
    legFlow.currentLegIndex = legIdx;
    var summary = document.getElementById('trip-summary-card'); if (summary) summary.remove();
    persistState(); _renderLegFlow();
    setTimeout(function() { _askChangeOptions(legIdx); }, 200);
  }

  function _askChangeOptions(legIdx) {
    var leg = legFlow.legs[legIdx]; var legLabel = leg ? (leg.label || 'Leg ' + (legIdx + 1)) : 'this leg';
    var banner = document.createElement('div'); banner.className = 'restore-banner'; banner.style.background = 'linear-gradient(135deg,#34495e,#2c3e50)';
    var h4 = document.createElement('h4'); h4.innerText = '🔄 Change ' + legLabel;
    var p  = document.createElement('p');  p.innerText = 'Want to see the same options again, or should I search with different criteria?';
    var acts = document.createElement('div'); acts.className = 'restore-banner-actions';
    var sameBtn = document.createElement('button'); sameBtn.className = 'restore-btn yes'; sameBtn.innerText = 'Same options';
    var newBtn  = document.createElement('button'); newBtn.className  = 'restore-btn no';  newBtn.innerText  = 'New search';
    sameBtn.onclick = function() { banner.remove(); var section = document.getElementById('leg-section-' + legIdx); if (section) scrollToEl(section); };
    newBtn.onclick  = function() { banner.remove(); legFlow._awaitingNewSearch = legIdx; addMsg('What should I adjust? (e.g. "cheaper hotel", "different airline")', 'bot'); input.focus(); };
    acts.appendChild(sameBtn); acts.appendChild(newBtn);
    banner.appendChild(h4); banner.appendChild(p); banner.appendChild(acts);
    messages.appendChild(banner); messages.scrollTop = messages.scrollHeight;
  }

  function _showTripSummary() {
    var ex = document.getElementById('trip-summary-card'); if (ex) ex.remove();
    if (!legFlow || !legFlow.selections) return;
    var selections = legFlow.selections; var legs = legFlow.legs;
    var total = legFlow.runningTotalKES || 0; var pax = (legFlow.tripParams && legFlow.tripParams.passengers) || 1; var currency = 'KES';
    var flightsTotal = 0, hotelsTotal = 0, transfersTotal = 0;
    for (var i = 0; i < legs.length; i++) {
      var sel = selections[i]; if (!sel) continue; var pkg = sel.package; if (!pkg) continue; var nights = (pkg.summary && pkg.summary.nights) || 1;
      if (pkg.transport && pkg.transport.price)             flightsTotal   += Number(pkg.transport.price) || 0;
      if (pkg.returnTransport && pkg.returnTransport.price) flightsTotal   += Number(pkg.returnTransport.price) || 0;
      if (pkg.hotel && pkg.hotel.pricePerNight)             hotelsTotal    += (Number(pkg.hotel.pricePerNight) || 0) * nights;
      var trs = pkg.transfers || []; for (var ti = 0; ti < trs.length; ti++) transfersTotal += Number(trs[ti].price) || 0;
    }
    var hotelDeposit = Math.round(hotelsTotal * 0.30);
    var depositTotal = Math.round(flightsTotal + hotelDeposit);
    var balanceDue   = Math.round(hotelsTotal - hotelDeposit + transfersTotal);
    var card = document.createElement('div'); card.className = 'trip-summary'; card.id = 'trip-summary-card';
    var sh = document.createElement('div'); sh.className = 'trip-summary-header';
    var st = document.createElement('div'); st.className = 'trip-summary-title'; st.innerText = '🎉 Your complete trip';
    var ss = document.createElement('div'); ss.className = 'trip-summary-sub'; ss.innerText = legs.length + ' legs · ' + pax + ' traveler(s)';
    sh.appendChild(st); sh.appendChild(ss);
    var legsDiv = document.createElement('div'); legsDiv.className = 'trip-summary-legs';
    for (var li = 0; li < legs.length; li++) {
      var lsel = selections[li]; if (!lsel) continue; var lleg = legs[li]; var lpkg = lsel.package; var lcfg = LEG_CONFIG[lleg.role] || { icon: '📍' };
      var tsLeg = document.createElement('div'); tsLeg.className = 'ts-leg';
      var tsLabel = document.createElement('div'); tsLabel.className = 'ts-leg-label'; tsLabel.innerText = lcfg.icon + ' ' + (lleg.roleLabel || lleg.label || 'Leg ' + (li + 1));
      var tsDetail = document.createElement('div'); tsDetail.className = 'ts-leg-detail';
      var dParts = []; if (lpkg.transport) dParts.push(lpkg.transport.airline || 'Flight'); if (lpkg.hotel) dParts.push(lpkg.hotel.name || 'Hotel'); tsDetail.innerText = dParts.join(' · ') || lleg.label || '';
      var tsSub = document.createElement('div'); tsSub.className = 'ts-leg-sub'; if (lpkg.summary && lpkg.summary.nights > 0) tsSub.innerText = lpkg.summary.nights + ' nights';
      var tsPrice = document.createElement('div'); tsPrice.className = 'ts-leg-price'; tsPrice.innerText = fmtPrice(lpkg.summary && lpkg.summary.totalPrice || 0, currency);
      var changeLink = document.createElement('button'); changeLink.style.cssText = 'font-size:11px;color:var(--et-gold);font-weight:600;cursor:pointer;border:none;background:none;padding:2px 0;margin-top:4px;display:block;'; changeLink.innerText = '✏️ Change this leg';
      (function(idx) { changeLink.onclick = function() { card.remove(); _unlockLeg(idx); }; })(li);
      tsLeg.appendChild(tsLabel); tsLeg.appendChild(tsDetail); tsLeg.appendChild(tsSub); tsLeg.appendChild(tsPrice); tsLeg.appendChild(changeLink);
      legsDiv.appendChild(tsLeg);
    }
    var totalDiv = document.createElement('div'); totalDiv.className = 'trip-summary-total';
    var totalPrice = document.createElement('div'); totalPrice.className = 'ts-total-price'; totalPrice.innerText = fmtPrice(Math.round(total), currency);
    var totalSub = document.createElement('div'); totalSub.className = 'ts-total-sub'; totalSub.innerText = fmtPrice(Math.round(total / pax), currency) + '/person';
    totalDiv.appendChild(totalPrice); totalDiv.appendChild(totalSub);
    var depBreak = document.createElement('div'); depBreak.className = 'deposit-breakdown';
    var depTitle = document.createElement('div'); depTitle.style.cssText = 'font-size:11px;font-weight:700;color:var(--et-navy);margin-bottom:8px;letter-spacing:0.5px;text-transform:uppercase;'; depTitle.innerText = '💳 Payment breakdown'; depBreak.appendChild(depTitle);
    function makeDepRow(label, amount, cls) { var row = document.createElement('div'); row.className = 'deposit-row' + (cls ? ' ' + cls : ''); var l = document.createElement('span'); l.innerText = label; var a = document.createElement('span'); a.innerText = fmtPrice(amount, currency); row.appendChild(l); row.appendChild(a); depBreak.appendChild(row); }
    makeDepRow('Flights (100%)', Math.round(flightsTotal));
    makeDepRow('Hotel deposit (30%)', hotelDeposit);
    makeDepRow('Deposit total', depositTotal, 'total');
    makeDepRow('Balance before travel', balanceDue, 'balance');
    totalDiv.appendChild(depBreak);
    var actions = document.createElement('div'); actions.className = 'summary-actions';
    var fullPayBtn = document.createElement('button'); fullPayBtn.className = 'summary-action-btn primary'; fullPayBtn.innerText = '💳 Pay in full — ' + fmtPrice(Math.round(total), currency); fullPayBtn.onclick = function() { _startBooking('full'); };
    var depositBtn = document.createElement('button'); depositBtn.className = 'summary-action-btn primary'; depositBtn.style.background = 'var(--et-green)'; depositBtn.innerText = '✅ Pay deposit — ' + fmtPrice(depositTotal, currency); depositBtn.onclick = function() { _startBooking('deposit'); };
    var flightsOnlyBtn = document.createElement('button'); flightsOnlyBtn.className = 'summary-action-btn secondary'; flightsOnlyBtn.innerText = '✈️ Flights only — ' + fmtPrice(Math.round(flightsTotal), currency); flightsOnlyBtn.onclick = function() { _startBooking('flights_only'); };
    var changeBtn2 = document.createElement('button'); changeBtn2.className = 'summary-action-btn secondary'; changeBtn2.innerText = '🔄 Change a leg'; changeBtn2.onclick = function() { card.remove(); _renderLegFlow(); addMsg('Tap ✏️ on any leg to change it.', 'bot'); };
    actions.appendChild(fullPayBtn); actions.appendChild(depositBtn); actions.appendChild(flightsOnlyBtn); actions.appendChild(changeBtn2);
    card.appendChild(sh); card.appendChild(legsDiv); card.appendChild(totalDiv); card.appendChild(actions);
    messages.appendChild(card); messages.scrollTop = messages.scrollHeight;
  }

  function _startBooking(paymentType) {
    if (!legFlow || !legFlow.selections) return;
    var summaryCard = document.getElementById('trip-summary-card'); if (summaryCard) summaryCard.remove();
    addMsg('Great! Just need a few details to confirm your booking.', 'bot');
    showPassengerForm(paymentType);
  }

  function showPassengerForm(paymentType) {
    var ex = document.getElementById('et-name-form'); if (ex) ex.remove();
    var pax = (legFlow && legFlow.tripParams && legFlow.tripParams.passengers) || 1;
    var form = document.createElement('div'); form.className = 'name-form'; form.id = 'et-name-form';
    var fp = document.createElement('p'); fp.innerText = 'Enter details for ' + pax + ' traveler' + (pax > 1 ? 's' : '') + ':'; form.appendChild(fp);
    var pInputs = []; var yr = new Date().getFullYear();
    function buildDob() { var row = document.createElement('div'); row.className = 'dob-row'; var d = document.createElement('select'); d.innerHTML = '<option value="">Day</option>' + Array.from({length:31},function(_,i){return '<option value="'+(i+1)+'">'+(i+1)+'</option>';}).join(''); var m = document.createElement('select'); m.innerHTML = '<option value="">Month</option>' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(function(mn,i){return '<option value="'+(i+1)+'">'+mn+'</option>';}).join(''); var y = document.createElement('select'); y.innerHTML = '<option value="">Year</option>' + Array.from({length:100},function(_,i){return yr-i;}).map(function(yy){return '<option value="'+yy+'">'+yy+'</option>';}).join(''); row.appendChild(d); row.appendChild(m); row.appendChild(y); return {row:row,d:d,m:m,y:y}; }
    for (var pi = 0; pi < pax; pi++) {
      var pb = document.createElement('div'); pb.style.cssText = 'margin-bottom:12px;padding-bottom:10px;border-bottom:' + (pi < pax-1 ? '1px solid var(--et-border)' : 'none') + ';';
      if (pax > 1) { var pl = document.createElement('div'); pl.style.cssText = 'font-size:11px;font-weight:700;color:var(--et-navy);margin-bottom:6px;'; pl.innerText = 'Traveler ' + (pi + 1); pb.appendChild(pl); }
      var fn = document.createElement('input'); fn.className = 'name-input'; fn.placeholder = 'First name'; fn.type = 'text'; pb.appendChild(fn);
      var ln = document.createElement('input'); ln.className = 'name-input'; ln.placeholder = 'Last name';  ln.type = 'text'; pb.appendChild(ln);
      var dl = document.createElement('div'); dl.className = 'field-label'; dl.innerText = 'Date of birth'; pb.appendChild(dl);
      var dob = buildDob(); pb.appendChild(dob.row);
      var gs = document.createElement('select'); gs.className = 'name-input'; gs.innerHTML = '<option value="male">Male</option><option value="female">Female</option>'; pb.appendChild(gs);
      var cl = document.createElement('label'); cl.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--et-navy);margin-bottom:8px;'; var cc = document.createElement('input'); cc.type = 'checkbox'; cl.appendChild(cc); cl.appendChild(document.createTextNode('This traveler is a child')); pb.appendChild(cl);
      var idl = document.createElement('div'); idl.className = 'field-label'; idl.innerText = 'Passport or National ID'; pb.appendChild(idl);
      var ii = document.createElement('input'); ii.className = 'name-input'; ii.placeholder = 'Passport / ID number'; ii.type = 'text'; pb.appendChild(ii);
      pInputs.push({fn:fn,ln:ln,d:dob.d,m:dob.m,y:dob.y,gs:gs,cc:cc,ii:ii}); form.appendChild(pb);
    }
    var cl2 = document.createElement('div'); cl2.style.cssText = 'font-size:11px;font-weight:700;color:var(--et-navy);margin-bottom:6px;'; cl2.innerText = 'Contact details'; form.appendChild(cl2);
    var phi = document.createElement('input'); phi.className = 'name-input'; phi.placeholder = 'Phone (e.g. 0712345678)'; phi.type = 'tel'; form.appendChild(phi);
    var emi = document.createElement('input'); emi.className = 'name-input'; emi.placeholder = 'Email'; emi.type = 'email'; form.appendChild(emi);
    var em = document.createElement('div'); em.style.cssText = 'color:var(--et-red);font-size:11px;margin-bottom:8px;display:none;'; form.appendChild(em);
    var cfb = document.createElement('button'); cfb.className = 'confirm-btn';
    cfb.innerText = paymentType === 'full' ? 'Confirm & Pay in Full' : paymentType === 'deposit' ? 'Confirm & Pay Deposit' : 'Confirm Flight Bookings';
    cfb.onclick = function() {
      em.style.display = 'none'; var passengers = [];
      for (var k = 0; k < pInputs.length; k++) {
        var pin = pInputs[k]; var f = pin.fn.value.trim(), l = pin.ln.value.trim();
        if (!f || !l) { em.innerText = 'Please fill in all traveler names.'; em.style.display = 'block'; return; }
        var dd = pin.d.value, mm = pin.m.value, yy = pin.y.value;
        if (!dd || !mm || !yy) { em.innerText = 'Please select date of birth for traveler ' + (k+1) + '.'; em.style.display = 'block'; return; }
        var dstr = yy + '-' + String(mm).padStart(2,'0') + '-' + String(dd).padStart(2,'0');
        var idn = pin.ii.value.trim(); if (!pin.cc.checked && !idn) { em.innerText = 'Passport/ID required for traveler ' + (k+1) + '.'; em.style.display = 'block'; return; }
        passengers.push({firstName:f,lastName:l,dateOfBirth:dstr,gender:pin.gs.value,type:pin.cc.checked?'child':'adult',idNumber:idn||null});
      }
      var phone = phi.value.trim(), email = emi.value.trim();
      if (!phone) { em.innerText = 'Phone number is required.'; em.style.display = 'block'; return; }
      if (!email) { em.innerText = 'Email is required.'; em.style.display = 'block'; return; }
      cfb.innerText = 'Processing...'; cfb.disabled = true;
      if (itineraryId) { fetch(apiBase + '/api/trips/itinerary/' + itineraryId + '/attach-phone', { method: 'POST', headers: {'Content-Type':'application/json','x-api-key': agencyKey}, body: JSON.stringify({ phone: phone, agencyId: agencyKey }) }).catch(function(){}); }
      var selectedPackages = [];
      if (legFlow && legFlow.selections) { var sels = legFlow.selections; for (var si = 0; si < legFlow.legs.length; si++) { if (sels[si] && sels[si].package) selectedPackages.push(sels[si].package); } }
      fetch(apiBase + '/api/trips/book-init', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ agencyId: agencyKey, guestName: passengers[0].firstName + ' ' + passengers[0].lastName, guestPhone: phone, guestEmail: email, passengers: passengers, packages: selectedPackages, paymentType: paymentType, itineraryId: itineraryId || null, legFlow: legFlow }) })
      .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,data:d}; }); })
      .then(function(res) {
        if (!res.ok || !res.data.success) { em.innerText = (res.data && res.data.error) || 'Booking failed.'; em.style.display = 'block'; cfb.innerText = 'Confirm Booking'; cfb.disabled = false; return; }
        form.remove(); var ref = res.data.bookingRef || (res.data.refs && res.data.refs.join(', '));
        addMsg('🎉 Booking confirmed! Ref: ' + ref + '. Check your phone for the M-Pesa prompt.', 'bot');
        if (paymentType === 'full') { legFlow = null; itineraryId = null; persistState(); }
      })
      .catch(function() { em.innerText = 'Network error. Please try again.'; em.style.display = 'block'; cfb.innerText = 'Confirm Booking'; cfb.disabled = false; });
    };
    form.appendChild(cfb);
    var tb = document.createElement('div'); tb.className = 'trust-badge'; tb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg> Secure payment via M-Pesa'; form.appendChild(tb);
    messages.appendChild(form); messages.scrollTop = messages.scrollHeight;
  }

  function _syncItineraryToServer() {
    fetch(apiBase + '/api/trips/itinerary/save', { method: 'POST', headers: {'Content-Type':'application/json','x-api-key': agencyKey}, body: JSON.stringify({ itineraryId: itineraryId, sessionId: sessionId, agencyId: agencyKey, channel: 'widget', tripParams: legFlow && legFlow.tripParams, legFlow: legFlow, status: 'active' }) })
    .then(function(r){ return r.json(); })
    .then(function(d) { if (d && d.itineraryId && !itineraryId) { itineraryId = d.itineraryId; persistState(); } })
    .catch(function(){});
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PACKAGE CARD
  // ─────────────────────────────────────────────────────────────────────────
  function addPackage(p, i, legIdx, onSelect) {
    var div = document.createElement('div'); div.className = 'package';
    var t = p.transport || null, rt = p.returnTransport || null, h = p.hotel || null;
    var tr = p.transfers || null, s = p.summary || {};
    var cur = s.currency || 'KES', total = Math.round(s.totalPrice || 0);
    var ppp = Math.round(s.pricePerPerson || 0), nights = s.nights || 0, pax = s.passengers || 1;
    var route = s.route || ((t && t.origin ? t.origin : 'TBC') + ' to ' + (t && t.destination ? t.destination : 'TBC'));
    var ph = document.createElement('div'); ph.className = 'pkg-header';
    var pt = document.createElement('span'); pt.className = 'pkg-title'; pt.innerText = 'Option ' + (i + 1);
    var pr = document.createElement('span'); pr.className = 'pkg-route'; pr.innerText = route;
    ph.appendChild(pt); ph.appendChild(pr);
    var pb = document.createElement('div'); pb.className = 'pkg-body';
    if (t) { var isb = (t.transportType||'').toLowerCase()==='bus', ist = (t.transportType||'').toLowerCase()==='train'; var sub = (t.origin||'TBC')+' → '+(t.destination||'TBC')+' · '+fmtTime(t.departureTime)+' - '+fmtTime(t.arrivalTime); if (t.stops) sub += ' · '+t.stops; if (t.cabinClass) sub += ' · '+t.cabinClass; if (!isb && t.baggageSummary) sub += ' · '+t.baggageSummary; sub += ' · '+fmtPrice(t.price,t.currency); pb.appendChild(makeRow(isb?'Outbound Bus':ist?'Train':'Outbound Flight',t.airline||t.provider||'TBC',sub)); if (t.policySummary) pb.appendChild(makeHL(t.policySummary,t.isRefundable===true?'good':t.isRefundable===false?'warn':'neutral')); }
    if (rt) { var rsub = (rt.origin||'TBC')+' → '+(rt.destination||'TBC')+' · '+fmtTime(rt.departureTime)+' - '+fmtTime(rt.arrivalTime); if (rt.baggageSummary) rsub += ' · '+rt.baggageSummary; rsub += ' · '+fmtPrice(rt.price,rt.currency); pb.appendChild(makeRow('Return Flight',rt.airline||rt.provider||'TBC',rsub)); }
    if (h) {
      var stars = h.stars ? Array(Math.min(Math.round(h.stars),5)+1).join('★') : '';
      var hsub = (h.location||'TBC'); if (nights > 0) hsub += ' · '+nights+' nights · '+fmtPrice(h.pricePerNight,h.currency)+'/night';
      if (h.images && h.images.length > 0) { var hi = document.createElement('img'); hi.src = h.images[0]; hi.alt = h.name||'Hotel'; hi.style.cssText = 'width:100%;height:140px;object-fit:cover;border-radius:10px;margin-bottom:8px;display:block;'; hi.onerror = function(){ this.style.display='none'; }; pb.appendChild(hi); }
      pb.appendChild(makeRow('Hotel',(h.name||'TBC')+(stars?' '+stars:''),hsub));
      if (h.mealPlan) pb.appendChild(makeHL('🍽️ '+h.mealPlan.replace(/_/g,' '),'neutral'));
      pb.appendChild(makeHL(h.policySummary||(h.isRefundable===false?'⚠️ Non-refundable':'Refund terms confirmed at booking'),h.isRefundable===false?'warn':h.isRefundable===true||h.policySummary?'good':'neutral'));
      if (h.priceMatchApplied) { pb.appendChild(makeHL('🏷️ Price matched — saving KES '+Math.round(h.priceMatchSaving||0).toLocaleString()+'/night vs '+h.priceMatchOta,'good')); }
    }
    var trl = Array.isArray(tr) ? tr : (tr ? [tr] : []);
    if (trl.length > 0) { var tsub = trl.map(function(x){ return (x.legType==='departure'?'Departure':'Arrival')+': '+(x.description||x.location||'TBC')+' ('+fmtPrice(x.price,x.currency)+')'; }).join(' · '); pb.appendChild(makeRow('Transfer',trl[0].provider||'Bodrless Transfer',tsub)); }
    var pf = document.createElement('div'); pf.className = 'pkg-footer';
    var ppd = document.createElement('div'); ppd.className = 'pkg-price'; ppd.innerText = fmtPrice(total,cur);
    var pps = document.createElement('small'); pps.innerText = fmtPrice(ppp,cur)+'/person · '+pax+' traveller(s)'; ppd.appendChild(pps);
    if (onSelect) {
      var selBtn = document.createElement('button'); selBtn.className = 'select-btn'; selBtn.innerText = '✓ Select';
      selBtn.onclick = function() { selBtn.innerText = 'Selected ✓'; selBtn.className = 'select-btn selected'; selBtn.disabled = true; onSelect(p); };
      pf.appendChild(ppd); pf.appendChild(selBtn);
    } else {
      var bk = document.createElement('button'); bk.className = 'book'; bk.innerText = 'Book Now';
      bk.onclick = function(){ showNameFormStandalone(p, bk); };
      pf.appendChild(ppd); pf.appendChild(bk);
    }
    if (p._cacheResult && p._cacheResult.widget && p._cacheResult.widget.supplierBreakdown) {
      addSupplierComparison(div, p._cacheResult.widget.supplierBreakdown);
    }
    div.appendChild(ph); div.appendChild(pb); div.appendChild(pf);
    return div;
  }

  function showNameFormStandalone(p, bookBtn) {
    var ex = document.getElementById('et-name-form'); if (ex) ex.remove();
    var pc = (p.summary && p.summary.passengers) ? p.summary.passengers : 1;
    var form = document.createElement('div'); form.className = 'name-form'; form.id = 'et-name-form';
    var fp = document.createElement('p'); fp.innerText = 'Enter passenger details:'; form.appendChild(fp);
    var pInputs = []; var yr = new Date().getFullYear();
    function buildDob2() { var row = document.createElement('div'); row.className = 'dob-row'; var d = document.createElement('select'); d.innerHTML = '<option value="">Day</option>' + Array.from({length:31},function(_,i){return '<option value="'+(i+1)+'">'+(i+1)+'</option>';}).join(''); var m = document.createElement('select'); m.innerHTML = '<option value="">Month</option>' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(function(mn,i){return '<option value="'+(i+1)+'">'+mn+'</option>';}).join(''); var y = document.createElement('select'); y.innerHTML = '<option value="">Year</option>' + Array.from({length:100},function(_,i){return yr-i;}).map(function(yy){return '<option value="'+yy+'">'+yy+'</option>';}).join(''); row.appendChild(d); row.appendChild(m); row.appendChild(y); return {row:row,d:d,m:m,y:y}; }
    for (var pi2 = 0; pi2 < pc; pi2++) {
      var pb2 = document.createElement('div'); pb2.style.cssText = 'margin-bottom:12px;padding-bottom:10px;border-bottom:'+(pi2<pc-1?'1px solid var(--et-border)':'none')+';';
      if (pc > 1) { var pl2 = document.createElement('div'); pl2.style.cssText='font-size:11px;font-weight:700;color:var(--et-navy);margin-bottom:6px;'; pl2.innerText='Traveler '+(pi2+1); pb2.appendChild(pl2); }
      var fn2=document.createElement('input');fn2.className='name-input';fn2.placeholder='First name';fn2.type='text';pb2.appendChild(fn2);
      var ln2=document.createElement('input');ln2.className='name-input';ln2.placeholder='Last name';ln2.type='text';pb2.appendChild(ln2);
      var dl2=document.createElement('div');dl2.className='field-label';dl2.innerText='Date of birth';pb2.appendChild(dl2);
      var dob2=buildDob2();pb2.appendChild(dob2.row);
      var gs2=document.createElement('select');gs2.className='name-input';gs2.innerHTML='<option value="male">Male</option><option value="female">Female</option>';pb2.appendChild(gs2);
      var cl3=document.createElement('label');cl3.style.cssText='display:flex;align-items:center;gap:6px;font-size:11px;color:var(--et-navy);margin-bottom:8px;';var cc3=document.createElement('input');cc3.type='checkbox';cl3.appendChild(cc3);cl3.appendChild(document.createTextNode('Child'));pb2.appendChild(cl3);
      var idl2=document.createElement('div');idl2.className='field-label';idl2.innerText='Passport / National ID';pb2.appendChild(idl2);
      var ii2=document.createElement('input');ii2.className='name-input';ii2.placeholder='ID number';ii2.type='text';pb2.appendChild(ii2);
      pInputs.push({fn:fn2,ln:ln2,d:dob2.d,m:dob2.m,y:dob2.y,gs:gs2,cc:cc3,ii:ii2}); form.appendChild(pb2);
    }
    var cl4=document.createElement('div');cl4.style.cssText='font-size:11px;font-weight:700;color:var(--et-navy);margin-bottom:6px;';cl4.innerText='Contact';form.appendChild(cl4);
    var phi2=document.createElement('input');phi2.className='name-input';phi2.placeholder='Phone';phi2.type='tel';form.appendChild(phi2);
    var emi2=document.createElement('input');emi2.className='name-input';emi2.placeholder='Email';emi2.type='email';form.appendChild(emi2);
    var em2=document.createElement('div');em2.style.cssText='color:var(--et-red);font-size:11px;margin-bottom:8px;display:none;';form.appendChild(em2);
    var cfb2=document.createElement('button');cfb2.className='confirm-btn';cfb2.innerText='Confirm Booking';
    cfb2.onclick=function(){
      em2.style.display='none'; var pax2=[];
      for(var k=0;k<pInputs.length;k++){var pin=pInputs[k];var f=pin.fn.value.trim(),l=pin.ln.value.trim();if(!f||!l){em2.innerText='Please fill in all names.';em2.style.display='block';return;}var dd=pin.d.value,mm=pin.m.value,yy=pin.y.value;if(!dd||!mm||!yy){em2.innerText='Date of birth required.';em2.style.display='block';return;}var dstr=yy+'-'+String(mm).padStart(2,'0')+'-'+String(dd).padStart(2,'0');var idn=pin.ii.value.trim();if(!pin.cc.checked&&!idn){em2.innerText='ID required.';em2.style.display='block';return;}pax2.push({firstName:f,lastName:l,dateOfBirth:dstr,gender:pin.gs.value,type:pin.cc.checked?'child':'adult',idNumber:idn||null});}
      var phone2=phi2.value.trim(),email2=emi2.value.trim();if(!phone2){em2.innerText='Phone required.';em2.style.display='block';return;}if(!email2){em2.innerText='Email required.';em2.style.display='block';return;}
      cfb2.innerText='Processing...';cfb2.disabled=true;
      fetch(apiBase+'/api/trips/book-init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agencyId:agencyKey,guestName:pax2[0].firstName+' '+pax2[0].lastName,guestPhone:phone2,guestEmail:email2,passengers:pax2,package:p})})
      .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
      .then(function(res){if(!res.ok&&res.data&&res.data.code==='PRICE_CHANGED'){form.remove();showPriceAlert(res.data,{guestName:pax2[0].firstName+' '+pax2[0].lastName,phone:phone2,email:email2,passengers:pax2,pkg:p},bookBtn);return;}if(!res.ok||!res.data.success){em2.innerText=(res.data&&res.data.error)||'Booking failed.';em2.style.display='block';cfb2.innerText='Confirm Booking';cfb2.disabled=false;return;}form.remove();continueToPayment(res.data,{guestName:pax2[0].firstName+' '+pax2[0].lastName,phone:phone2,email:email2,passengers:pax2},bookBtn);})
      .catch(function(){em2.innerText='Network error.';em2.style.display='block';cfb2.innerText='Confirm Booking';cfb2.disabled=false;});
    };
    form.appendChild(cfb2);
    var tb2=document.createElement('div');tb2.className='trust-badge';tb2.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg> Secure payment via M-Pesa';form.appendChild(tb2);
    messages.appendChild(form);messages.scrollTop=messages.scrollHeight;
  }

  function showPriceAlert(info, ctx, btn) {
    var ex=document.getElementById('et-price-alert');if(ex)ex.remove();
    var d=document.createElement('div');d.className='price-alert';d.id='et-price-alert';
    var p=document.createElement('p');p.innerHTML='Price changed: <span style="text-decoration:line-through;color:var(--et-muted);">'+fmtPrice(info.oldPrice,info.currency)+'</span> → <strong style="color:var(--et-red);">'+fmtPrice(info.newPrice,info.currency)+'</strong>';
    d.appendChild(p);var acts=document.createElement('div');acts.className='price-alert-actions';
    var ap=document.createElement('button');ap.className='price-approve';ap.innerText='Approve new price';
    var ca=document.createElement('button');ca.className='price-cancel';ca.innerText='Cancel';
    acts.appendChild(ap);acts.appendChild(ca);d.appendChild(acts);messages.appendChild(d);messages.scrollTop=messages.scrollHeight;
    ca.onclick=function(){d.remove();addMsg('Booking cancelled — no charge was made.','bot');};
    ap.onclick=function(){ap.disabled=true;ca.disabled=true;ap.innerText='Processing...';fetch(apiBase+'/api/trips/book-init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agencyId:agencyKey,guestName:ctx.guestName,guestPhone:ctx.phone,guestEmail:ctx.email,passengers:ctx.passengers,package:ctx.pkg,priceApproved:true})}).then(function(r){return r.json().then(function(data){return{ok:r.ok,data:data};});}).then(function(res){d.remove();if(!res.ok||!res.data.success){addMsg((res.data&&res.data.error)||'Booking failed.','bot');return;}continueToPayment(res.data,ctx,btn);}).catch(function(){d.remove();addMsg('Network error.','bot');});};
  }

  function continueToPayment(data, ctx, btn) {
    var ref=data.bookingRef,total=data.totalPrice,cur=data.currency;
    addMsg('Flight held! Ref: '+ref+'. Total: '+cur+' '+total.toLocaleString()+'. Sending M-Pesa prompt to '+ctx.phone+'...','bot');
    fetch(apiBase+'/api/trips/book-pay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bookingRef:ref,phone:ctx.phone,amount:total,currency:cur,email:ctx.email,firstName:ctx.passengers[0].firstName,lastName:ctx.passengers[0].lastName})})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
    .then(function(pr){if(!pr.ok||!pr.data.success){if(btn){btn.innerText='Payment failed';btn.style.background='var(--et-red)';}addMsg('Flight held but M-Pesa prompt failed. Contact support with ref '+ref+'.','bot');return;}if(btn){btn.innerText='Awaiting payment...';btn.style.background='#f0ad4e';btn.disabled=true;}addMsg('Check your phone and enter your PIN. Ref: '+ref+'.','bot');pollBookingStatus(ref,btn||{innerText:'',style:{}});});
  }

  function pollBookingStatus(ref, btn) {
    var a=0,max=40,iv=setInterval(function(){a++;fetch(apiBase+'/api/trips/booking/'+ref).then(function(r){return r.json();}).then(function(d){if(d.bookingStage==='paid'){clearInterval(iv);btn.innerText='Paid & Confirmed!';btn.style.background='#27ae60';addMsg('Payment received! Booking '+ref+' confirmed.','bot');}else if(d.bookingStage==='failed'||d.status==='cancelled'){clearInterval(iv);btn.innerText='Payment not received';btn.style.background='var(--et-red)';addMsg('Payment not received for '+ref+'.','bot');}else if(a>=max){clearInterval(iv);addMsg('Still waiting on payment for '+ref+'.','bot');}}).catch(function(){});},5000);
  }

  function showHotelEntry() {
    var card=document.createElement('div');card.className='et-welcome';card.id='et-hotel-entry';
    var eyebrow=document.createElement('div');eyebrow.className='et-welcome-eyebrow';eyebrow.innerText='Your Personal Concierge';
    var title=document.createElement('div');title.className='et-welcome-title';title.innerText='Welcome to ${agencyName}';
    var body=document.createElement('div');body.className='et-welcome-body';body.innerText="It's a pleasure to have you with us. Tell me the occasion, your preferred dates, and how many guests — I'll find the perfect room and make it special.";
    var ctaBtn=document.createElement('button');ctaBtn.style.cssText='display:block;width:100%;background:var(--et-navy);color:white;border:none;padding:12px 20px;border-radius:20px;cursor:pointer;font-size:13px;font-weight:600;letter-spacing:0.3px;margin-top:4px;transition:background 0.2s;';ctaBtn.innerText='Start Planning';ctaBtn.onmouseover=function(){this.style.background='var(--et-gold)';};ctaBtn.onmouseout=function(){this.style.background='var(--et-navy)';};ctaBtn.onclick=function(){card.remove();setTimeout(function(){showHotelWelcome();input.focus();},300);};
    card.appendChild(eyebrow);card.appendChild(title);card.appendChild(body);card.appendChild(ctaBtn);messages.appendChild(card);messages.scrollTop=messages.scrollHeight;
  }

  function showHotelWelcome() {
    var card=document.createElement('div');card.className='et-welcome';
    var eyebrow=document.createElement('div');eyebrow.className='et-welcome-eyebrow';eyebrow.innerText='Your Personal Concierge';
    var title=document.createElement('div');title.className='et-welcome-title';title.innerText='Welcome to ${agencyName}';
    var body=document.createElement('div');body.className='et-welcome-body';body.innerText="It's a pleasure to have you with us. Tell me the occasion, your preferred dates, and how many guests — I'll take care of finding the perfect room and making it special.";
    var divider=document.createElement('div');divider.className='et-divider';
    var promptLabel=document.createElement('div');promptLabel.className='et-prompts-label';promptLabel.innerText='Popular requests';
    var starters=(window.bodrlessStarters&&window.bodrlessStarters.length)?window.bodrlessStarters.slice(0,3):[
      {icon:'💍',title:'Honeymoon Stay',text:"We're honeymooners — what's your most romantic room for 5 nights?"},
      {icon:'👨‍👩‍👧',title:'Family Holiday',text:'Family room for 2 adults and 2 children, full board, arriving next weekend.'},
      {icon:'💼',title:'Business Trip',text:'Single business room for tomorrow night, early check-in if possible.'}
    ];
    card.appendChild(eyebrow);card.appendChild(title);card.appendChild(body);card.appendChild(divider);card.appendChild(promptLabel);
    starters.forEach(function(s){ var btn=document.createElement('button');btn.className='et-starter';var t=document.createElement('div');t.className='st-title';t.innerText=s.icon+'  '+s.title;var b=document.createElement('div');b.className='st-body';b.innerText=s.text;btn.appendChild(t);btn.appendChild(b);btn.onclick=function(){input.value=s.text;send();};card.appendChild(btn); });
    messages.appendChild(card);messages.scrollTop=messages.scrollHeight;
  }

  function addHotelPackage(p, idx, tripParams, isMultiProp, legIndex) {
    var div=document.createElement('div');div.className='package';
    var hotel=p.hotel||{};var summary=p.summary||{};
    var currency=hotel.currency||summary.currency||'KES';var nights=hotel.nights||summary.nights||1;
    var passengers=summary.passengers||1;var baseTotal=hotel.totalRate||(hotel.pricePerNight*nights)||summary.totalPrice||0;
    var pkgH=document.createElement('div');pkgH.className='pkg-header';
    var pt=document.createElement('span');pt.className='pkg-title';pt.innerText='Option '+(idx+1);
    var pr=document.createElement('span');pr.className='pkg-route';pr.innerText=hotel.location||summary.route||'Room';
    pkgH.appendChild(pt);pkgH.appendChild(pr);
    var pkgB=document.createElement('div');pkgB.className='pkg-body';
    var images=hotel.images||[];
    if(images.length>0){var img=document.createElement('img');img.src=images[0];img.alt=hotel.roomType||'Room';img.style.cssText='width:100%;height:160px;object-fit:cover;border-radius:10px;margin-bottom:10px;display:block;';img.onerror=function(){this.style.display='none';};pkgB.appendChild(img);}
    var stars=hotel.stars?Array(Math.min(Math.round(hotel.stars),5)+1).join('★'):'';
    pkgB.appendChild(makeRow('Property',(hotel.propertyName||hotel.name||'TBC')+(stars?' '+stars:''),hotel.location||hotel.address||''));
    pkgB.appendChild(makeRow('Room',hotel.roomType||'Standard Room',''));
    pkgB.appendChild(makeRow('Dates',(hotel.checkIn||'')+' → '+(hotel.checkOut||''),nights+' night'+(nights!==1?'s':'')+' · '+passengers+' guest(s)'));
    if(hotel.mealPlan) pkgB.appendChild(makeHL('🍽️ '+hotel.mealPlan.replace(/_/g,' '),'neutral'));
    pkgB.appendChild(makeCancelBadge(hotel.policySummary,hotel.isRefundable));
    if(hotel.priceMatchApplied) pkgB.appendChild(makeHL('🏷️ Price matched — saving KES '+Math.round(hotel.priceMatchSaving||0).toLocaleString()+'/night','good'));
    var pkgF=document.createElement('div');pkgF.className='pkg-footer';
    var pd=document.createElement('div');pd.className='pkg-price';
    var pm=document.createElement('span');pm.innerText=currency+' '+Math.round(baseTotal).toLocaleString();
    var ps=document.createElement('small');ps.innerText=currency+' '+Math.round(hotel.pricePerNight||0).toLocaleString()+'/night';
    pd.appendChild(pm);pd.appendChild(ps);
    var btnLabel = isMultiProp ? 'Select Room' : 'Reserve';
    var bk=document.createElement('button');bk.className='book';bk.innerText=btnLabel;
    bk.onclick=function(){
      bk.innerText='Selected ✓';bk.style.background='var(--et-green)';bk.disabled=true;
      showUpsellSection(p, tripParams || previousParams || {}, function(addedUpsells, transferInfo) {
        if (isMultiProp) {
          var propId = hotel.propertyId || p.groupSlug || ('prop-' + idx);
          hotelSelections[propId] = { pkg: p, upsells: addedUpsells, transfer: transferInfo };
          _updateMultiPropSlot(legIndex !== undefined ? legIndex : idx, hotel.propertyName || 'Property', true);
          var allDone = hotelLegMeta && Object.keys(hotelSelections).length >= hotelLegMeta.legCount;
          if (allDone) { addMsg('All rooms selected. Enter your details below to complete the reservation.', 'bot'); showHotelGuestFormMulti(); }
        } else {
          showHotelGuestForm(p, bk, addedUpsells, transferInfo);
        }
      });
    };
    pkgF.appendChild(pd);pkgF.appendChild(bk);
    div.appendChild(pkgH);div.appendChild(pkgB);div.appendChild(pkgF);
    messages.appendChild(div);return div;
  }

  function showHotelGuestForm(p, bookBtn, addedUpsells, transferInfo) {
    var ex=document.getElementById('et-hotel-form');if(ex)ex.remove();
    var hotel=p.hotel||{};var summary=p.summary||{};
    var currency=hotel.currency||summary.currency||'KES';var total=summary.totalPrice||hotel.totalRate||0;
    var form=document.createElement('div');form.className='name-form';form.id='et-hotel-form';
    var fp=document.createElement('p');fp.innerText='Complete your reservation:';form.appendChild(fp);
    var ni=document.createElement('input');ni.className='name-input';ni.placeholder='Full name';ni.type='text';form.appendChild(ni);
    var pi=document.createElement('input');pi.className='name-input';pi.placeholder='Phone number';pi.type='tel';form.appendChild(pi);
    var ei=document.createElement('input');ei.className='name-input';ei.placeholder='Email (for voucher)';ei.type='email';form.appendChild(ei);
    var ri=document.createElement('textarea');ri.className='name-input';ri.placeholder='Special requests (optional)';ri.style.cssText='height:56px;resize:none;';form.appendChild(ri);
    var err=document.createElement('div');err.style.cssText='color:var(--et-red);font-size:11px;margin-bottom:8px;display:none;';form.appendChild(err);
    var cb=document.createElement('button');cb.className='confirm-btn';cb.innerText='Confirm Reservation';
    cb.onclick=function(){
      err.style.display='none';var name=ni.value.trim();var phone=pi.value.trim();
      if(!name){err.innerText='Please enter your name.';err.style.display='block';return;}
      if(!phone){err.innerText='Please enter your phone.';err.style.display='block';return;}
      cb.innerText='Processing...';cb.disabled=true;
      fetch(apiBase+'/api/hotel/reserve',{method:'POST',headers:{'Content-Type':'application/json','x-hotel-key':agencyKey},body:JSON.stringify({groupSlug:agencyKey,pkg:p,guestName:name,guestPhone:phone,guestEmail:ei.value.trim()||null,specialRequests:ri.value.trim()||null,addedUpsells:addedUpsells||[],transferInfo:transferInfo||null,channel:'widget'})})
      .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
      .then(function(res){if(!res.ok||!res.data.success){err.innerText=(res.data&&res.data.error)||'Reservation failed.';err.style.display='block';cb.innerText='Confirm Reservation';cb.disabled=false;return;}form.remove();addMsg('🏨 Reservation '+res.data.reservationRef+' confirmed. '+currency+' '+Math.round(total).toLocaleString()+' due.','bot');})
      .catch(function(){err.innerText='Network error.';err.style.display='block';cb.innerText='Confirm Reservation';cb.disabled=false;});
    };
    form.appendChild(cb);messages.appendChild(form);messages.scrollTop=messages.scrollHeight;
  }

  function showHotelGuestFormMulti() {
    var ex=document.getElementById('et-hotel-form');if(ex)ex.remove();
    var form=document.createElement('div');form.className='name-form';form.id='et-hotel-form';
    var fp=document.createElement('p');fp.innerText='Enter your details to complete all reservations:';form.appendChild(fp);
    var ni=document.createElement('input');ni.className='name-input';ni.placeholder='Full name';ni.type='text';form.appendChild(ni);
    var pi=document.createElement('input');pi.className='name-input';pi.placeholder='Phone number';pi.type='tel';form.appendChild(pi);
    var ei=document.createElement('input');ei.className='name-input';ei.placeholder='Email (for voucher)';ei.type='email';form.appendChild(ei);
    var ri=document.createElement('textarea');ri.className='name-input';ri.placeholder='Special requests (optional)';ri.style.cssText='height:56px;resize:none;';form.appendChild(ri);
    var err=document.createElement('div');err.style.cssText='color:var(--et-red);font-size:11px;margin-bottom:8px;display:none;';form.appendChild(err);
    var cb=document.createElement('button');cb.className='confirm-btn';cb.innerText='Confirm All Reservations';
    cb.onclick=function(){
      err.style.display='none';var name=ni.value.trim();var phone=pi.value.trim();
      if(!name){err.innerText='Name required.';err.style.display='block';return;}
      if(!phone){err.innerText='Phone required.';err.style.display='block';return;}
      cb.innerText='Processing...';cb.disabled=true;
      var bookings=Object.values(hotelSelections).map(function(sel){ return {pkg:sel.pkg,addedUpsells:sel.upsells||[],transferInfo:sel.transfer||null}; });
      fetch(apiBase+'/api/hotel/reserve-multi',{method:'POST',headers:{'Content-Type':'application/json','x-hotel-key':agencyKey},body:JSON.stringify({groupSlug:agencyKey,bookings:bookings,guestName:name,guestPhone:phone,guestEmail:ei.value.trim()||null,specialRequests:ri.value.trim()||null,channel:'widget'})})
      .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
      .then(function(res){
        if(!res.ok||!res.data.success){err.innerText=(res.data&&res.data.error)||'Reservation failed.';err.style.display='block';cb.innerText='Confirm All Reservations';cb.disabled=false;return;}
        form.remove();
        var refs=(res.data.refs||[res.data.reservationRef]).join(', ');
        addMsg('🏨 All reservations confirmed! References: '+refs+'. A voucher will be sent to your email.','bot');
        hotelSelections={};
      })
      .catch(function(){err.innerText='Network error.';err.style.display='block';cb.innerText='Confirm All Reservations';cb.disabled=false;});
    };
    form.appendChild(cb);messages.appendChild(form);messages.scrollTop=messages.scrollHeight;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SEND
  // ─────────────────────────────────────────────────────────────────────────
  function send() {
    var text = input.value.trim(); if (!text) return;
    if (isHotelMode && /\b(?:cancel|modify|change|update|manage|view)\b/.test(text.toLowerCase()) && /\b(?:booking|reservation|stay|ref|reference)\b/.test(text.toLowerCase())) {
      addMsg(text,'user');transcript.push({type:'user',text:text});persistState();input.value='';
      addMsg("Of course — please provide your booking reference and the phone number you used.",'bot');return;
    }
    if (legFlow && legFlow._awaitingNewSearch !== undefined && legFlow._awaitingNewSearch !== null) {
      var awaitingLeg = legFlow._awaitingNewSearch; delete legFlow._awaitingNewSearch;
      addMsg(text,'user');transcript.push({type:'user',text:text});persistState();input.value='';
      showTyping();_searchAlternativesForLeg(awaitingLeg,text);return;
    }
    addMsg(text,'user');transcript.push({type:'user',text:text});persistState();
    input.value='';showTyping();
    var endpoint = isHotelMode ? apiBase+'/api/hotel/orchestrate' : apiBase+'/api/trips/orchestrate';
    var hdrs     = isHotelMode
      ? {'Content-Type':'application/json','x-hotel-key': agencyKey}
      : {'Content-Type':'application/json','x-api-key':  agencyKey};
    var body     = isHotelMode
      ? JSON.stringify({prompt:text,groupSlug:agencyKey,sessionId:sessionId,conversationHistory:conversationHistory,previousParams:previousParams})
      : JSON.stringify({prompt:text,agencyId:agencyKey,channelType:'widget',sessionId:sessionId,conversationHistory:conversationHistory,previousParams:(sessionId?previousParams:null)});

    fetch(endpoint,{method:'POST',headers:hdrs,body:body})
    .then(function(r){ return r.json(); })
    .then(function(data){
      hideTyping();

      // TEMP DEBUG — remove after diagnosis
      console.log('[BODRLESS] API response:', JSON.stringify({
        isClassifiedTrip: data.isClassifiedTrip,
        hasTripResults:   !!(data.tripResults && data.tripResults.length),
        tripResultsCount: data.tripResults && data.tripResults.length,
        hasPackages:      !!(data.packages && data.packages.length),
        packagesCount:    data.packages && data.packages.length,
        text:             data.text,
        needsClarification: data.needsClarification,
      }));

      if(data.sessionId)           sessionId           = data.sessionId;
      if(data.tripParams)          previousParams      = data.tripParams;
      if(data.conversationHistory) conversationHistory = data.conversationHistory;

      if(data.needsClarification){var ct=data.text||"Could you give me a bit more detail?";addMsg(ct,'bot');transcript.push({type:'bot',text:ct});persistState();return;}

      var pkgs = data && data.packages ? data.packages : [];
      var isHD = data.isHotelDirect || (pkgs.length > 0 && pkgs[0] && pkgs[0].isHotelDirect);

      // ── CLASSIFIED MULTI-LEG TRIP ────────────────────────────────────────
      if(data.isClassifiedTrip && Array.isArray(data.tripResults)){
        var responseText=data.text||"Here's your trip broken down by leg:";
        var botMsg=addMsg(responseText,'bot');transcript.push({type:'bot',text:responseText});
        var actionableLegs=data.tripResults.filter(function(r){return r.packages&&r.packages.length>0;});
        if(actionableLegs.length>0){
          legFlow={active:true,startedAt:new Date().toISOString(),tripParams:data.tripParams||previousParams,legs:data.tripResults,currentLegIndex:0,selections:{},runningTotalKES:0,_hotelMemory:{}};
          persistState();_syncItineraryToServer();_renderLegFlow();scrollToEl(botMsg);
        }
        return;
      }

      // ── HOTEL MODE ───────────────────────────────────────────────────────
      if(isHD){
        if(!pkgs.length){var nt2=(data&&data.text)?data.text:"No rooms available for those dates.";addMsg(nt2,'bot');transcript.push({type:'bot',text:nt2});persistState();return;}
        var rm2=data.text||"Here's what we have available:";
        var botMsg2=addMsg(rm2,'bot');transcript.push({type:'bot',text:rm2});
        var isMulti = data.requiresAllLegsSelected && data.legSummaries && data.legSummaries.length > 1;
        if(isMulti){
          hotelLegMeta = { legCount: data.legCount, legSummaries: data.legSummaries };
          hotelSelections = {};
          _showMultiPropBar(data.legSummaries, function() { showHotelGuestFormMulti(); });
        }
        pkgs.forEach(function(p,i){
          var legIdx = p._legIndex !== undefined ? p._legIndex : null;
          addHotelPackage(p, i, data.tripParams || previousParams, isMulti, legIdx);
        });
        transcript.push({type:'hotel_packages',packages:pkgs});
        scrollToEl(botMsg2);persistState();return;
      }

      // ── SINGLE DESTINATION ───────────────────────────────────────────────
      if(!pkgs.length){var nt3=(data&&data.text)?data.text:"No options available.";addMsg(nt3,'bot');transcript.push({type:'bot',text:nt3});persistState();return;}
      var rm3=data.text||'I found '+pkgs.length+' option(s) for you:';
      var botMsg3=addMsg(rm3,'bot');transcript.push({type:'bot',text:rm3});
      pkgs.slice(0,4).forEach(function(p,i){
        var card = addPackage(p,i,null,null);
        messages.appendChild(card);
      });
      transcript.push({type:'packages',packages:pkgs.slice(0,4)});
      scrollToEl(botMsg3);persistState();

      // ── Cache refresh spinner ─────────────────────────────────────────────
      if (data.needsRefresh || (data.cacheResult && data.cacheResult.needsRefresh)) {
        var refreshNotice = document.createElement('div');
        refreshNotice.id  = 'et-cache-refresh-notice';
        refreshNotice.style.cssText = [
          'background:#F9F7F4',
          'border:1px solid var(--et-border)',
          'border-radius:10px',
          'padding:8px 12px',
          'font-size:11px',
          'color:var(--et-muted)',
          'display:flex',
          'align-items:center',
          'gap:8px',
          'margin-top:4px',
        ].join(';');
        var spinner = document.createElement('span');
        spinner.style.cssText = [
          'width:10px','height:10px',
          'border:2px solid var(--et-border)',
          'border-top-color:var(--et-navy)',
          'border-radius:50%',
          'display:inline-block',
          'animation:spin 0.8s linear infinite',
          'flex-shrink:0',
        ].join(';');
        if (!document.getElementById('et-spin-style')) {
          var spinStyle = document.createElement('style');
          spinStyle.id  = 'et-spin-style';
          spinStyle.innerText = '@keyframes spin{to{transform:rotate(360deg)}}';
          document.head.appendChild(spinStyle);
        }
        var noticeText = document.createElement('span');
        noticeText.innerText = 'Confirming live prices...';
        refreshNotice.appendChild(spinner);
        refreshNotice.appendChild(noticeText);
        messages.appendChild(refreshNotice);
        messages.scrollTop = messages.scrollHeight;

        setTimeout(function() {
          var prevInput = text;
          fetch(endpoint, {method:'POST', headers:hdrs, body: JSON.stringify({
            prompt:              prevInput,
            agencyId:            agencyKey,
            channelType:         'widget',
            sessionId:           sessionId,
            conversationHistory: conversationHistory,
            previousParams:      previousParams,
            _cacheRefresh:       true,
          })})
          .then(function(r){ return r.json(); })
          .then(function(freshData) {
            var notice = document.getElementById('et-cache-refresh-notice');
            if (notice) notice.remove();
            var freshPkgs = freshData && freshData.packages ? freshData.packages : [];
            if (freshPkgs.length === 0) return;
            var oldBest = pkgs[0] && pkgs[0].summary && pkgs[0].summary.totalPrice;
            var newBest = freshPkgs[0] && freshPkgs[0].summary && freshPkgs[0].summary.totalPrice;
            if (oldBest && newBest && Math.abs(newBest - oldBest) > 500) {
              var direction = newBest > oldBest ? 'up' : 'down';
              var nudge = document.createElement('div');
              nudge.className = 'price-nudge ' + direction;
              nudge.innerText = direction === 'down' ? '📉 Price dropped — updated below' : '📈 Price updated — see below';
              messages.appendChild(nudge);
              messages.scrollTop = messages.scrollHeight;
              freshPkgs.slice(0,4).forEach(function(p,i){ addPackage(p,i,null,null); });
            }
          })
          .catch(function(){
            var notice = document.getElementById('et-cache-refresh-notice');
            if (notice) notice.remove();
          });
        }, 2500);
      }
    })
    .catch(function(e){hideTyping();console.log('Widget error:',e);addMsg('Unable to load options right now. Please try again.','bot');});
  }

  // ── Supplier comparison display ───────────────────────────────────────────
  function addSupplierComparison(container, supplierBreakdown) {
    if (!supplierBreakdown || supplierBreakdown.length === 0) return;
    var compDiv = document.createElement('div');
    compDiv.style.cssText = [
      'padding:8px 14px',
      'background:#F9F7F4',
      'border-top:1px solid var(--et-border)',
      'font-size:11px',
      'color:var(--et-muted)',
    ].join(';');
    var label = document.createElement('div');
    label.style.cssText = 'font-weight:700;color:var(--et-navy);margin-bottom:4px;letter-spacing:0.3px;';
    label.innerText = 'Checked ' + supplierBreakdown.length + ' supplier' + (supplierBreakdown.length > 1 ? 's' : '') + ':';
    compDiv.appendChild(label);
    supplierBreakdown.forEach(function(s) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;padding:2px 0;';
      var name = document.createElement('span');
      name.innerText = s.supplier.charAt(0).toUpperCase() + s.supplier.slice(1);
      if (s.isBest) name.style.fontWeight = '700';
      var price = document.createElement('span');
      price.innerText = s.priceKes ? 'KES ' + Math.round(s.priceKes).toLocaleString() : '—';
      if (s.isBest) {
        price.style.color = 'var(--et-navy)';
        price.style.fontWeight = '700';
        var badge = document.createElement('span');
        badge.style.cssText = 'background:var(--et-green);color:white;font-size:9px;padding:1px 5px;border-radius:8px;margin-left:4px;font-weight:600;';
        badge.innerText = 'best';
        price.appendChild(badge);
      }
      row.appendChild(name); row.appendChild(price);
      compDiv.appendChild(row);
    });
    container.appendChild(compDiv);
  }

  function _searchAlternativesForLeg(legIdx,adjustmentText){
    var leg=legFlow&&legFlow.legs&&legFlow.legs[legIdx];if(!leg){hideTyping();return;}
    var legParams=legFlow&&legFlow.tripParams?Object.assign({},legFlow.tripParams,{origin:leg.label&&leg.label.split('→')[0]&&leg.label.split('→')[0].trim()||legFlow.tripParams.origin,destination:leg.label&&leg.label.split('→')[1]&&leg.label.split('→')[1].trim()||legFlow.tripParams.destination}):previousParams;
    fetch(apiBase+'/api/trips/orchestrate',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':agencyKey},body:JSON.stringify({prompt:adjustmentText+' for the leg: '+(leg.label||''),agencyId:agencyKey,channelType:'widget',sessionId:sessionId,conversationHistory:conversationHistory,previousParams:legParams})})
    .then(function(r){return r.json();})
    .then(function(data){
      hideTyping();
      if(data.packages&&data.packages.length>0){if(!legFlow._cachedOptions)legFlow._cachedOptions={};if(!legFlow._cachedOptions[legIdx])legFlow._cachedOptions[legIdx]=leg.packages;legFlow.legs[legIdx].packages=data.packages;persistState();addMsg('Updated options for '+(leg.label||'this leg')+':','bot');_renderLegFlow();var section=document.getElementById('leg-section-'+legIdx);if(section)scrollToEl(section);}
      else{addMsg(data.text||'No alternatives found.','bot');if(legFlow._cachedOptions&&legFlow._cachedOptions[legIdx]){var rb=document.createElement('button');rb.className='summary-action-btn secondary';rb.style.cssText='margin:8px 0;padding:10px 16px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;border:1.5px solid var(--et-border);background:var(--et-cream);color:var(--et-navy);';rb.innerText='Show original options';rb.onclick=function(){legFlow.legs[legIdx].packages=legFlow._cachedOptions[legIdx];persistState();rb.remove();_renderLegFlow();};messages.appendChild(rb);}}
    })
    .catch(function(){hideTyping();addMsg('Network error.','bot');});
  }

  sendBtn.onclick = send;
  input.addEventListener('keypress', function(e){ if (e.key === 'Enter') send(); });
  console.log('[BODRLESS] Widget loaded — key:' + agencyKey + ' mode:${mode}');
}
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initWidget); } else { initWidget(); }
})();`;

  res.send(widgetCode);
});

module.exports = router;