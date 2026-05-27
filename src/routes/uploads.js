const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const supabase = require("../utils/supabase");

const router = express.Router();

const upload = multer({
  dest: "tmp/"
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function detectType(data) {

  const searchable = JSON.stringify(data).toLowerCase();

  if (searchable.includes("flight") || searchable.includes("airline")) {
    return "flight";
  }

  if (searchable.includes("hotel") || searchable.includes("resort") || searchable.includes("villa")) {
    return "hotel";
  }

  if (searchable.includes("transfer") || searchable.includes("airport pickup")) {
    return "transfer";
  }

  if (searchable.includes("bus")) {
    return "bus";
  }

  return "unknown";
}

function extractPrice(data, values) {

  const possiblePriceFields = [
    data["Rate (USD)"],
    data.price,
    data.amount,
    data.price_usd,
    data.cost,
    data["price_per_night_usd"]
  ];

  for (const field of possiblePriceFields) {
    const num = Number(field);
    if (!isNaN(num) && num > 0) return num;
  }

  for (const value of values) {
    const cleaned = String(value)
      .replace("$", "")
      .replace(",", "")
      .trim();

    const num = Number(cleaned);
    if (!isNaN(num) && num > 0) return num;
  }

  return 0;
}

// ─────────────────────────────────────────────
// POST UPLOAD (SUPABASE VERSION)
// ─────────────────────────────────────────────
router.post("/", upload.single("inventory"), async (req, res) => {

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "No file uploaded"
    });
  }

  const agencyId = req.body.agencyId;
  const fileType = req.body.fileType;

  if (!agencyId || !fileType) {
    return res.status(400).json({
      success: false,
      error: "agencyId and fileType required"
    });
  }

  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (data) => {

      const values = Object.values(data);

      const normalized = {

        type: fileType || detectType(data),

        name:
          data.hotel_name ||
          data.airline ||
          data.name ||
          values[0] ||
          "Unknown",

        location:
          data.city ||
          data.location ||
          data.origin ||
          values[1] ||
          "",

        destination:
          data.destination ||
          data.country ||
          values[2] ||
          "",

        origin: data.origin || "",
        airline: data.airline || "",

        price: extractPrice(data, values),

        provider: data.provider || data["Agent Name"] || ""
      };

      results.push(normalized);
    })

    .on("end", async () => {

      try {

        // ─────────────────────────────────────────
        // SAVE TO SUPABASE (CORE FIX)
        // ─────────────────────────────────────────

        for (const item of results) {

          if (fileType === "hotels") {

            await supabase.from("hotels").insert({
              agency_id: agencyId,
              name: item.name,
              location: item.location,
              price_per_night: item.price,
              stars: 4,
              rating: 4.5
            });
          }

          if (fileType === "flights") {

            await supabase.from("flights").insert({
              agency_id: agencyId,
              origin: item.origin,
              destination: item.destination,
              airline: item.airline,
              price: item.price,
              flight_number: "AUTO"
            });
          }

          if (fileType === "transfers") {

            await supabase.from("transfers").insert({
              agency_id: agencyId,
              provider: item.name,
              vehicle_type: "Car",
              price: item.price
            });
          }
        }

        res.json({
          success: true,
          agencyId,
          fileType,
          uploadedRows: results.length,
          message: "Uploaded to Supabase successfully"
        });

      } catch (err) {

        console.error(err);

        res.status(500).json({
          success: false,
          error: err.message
        });
      }
    })

    .on("error", (err) => {

      console.error(err);

      res.status(500).json({
        success: false,
        error: err.message
      });
    });
});

module.exports = router;