const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  // Sanitize query parameters to mitigate Reflected XSS risks
  const agencyKey  = encodeURIComponent(req.query.key || 'epic-travels');
  const rawAgencyName = req.query.name || 'Epic Travels';
  const agencyName = rawAgencyName.replace(/[/\\*\]\[^$%#@!:'"]/g, ''); 
  const apiBase    = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  // Using template literals allows for a clean, natural JavaScript formatting space
  res.send(`
(function () {
  function initWidget() {
    if (!document.body) { setTimeout(initWidget, 50); return; }
    if (document.getElementById("bodrless-widget-root")) return;

    var conversationHistory = [];
    var previousParams = null;
    var sessionId = null;
    var pollingInterval = null; // Track globally within scope to clear cleanly

    // Feature 1: Global Timeout Wrapper for Streamlined External Network Requests
    function fetchWithTimeout(resource, options = {}) {
      var timeout = options.timeout || 15000; // 15-second default threshold
      return new Promise(function(resolve, reject) {
        var timer = setTimeout(function() { reject(new Error('Request timed out')); }, timeout);
        fetch(resource, options)
          .then(function(response) { clearTimeout(timer); resolve(response); })
          .catch(function(err) { clearTimeout(timer); reject(err); });
      });
    }

    // Feature 2: LocalStorage State Recovery Helpers
    function saveWidgetState(stepName, data) {
      try {
        var state = { stepName: stepName, data: data, timestamp: Date.now() };
        localStorage.setItem('bodrless_widget_state_' + "${agencyKey}", JSON.stringify(state));
      } catch (e) { console.error("Failed to cache state", e); }
    }

    function clearWidgetState() {
      localStorage.removeItem('bodrless_widget_state_' + "${agencyKey}");
    }

    // Dynamic Style Injection
    var style = document.createElement("style");
    style.innerHTML = [
      ":root{--et-navy:#1E2A5E;--et-red:#C0392B;--et-white:#FFFFFF;--et-cream:#F8F9FC;--et-border:#E4E8F0;--et-muted:#8892A4;--et-green:#27ae60;}",
      "#bodrless-chat{position:fixed;bottom:90px;right:24px;width:390px;height:630px;background:var(--et-cream);z-index:999999;display:none;flex-direction:column;border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(30,42,94,0.18);font-family:Arial,sans-serif;}",
      "#bodrless-chat.open{display:flex;}",
      "@keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:0.6;}30%{transform:translateY(-6px);opacity:1;}}",
      "#et-header{background:var(--et-navy);padding:14px 18px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;border-bottom:3px solid var(--et-red);}",
      "#et-header-left{display:flex;align-items:center;gap:12px;}",
      "#et-logo-wrap{width:42px;height:42px;background:white;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;}",
      "#et-logo-wrap img{width:38px;height:38px;object-fit:contain;}",
      "#et-header-text h3{font-size:15px;color:white;margin:0 0 2px 0;}",
      "#et-header-text h3 span{color:var(--et-red);}",
      "#et-header-text p{font-size:10px;color:rgba(255,255,255,0.6);margin:0;letter-spacing:0.8px;text-transform:uppercase;}",
      "#et-close{background:rgba(255,255,255,0.1);border:none;color:white;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:13px;}",
      "#bodrless-messages{flex:1;padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;}",
      ".msg{padding:10px 14px;border-radius:14px;max-width:85%;font-size:13px;line-height:1.5;}",
      ".user{background:var(--et-navy);color:white;margin-left:auto;border-bottom-right-radius:4px;}",
      ".bot{background:var(--et-white);color:var(--et-navy);border:1px solid var(--et-border);border-bottom-left-radius:4px;}",
      ".typing{background:var(--et-white);border:1px solid var(--et-border);padding:12px 16px;border-radius:14px;display:flex;gap:5px;align-items:center;width:fit-content;}",
      ".typing span{width:7px;height:7px;background:var(--et-navy);border-radius:50%;animation:bounce 1.2s infinite;}",
      ".typing span:nth-child(2){animation-delay:0.2s;background:var(--et-red);}",
      ".typing span:nth-child(3){animation-delay:0.4s;}",
      ".et-welcome{background:linear-gradient(135deg,#1E2A5E 0%,#2d3f82 100%);border-radius:16px;padding:16px;color:white;border-left:4px solid #C0392B;}",
      ".et-welcome h4{font-size:14px;margin:0 0 6px 0;}",
      ".et-welcome p{font-size:12px;margin:0 0 12px 0;color:rgba(255,255,255,0.7);line-height:1.5;}",
      ".et-suggestions{display:flex;flex-wrap:wrap;gap:6px;}",
      ".et-suggestion{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.9);padding:5px 10px;border-radius:20px;font-size:11px;cursor:pointer;}",
      ".package{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;overflow:visible;height:auto;box-shadow:0 2px 10px rgba(30,42,94,0.07);margin-bottom:8px;}",
      ".pkg-header{background:var(--et-navy);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-radius:14px 14px 0 0;}",
      ".pkg-title{color:white;font-size:13px;font-weight:600;}",
      ".pkg-route{background:var(--et-red);color:white;font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".pkg-body{padding:12px 14px;display:flex;flex-direction:column;height:auto;}",
      ".pkg-row{display:flex;flex-direction:column;padding:8px 0;border-bottom:1px dashed var(--et-border);}",
      ".pkg-row:last-child{border-bottom:none;}",
      ".pkg-label{font-size:10px;font-weight:700;color:var(--et-red);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;}",
      ".pkg-name{font-size:13px;font-weight:600;color:var(--et-navy);margin-bottom:2px;}",
      ".pkg-sub{font-size:11px;color:var(--et-muted);line-height:1.4;}",
      ".pkg-footer{padding:10px 14px;background:var(--et-cream);display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--et-border);height:auto;border-radius:0 0 14px 14px;}",
      ".pkg-price{font-size:20px;font-weight:700;color:var(--et-navy);line-height:1;}",
      ".pkg-price small{font-size:10px;color:var(--et-muted);display:block;font-weight:400;margin-top:2px;}",
      ".book{background:var(--et-red);color:white;border:none;padding:9px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;}",
      ".book:disabled{opacity:0.7;cursor:not-allowed;}",
      "#bodrless-input-area{display:flex;border-top:1px solid var(--et-border);background:var(--et-white);padding:10px 12px;gap:8px;flex-shrink:0;}",
      "#bodrless-input{flex:1;padding:10px 14px;border:1.5px solid var(--et-border);border-radius:20px;outline:none;font-size:13px;background:var(--et-cream);color:var(--et-navy);}",
      "#bodrless-input:focus{border-color:var(--et-navy);}",
      "#bodrless-input::placeholder{color:var(--et-muted);font-size:12px;}",
      "#bodrless-send{background:var(--et-navy);color:white;border:none;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
      "#bodrless-trigger{position:fixed;bottom:24px;right:24px;z-index:999998;background:var(--et-navy);color:white;border:none;padding:13px 20px;border-radius:999px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(30,42,94,0.35);border-left:3px solid var(--et-red);}",
      ".name-form{background:var(--et-white);border:1px solid var(--et-border);border-radius:14px;padding:14px;margin-top:8px;}",
      ".name-form p{font-size:12px;color:var(--et-navy);margin:0 0 10px 0;font-weight:500;}",
      ".name-input{width:100%;padding:9px 12px;border:1.5px solid var(--et-border);border-radius:10px;outline:none;font-size:12px;color:var(--et-navy);box-sizing:border-box;margin-bottom:10px;}",
      ".dob-row{display:flex;gap:6px;margin-bottom:10px;}",
      ".dob-row select{flex:1;padding:9px 4px;border:1.5px solid var(--et-border);border-radius:10px;outline:none;font-size:12px;color:var(--et-navy);box-sizing:border-box;background:white;}",
      ".field-label{font-size:10px;color:var(--et-muted);margin-bottom:4px;font-weight:600;}",
      ".confirm-btn{background:var(--et-navy);color:white;border:none;padding:9px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;width:100%;}",
      ".trust-badge{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:10px;font-size:10px;color:var(--et-muted);}",
      ".trust-badge svg{width:13px;height:13px;flex-shrink:0;}",
      ".itin-stop{padding:10px 0;border-bottom:1px dashed var(--et-border);}",
      ".itin-stop:last-child{border-bottom:none;}",
      ".itin-stop.buffer{opacity:0.85;}",
      ".itin-stop-title{font-size:12px;font-weight:700;color:var(--et-navy);margin-bottom:4px;}",
      ".itin-stop-title.buffer{color:var(--et-muted);font-style:italic;}",
      ".itin-line{font-size:11px;color:var(--et-muted);line-height:1.5;margin-bottom:2px;}",
      ".itin-connects{font-size:10px;color:var(--et-red);font-style:italic;}"
    ].join("");
    document.head.appendChild(style);

    // Structural Base Instantiation
    var root = document.createElement("div");
    root.id = "bodrless-widget-root";
    var chatDiv = document.createElement("div");
    chatDiv.id = "bodrless-chat";
    
    var header = document.createElement("div");
    header.id = "et-header";
    var headerLeft = document.createElement("div");
    headerLeft.id = "et-header-left";
    var logoWrap = document.createElement("div");
    logoWrap.id = "et-logo-wrap";
    var logoImg = document.createElement("img");
    logoImg.src = "https://epictravels.co.ke/apple-touch-icon.png";
    logoImg.alt = "${agencyName}";
    logoImg.onerror = function() { this.parentNode.innerText = "ET"; };
    logoWrap.appendChild(logoImg);
    
    var headerText = document.createElement("div");
    headerText.id = "et-header-text";
    headerText.innerHTML = "<h3><span>" + "${agencyName}" + "</span></h3><p>Premium Travel Specialist</p>";
    headerLeft.appendChild(logoWrap);
    headerLeft.appendChild(headerText);
    
    var closeBtn = document.createElement("button");
    closeBtn.id = "et-close";
    closeBtn.innerText = "X";
    header.appendChild(headerLeft);
    header.appendChild(closeBtn);
    
    var messages = document.createElement("div");
    messages.id = "bodrless-messages";
    var inputArea = document.createElement("div");
    inputArea.id = "bodrless-input-area";
    var input = document.createElement("input");
    input.id = "bodrless-input";
    input.placeholder = "Where would you like to go?";
    var sendBtn = document.createElement("button");
    sendBtn.id = "bodrless-send";
    sendBtn.innerText = "Send";
    
    inputArea.appendChild(input);
    inputArea.appendChild(sendBtn);
    chatDiv.appendChild(header);
    chatDiv.appendChild(messages);
    chatDiv.appendChild(inputArea);
    root.appendChild(chatDiv);
    document.body.appendChild(root);
    
    var triggerBtn = document.createElement("button");
    triggerBtn.id = "bodrless-trigger";
    triggerBtn.innerText = "Plan Your Trip";
    document.body.appendChild(triggerBtn);
    
    var welcomeShown = false;
    triggerBtn.onclick = function() { 
      chatDiv.classList.add("open"); 
      input.focus(); 
      if (!welcomeShown) { 
        welcomeShown = true; 
        showWelcome(); 
      } 
    };
    closeBtn.onclick = function() { chatDiv.classList.remove("open"); };

    function showWelcome() {
      var div = document.createElement("div");
      div.className = "et-welcome";
      var h4 = document.createElement("h4");
      h4.innerText = "Welcome to " + "${agencyName}";
      var p = document.createElement("p");
      p.innerText = "Tell me your dream destination and I will find the perfect package - flights, hotels and transfers included.";
      var suggestionsDiv = document.createElement("div");
      suggestionsDiv.className = "et-suggestions";
      var suggestions = ["Nairobi to Zanzibar","Cape Town 5 nights","Masai Mara Safari","Kigali Rwanda","Cairo Egypt"];
      suggestions.forEach(function(s) {
        var btn = document.createElement("span");
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
      var div = document.createElement("div");
      div.className = "msg " + type;
      div.innerText = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function showTyping() {
      var div = document.createElement("div");
      div.className = "typing";
      div.id = "et-typing";
      div.innerHTML = "<span></span><span></span><span></span>";
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function hideTyping() {
      var t = document.getElementById("et-typing");
      if (t) t.remove();
    }

    function fmtTime(iso) {
      if (!iso) return "TBC";
      try {
        var d = new Date(iso);
        if (isNaN(d)) return iso;
        return d.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" });
      } catch(e) { return iso; }
    }

    function fmtPrice(n, cur) {
      return (cur || "KES") + " " + (Math.round(Number(n) || 0)).toLocaleString();
    }

    function titleCase(str) {
      if (!str) return "";
      return String(str).replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
    }

    function makeRow(label, name, sub) {
      var row = document.createElement("div");
      row.className = "pkg-row";
      var labelEl = document.createElement("div");
      labelEl.className = "pkg-label";
      labelEl.innerText = label;
      var nameEl = document.createElement("div");
      nameEl.className = "pkg-name";
      nameEl.innerText = name;
      var subEl = document.createElement("div");
      subEl.className = "pkg-sub";
      subEl.innerText = sub;
      row.appendChild(labelEl);
      row.appendChild(nameEl);
      row.appendChild(subEl);
      return row;
    }

    function pollBookingStatus(bookingRef, bookBtn) {
      var attempts = 0;
      var maxAttempts = 40;
      if (pollingInterval) clearInterval(pollingInterval);

      pollingInterval = setInterval(function() {
        attempts++;
        fetchWithTimeout("${apiBase}" + "/api/trips/booking/" + bookingRef, { timeout: 6000 })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.bookingStage === "paid") {
              clearInterval(pollingInterval);
              clearWidgetState(); // Clear saved checkout state on success
              bookBtn.innerText = "Paid & Confirmed!";
              bookBtn.style.background = "#27ae60";
              addMsg("Payment received! Your booking " + bookingRef + " is fully confirmed. You will receive your e-ticket and hotel confirmation shortly.", "bot");
              messages.scrollTop = messages.scrollHeight;
            } else if (data.bookingStage === "failed" || data.status === "cancelled") {
              clearInterval(pollingInterval);
              clearWidgetState();
              bookBtn.innerText = "Payment not received";
              bookBtn.style.background = "#C0392B";
              addMsg("We did not receive payment in time for booking " + bookingRef + ", so the hold was released. Feel free to search again if you would still like to book.", "bot");
              messages.scrollTop = messages.scrollHeight;
            } else if (attempts >= maxAttempts) {
              clearInterval(pollingInterval);
              addMsg("Still waiting on payment for booking " + bookingRef + ". If you have already paid, this will update shortly \u2014 otherwise your hold is still intact.", "bot");
              messages.scrollTop = messages.scrollHeight;
            }
          })
          .catch(function() { /* graceful silent retry on tick lag */ });
      }, 5000);
    }

    function showNameForm(p, bookBtn) {
      var existing = document.getElementById("et-name-form");
      if (existing) existing.remove();
      
      var passengerCount = (p.summary && p.summary.passengers) ? p.summary.passengers : 1;
      var needsFlightDetails = false;
      if (p.isMultiDestination) {
        needsFlightDetails = (p.legs || []).some(function(leg) { return leg.transportIn && (leg.transportIn.transportType || "flight") === "flight"; })
          || !!(p.returnTransport && (p.returnTransport.transportType || "flight") === "flight");
      } else {
        needsFlightDetails = !!(p.transport && (p.transport.transportType || "flight") === "flight");
      }

      var form = document.createElement("div");
      form.className = "name-form";
      form.id = "et-name-form";
      var formP = document.createElement("p");
      formP.innerText = needsFlightDetails
        ? "Enter passenger details to confirm booking:"
        : "Enter your details to confirm booking:";
      form.appendChild(formP);

      var passengerInputs = [];
      var currentYear = new Date().getFullYear();

      function buildDobRow() {
        var row = document.createElement("div");
        row.className = "dob-row";
        var daySel = document.createElement("select");
        daySel.innerHTML = "<option value=\\"\\">Day</option>" + Array.from({length:31}, function(_, i) { return "<option value=\\"" + (i+1) + "\\">" + (i+1) + "</option>"; }).join("");
        var monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        var monthSel = document.createElement("select");
        monthSel.innerHTML = "<option value=\\"\\">Month</option>" + monthNames.map(function(m, i) { return "<option value=\\"" + (i+1) + "\\">" + m + "</option>"; }).join("");
        var yearSel = document.createElement("select");
        yearSel.innerHTML = "<option value=\\"\\">Year</option>" + Array.from({length:100}, function(_, i) { return currentYear - i; }).map(function(y) { return "<option value=\\"" + y + "\\">" + y + "</option>"; }).join("");
        row.appendChild(daySel);
        row.appendChild(monthSel);
        row.appendChild(yearSel);
        return { row: row, daySel: daySel, monthSel: monthSel, yearSel: yearSel };
      }

      for (var pi = 0; pi < passengerCount; pi++) {
        var pBlock = document.createElement("div");
        pBlock.style.marginBottom = "12px";
        pBlock.style.paddingBottom = "10px";
        pBlock.style.borderBottom = (pi < passengerCount - 1) ? "1px dashed #E4E8F0" : "none";
        if (passengerCount > 1) {
          var pLabel = document.createElement("div");
          pLabel.style.cssText = "font-size:11px; font-weight:700; color:#1E2A5E; margin-bottom:6px;";
          pLabel.innerText = "Traveler " + (pi + 1);
          pBlock.appendChild(pLabel);
        }
        var firstNameInput = document.createElement("input");
        firstNameInput.className = "name-input";
        firstNameInput.placeholder = "First name";
        firstNameInput.type = "text";
        pBlock.appendChild(firstNameInput);

        var lastNameInput = document.createElement("input");
        lastNameInput.className = "name-input";
        lastNameInput.placeholder = "Last name";
        lastNameInput.type = "text";
        pBlock.appendChild(lastNameInput);

        var dobLabel = document.createElement("div");
        dobLabel.className = "field-label";
        dobLabel.innerText = "Date of birth";
        pBlock.appendChild(dobLabel);

        var dob = buildDobRow();
        pBlock.appendChild(dob.row);

        var genderSelect = document.createElement("select");
        genderSelect.className = "name-input";
        genderSelect.innerHTML = "<option value=\\"male\\">Male</option><option value=\\"female\\">Female</option>";
        pBlock.appendChild(genderSelect);

        var childRow = document.createElement("label");
        childRow.style.cssText = "display:flex; align-items:center; gap:6px; font-size:11px; color:#1E2A5E; margin-bottom:8px;";
        var childCheckbox = document.createElement("input");
        childCheckbox.type = "checkbox";
        childRow.appendChild(childCheckbox);
        childRow.appendChild(document.createTextNode("This traveler is a child"));
        pBlock.appendChild(childRow);

        var idLabel = document.createElement("div");
        idLabel.className = "field-label";
        idLabel.innerText = "Passport or National ID number";
        pBlock.appendChild(idLabel);

        var idInput = document.createElement("input");
        idInput.className = "name-input";
        idInput.placeholder = "Passport / ID number";
        idInput.type = "text";
        pBlock.appendChild(idInput);

        childCheckbox.onchange = (function(inp) { 
          return function(e) { 
            inp.placeholder = e.target.checked ? "Passport / ID number (optional for children)" : "Passport / ID number"; 
          }; 
        })(idInput);

        passengerInputs.push({
          firstNameInput: firstNameInput, lastNameInput: lastNameInput,
          daySel: dob.daySel, monthSel: dob.monthSel, yearSel: dob.yearSel,
          genderSelect: genderSelect, childCheckbox: childCheckbox, idInput: idInput
        });
        form.appendChild(pBlock);
      }

      var contactLabel = document.createElement("div");
      contactLabel.style.cssText = "font-size:11px; font-weight:700; color:#1E2A5E; margin-bottom:6px;";
      contactLabel.innerText = "Contact details";
      form.appendChild(contactLabel);

      var phoneInput = document.createElement("input");
      phoneInput.className = "name-input";
      phoneInput.placeholder = "Phone (e.g. 0712345678)";
      phoneInput.type = "tel";
      form.appendChild(phoneInput);

      var emailInput = document.createElement("input");
      emailInput.className = "name-input";
      emailInput.placeholder = "Email";
      emailInput.type = "email";
      form.appendChild(emailInput);

      var errorMsg = document.createElement("div");
      errorMsg.style.cssText = "color:#C0392B; font-size:11px; margin-bottom:8px; display:none;";
      form.appendChild(errorMsg);

      var confirmBtn = document.createElement("button");
      confirmBtn.className = "confirm-btn";
      confirmBtn.innerText = "Confirm Booking";
      
      confirmBtn.onclick = function() {
        errorMsg.style.display = "none";
        var passengers = [];
        for (var k = 0; k < passengerInputs.length; k++) {
          var pin = passengerInputs[k];
          var fn = pin.firstNameInput.value.trim();
          var ln = pin.lastNameInput.value.trim();
          if (!fn || !ln) { errorMsg.innerText = "Please fill in all traveler names."; errorMsg.style.display = "block"; return; }
          var day = pin.daySel.value, month = pin.monthSel.value, year = pin.yearSel.value;
          if (!day || !month || !year) { errorMsg.innerText = "Please select a complete date of birth for traveler " + (k+1) + "."; errorMsg.style.display = "block"; return; }
          var dobString = year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
          var isChild = pin.childCheckbox.checked;
          var idNum = pin.idInput.value.trim();
          if (!isChild && !idNum) { errorMsg.innerText = "Passport/ID number is required for traveler " + (k+1) + " (unless marked as a child)."; errorMsg.style.display = "block"; return; }
          passengers.push({
            firstName: fn, lastName: ln, dateOfBirth: dobString,
            gender: pin.genderSelect.value, type: isChild ? "child" : "adult", idNumber: idNum || null
          });
        }
        var phone = phoneInput.value.trim();
        var email = emailInput.value.trim();
        if (!phone) { errorMsg.innerText = "Phone number is required."; errorMsg.style.display = "block"; return; }
        if (needsFlightDetails && !email) { errorMsg.innerText = "Email is required for flight bookings."; errorMsg.style.display = "block"; return; }
        
        var guestName = passengers[0].firstName + " " + passengers[0].lastName;
        confirmBtn.innerText = "Processing...";
        confirmBtn.disabled = true;

        // Automatically preserve form progress data before shooting network calls
        saveWidgetState('passenger-form', { package: p, phone: phone, email: email, passengers: passengers });

        function runPaymentWorkflow() {
          fetchWithTimeout("${apiBase}" + "/api/trips/book-init", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agencyId: "${agencyKey}", guestName: guestName, guestPhone: phone, guestEmail: email, passengers: passengers, package: p })
          })
          .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
          .then(function(result) {
            if (!result.ok || !result.data.success) {
              var msg = (result.data && result.data.error) ? result.data.error : "Booking failed. Please try again.";
              errorMsg.innerText = msg;
              errorMsg.style.display = "block";
              confirmBtn.innerText = "Confirm Booking";
              confirmBtn.disabled = false;
              return;
            }
            var bookingRef = result.data.bookingRef;
            var totalPrice = result.data.totalPrice;
            var currency = result.data.currency;
            
            confirmBtn.innerText = "Sending M-Pesa prompt...";
            addMsg("Flight held and hotel confirmed! Ref: " + bookingRef + ". Total due: " + currency + " " + totalPrice.toLocaleString() + ". Sending M-Pesa payment prompt to " + phone + " now...", "bot");
            messages.scrollTop = messages.scrollHeight;

            function fireStkPush() {
              return fetchWithTimeout("${apiBase}" + "/api/trips/book-pay", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ bookingRef: bookingRef, phone: phone, amount: totalPrice, currency: currency, email: email, firstName: passengers[0].firstName, lastName: passengers[0].lastName })
              })
              .then(function(pr) { return pr.json().then(function(pdata) { return { ok: pr.ok, data: pdata }; }); })
              .then(function(payResult) {
                form.remove();
                if (!payResult.ok || !payResult.data.success) {
                  bookBtn.innerText = "Payment failed to send";
                  bookBtn.style.background = "#C0392B";
                  addMsg("Your options are safely held, but we could not fire the prompt automatically (" + (payResult.data.error || "network congestion") + "). Please contact assistance with ref " + bookingRef + ".", "bot");
                  return;
                }
                
                bookBtn.innerText = "Awaiting payment...";
                bookBtn.style.background = "#f0ad4e";
                bookBtn.disabled = true;
                
                // Feature 3: M-Pesa Interactive Countdown Assistant Injection
                var assistanceContainer = document.createElement("div");
                assistanceContainer.id = "mpesa-countdown-assistance";
                assistanceContainer.style.cssText = "background: #fff; border: 1px solid var(--et-border); border-radius: 14px; padding: 14px; margin-top: 8px; font-size:12px; text-align:center; color:var(--et-navy);";
                assistanceContainer.innerHTML = "Confirming prompt transmission... <strong id='stk-secs'>20</strong>s remaining.";
                messages.appendChild(assistanceContainer);
                messages.scrollTop = messages.scrollHeight;

                var secondsRemaining = 20;
                var ticker = setInterval(function() {
                  secondsRemaining--;
                  var counterNode = document.getElementById('stk-secs');
                  if (counterNode) counterNode.textContent = secondsRemaining;
                  
                  if (secondsRemaining <= 0) {
                    clearInterval(ticker);
                    var supportFrame = document.getElementById('mpesa-countdown-assistance');
                    if (supportFrame) {
                      supportFrame.innerHTML = "<p style='color:#C0392B; margin:0 0 8px 0; font-weight:600;'>Didn't see the SIM PIN popup?</p>" +
                        "<button id='retry-stk-push-btn' style='background:var(--et-navy); color:#fff; border:none; padding:6px 14px; font-size:11px; font-weight:600; border-radius:20px; cursor:pointer;'>Resend STK Push Prompt</button>";
                      
                      document.getElementById('retry-stk-push-btn').onclick = function() {
                        supportFrame.remove();
                        fireStkPush(); // Re-trigger standard payment endpoint workflow natively
                      };
                    }
                  }
                }, 1000);

                addMsg("Please look at your phone, enter your M-Pesa PIN, and wait for confirmation. This hold is locked for 30 minutes.", "bot");
                messages.scrollTop = messages.scrollHeight;
                pollBookingStatus(bookingRef, bookBtn);
              });
            }

            fireStkPush();
          })
          .catch(function() {
            errorMsg.innerText = "Connection latency detected. Please retry or verify your parameter parameters.";
            errorMsg.style.display = "block";
            confirmBtn.innerText = "Confirm Booking";
            confirmBtn.disabled = false;
          });
        }

        runPaymentWorkflow();
      };

      form.appendChild(confirmBtn);
      var trustBadge = document.createElement("div");
      trustBadge.className = "trust-badge";
      trustBadge.innerHTML = "<svg viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"><path d=\\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\\"/><path d=\\"M9 12l2 2 4-4\\"/></svg> Secure processing via IntaSend M-Pesa";
      form.appendChild(trustBadge);
      messages.appendChild(form);
      messages.scrollTop = messages.scrollHeight;
    }

    // Fixed Cutoff - Restructured Dynamic Packaging Component Generator Engine
    function addPackage(p, i) {
      var div = document.createElement("div");
      div.className = "package";
      div.style.height = "auto";
      
      var transport       = p.transport       || null;
      var returnTransport = p.returnTransport || null;
      var hotel           = p.hotel           || null;
      var transfers       = p.transfers       || null;
      var summary         = p.summary         || {};
      
      var totalCurrency = summary.currency || "KES";
      var total         = Math.round(summary.totalPrice || 0);
      var ppp           = Math.round(summary.pricePerPerson || 0);
      var nights        = summary.nights    || 0;
      var passengers    = summary.passengers || 1;
      var route         = summary.route || ((transport && transport.origin ? transport.origin : "TBC") + " to " + (transport && transport.destination ? transport.destination : "TBC"));
      
      var pkgHeader = document.createElement("div");
      pkgHeader.className = "pkg-header";
      var pkgTitle = document.createElement("span");
      pkgTitle.className = "pkg-title";
      pkgTitle.innerText = "Option " + (i + 1);
      var pkgRoute = document.createElement("span");
      pkgRoute.className = "pkg-route";
      pkgRoute.innerText = route;
      pkgHeader.appendChild(pkgTitle);
      pkgHeader.appendChild(pkgRoute);
      
      var pkgBody = document.createElement("div");
      pkgBody.className = "pkg-body";
      pkgBody.style.height = "auto";
      
      if (transport) {
        var isbus = (transport.transportType || "").toLowerCase() === "bus";
        var tLabel = isbus ? "Outbound Bus" : "Outbound Flight";
        var tName  = transport.airline || transport.provider || "TBC";
        var tSub   = (transport.origin || "TBC") + " \u2192 " + (transport.destination || "TBC") +
                     " | " + fmtTime(transport.departureTime) + " - " + fmtTime(transport.arrivalTime);
        if (transport.stops) tSub += " | " + transport.stops;
        if (transport.cabinClass) tSub += " | " + transport.cabinClass;
        if (!isbus && transport.baggageSummary) tSub += " | " + transport.baggageSummary;
        if (transport.policySummary) tSub += " | " + transport.policySummary;
        else if (isbus && transport.cancellationPolicy) tSub += " | " + transport.cancellationPolicy;
        tSub += " | " + fmtPrice(transport.price, transport.currency);
        pkgBody.appendChild(makeRow(tLabel, tName, tSub));
      }
      
      if (returnTransport) {
        var isRetBus = (returnTransport.transportType || "").toLowerCase() === "bus";
        var rtLabel = isRetBus ? "Return Bus" : "Return Flight";
        var rtName  = returnTransport.airline || returnTransport.provider || "TBC";
        var rtSub   = (returnTransport.origin || "TBC") + " \u2192 " + (returnTransport.destination || "TBC") +
                      " | " + fmtTime(returnTransport.departureTime) + " - " + fmtTime(returnTransport.arrivalTime);
        if (returnTransport.stops) rtSub += " | " + returnTransport.stops;
        if (!isRetBus && returnTransport.baggageSummary) rtSub += " | " + returnTransport.baggageSummary;
        if (returnTransport.policySummary) rtSub += " | " + returnTransport.policySummary;
        else if (isRetBus && returnTransport.cancellationPolicy) rtSub += " | " + returnTransport.cancellationPolicy;
        rtSub += " | " + fmtPrice(returnTransport.price, returnTransport.currency);
        pkgBody.appendChild(makeRow(rtLabel, rtName, rtSub));
      }
      
      if (hotel) {
        var stars = hotel.stars ? Array(Math.min(Math.round(hotel.stars), 5) + 1).join("★") : "";
        var hName = hotel.name || "Target Hotel Accommodations";
        if (stars) hName += " " + stars;
        var hSub = (hotel.roomType || "Standard Fitted Suite") + " | " + (hotel.boardBasis || "Bed and Breakfast") + " | " + nights + " Night(s)";
        hSub += " | " + fmtPrice(hotel.price, hotel.currency);
        pkgBody.appendChild(makeRow("Hotel Inventory", hName, hSub));
      }

      if (transfers) {
        var xName = transfers.provider || "Private Dynamic Operator";
        var xSub = (transfers.type || "Bidirectional Private Shuttle") + " | Integrated Ground Route Context";
        xSub += " | " + fmtPrice(transfers.price, transfers.currency);
        pkgBody.appendChild(makeRow("Ground Transfers", xName, xSub));
      }
      
      var pkgFooter = document.createElement("div");
      pkgFooter.className = "pkg-footer";
      var pkgPrice = document.createElement("div");
      pkgPrice.className = "pkg-price";
      pkgPrice.innerHTML = fmtPrice(total, totalCurrency) + (passengers > 1 ? " <small>" + fmtPrice(ppp, totalCurrency) + " / traveler</small>" : "");
      
      var bookBtn = document.createElement("button");
      bookBtn.className = "book";
      bookBtn.innerText = "Select Options";
      bookBtn.onclick = function() { showNameForm(p, bookBtn); };
      
      pkgFooter.appendChild(pkgPrice);
      pkgFooter.appendChild(bookBtn);
      div.appendChild(pkgHeader);
      div.appendChild(pkgBody);
      div.appendChild(pkgFooter);
      
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    // State Hydration Check
    try {
      var cachedState = localStorage.getItem('bodrless_widget_state_' + "${agencyKey}");
      if (cachedState) {
        var parsedState = JSON.parse(cachedState);
        // Clean out cache blocks older than 25 minutes to protect dynamic inventory integrity
        if (Date.now() - parsedState.timestamp < 1500000) {
          welcomeShown = true;
          chatDiv.classList.add("open");
          addMsg("Welcome back! Restoring your configuration workspace from your ongoing draft context...", "bot");
          showNameForm(parsedState.data.package, triggerBtn); 
        } else {
          clearWidgetState();
        }
      }
    } catch(e) { console.warn("Hydration sync skipped", e); }

    // Core Inbound Network Core Loop
    function send() {
      var val = input.value.trim();
      if (!val) return;
      input.value = "";
      addMsg(val, "user");
      showTyping();
      
      fetchWithTimeout("${apiBase}" + "/api/trips/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: val, history: conversationHistory, agencyId: "${agencyKey}", sessionId: sessionId })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        hideTyping();
        if (data.sessionId) sessionId = data.sessionId;
        if (data.history) conversationHistory = data.history;
        
        if (data.reply) {
          addMsg(data.reply, "bot");
        }
        if (data.packages && data.packages.length > 0) {
          data.packages.forEach(function(pkg, idx) {
            addPackage(pkg, idx);
          });
        }
      })
      .catch(function() {
        hideTyping();
        addMsg("We encountered an error analyzing your request. Please confirm parameters or verify the network environment.", "bot");
      });
    }

    sendBtn.onclick = send;
    input.onkeydown = function(e) { if (e.key === "Enter") send(); };
  }
  initWidget();
})();
  `);
});

module.exports = router;