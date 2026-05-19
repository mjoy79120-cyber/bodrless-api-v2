const express = require("express");
const multer = require("multer");
const fs = require("fs");
const csv = require("csv-parser");

const router = express.Router();

const upload = multer({
  dest: "src/uploads/inventory/"
});

let uploadedInventory = [];

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function detectType(data, values) {

  const searchable = JSON.stringify(data).toLowerCase();

  if (
    searchable.includes("flight") ||
    searchable.includes("airline")
  ) {
    return "flight";
  }

  if (
    searchable.includes("hotel") ||
    searchable.includes("resort") ||
    searchable.includes("villa")
  ) {
    return "hotel";
  }

  if (
    searchable.includes("transfer") ||
    searchable.includes("airport pickup")
  ) {
    return "transfer";
  }

  if (
    searchable.includes("bus")
  ) {
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
    data.cost
  ];

  for (const field of possiblePriceFields) {

    const num = Number(field);

    if (!isNaN(num) && num > 0) {
      return num;
    }
  }

  // fallback scan entire row
  for (const value of values) {

    const cleaned =
      String(value)
        .replace("$", "")
        .replace(",", "")
        .trim();

    const num = Number(cleaned);

    if (!isNaN(num) && num > 0) {
      return num;
    }
  }

  return 0;
}

// ─────────────────────────────────────────────
// POST UPLOAD
// ─────────────────────────────────────────────
router.post("/", upload.single("inventory"), (req, res) => {

  if (!req.file) {

    return res.status(400).json({
      success: false,
      error: "No file uploaded"
    });
  }

  const results = [];

  fs.createReadStream(req.file.path)

    .pipe(csv())

    .on("data", (data) => {

      const values = Object.values(data);

      const normalized = {

        type: detectType(data, values),

        provider:
          data["Agent Name"] ||
          data.provider ||
          "",

        name:
          data["Item Description"] ||
          data.provider_or_name ||
          data.name ||
          data.hotel ||
          data.airline ||
          values[0] ||
          "Unknown",

        location:
          data["Specific City/Region"] ||
          data.origin_or_city ||
          data.city ||
          data.origin ||
          data.location ||
          values[1] ||
          "",

        destination:
          data.Country ||
          data.destination_or_country ||
          data.destination ||
          values[2] ||
          "",

        price:
          extractPrice(data, values),

        capacity:
          Number(
            data["Available Units"] ||
            data.capacity ||
            0
          ),

        availability:
          data["Availability Status"] ||
          "Available",

        category:
          data.category || "",

        notes:
          data.duration_or_notes ||
          data.notes ||
          ""
      };

      results.push(normalized);
    })

    .on("end", () => {

      uploadedInventory = results;

      // SAVE JSON
      fs.writeFileSync(
        "src/data/uploadedInventory.json",
        JSON.stringify(results, null, 2)
      );

      console.log(
        "Normalized Inventory:",
        uploadedInventory
      );

      res.json({
        success: true,
        uploadedRows: results.length,
        inventory: results
      });
    })

    .on("error", (err) => {

      console.error(err);

      res.status(500).json({
        success: false,
        error: err.message
      });
    });
});


// ─────────────────────────────────────────────
// GET INVENTORY
// ─────────────────────────────────────────────
router.get("/", (req, res) => {

  res.json({
    success: true,
    total: uploadedInventory.length,
    inventory: uploadedInventory
  });
});

module.exports = router;