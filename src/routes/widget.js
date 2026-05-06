function send() {
  var text = input.value.trim();
  if (!text) return;

  addMsg(text, "user");
  input.value = "";

  typing.style.display = "block";

  fetch("https://bodrless-api-v2.onrender.com/api/trips/orchestrate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "bodrless-test-key"
    },
    body: JSON.stringify({
      prompt: text,
      agencyId: "bodrless-test-key",
      channelType: "widget"
    })
  })
  .then(function(res) {
    return res.json();
  })
  .then(function(data) {
    typing.style.display = "none";

    console.log("[BODRLESS WIDGET RESPONSE]", data);

    // ✅ FIX: support multiple response shapes
    var packages =
      (data && data.packages) ||
      (data && data.data && data.data.packages) ||
      [];

    if (packages.length > 0) {
      addMsg("Here are your trip options ✈️", "bot");

      packages.slice(0, 4).forEach(function(pkg) {
        var div = document.createElement("div");
        div.className = "msg bot";

        div.innerHTML = `
          <b>${pkg.hotel?.name || "Hotel Package"}</b><br/>
          $${pkg.summary?.pricePerPerson || pkg.price || "—"} per person<br/>
          <button style="
            margin-top:8px;
            padding:8px 12px;
            border:none;
            background:#1A1A2E;
            color:white;
            border-radius:8px;
            cursor:pointer;
          ">
            View Package
          </button>
        `;

        messages.appendChild(div);
      });

    } else {
      addMsg(
        "I couldn't find packages for that. Try: 'Nairobi to Zanzibar for 2 people, mid budget, 5 nights'",
        "bot"
      );
    }

    scrollBottom();
  })
  .catch(function(err) {
    typing.style.display = "none";

    console.error("[BODRLESS ERROR]", err);

    addMsg(
      "Sorry — something went wrong while generating your trip. Please try again.",
      "bot"
    );
  });
}
