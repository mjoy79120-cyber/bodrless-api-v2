const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const router = express.Router();

const upload = multer({
  dest: "src/uploads/inventory/"
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function detectType(data) {

  const searchable =
    JSON.stringify(data).toLowerCase();

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
    data.cost,
    data["price_per_night_usd"]
  ];

  for (const field of possiblePriceFields) {

    const num = Number(field);

    if (!isNaN(num) && num > 0) {
      return num;
    }
  }

  // fallback scan
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

        type:
          fileType || detectType(data),

        provider:
          data["Agent Name"] ||
          data.provider ||
          "",

        name:
          data.hotel_name ||
          data["Item Description"] ||
          data.provider_or_name ||
          data.name ||
          data.hotel ||
          data.airline ||
          values[0] ||
          "Unknown",

        location:
          data["Specific City/Region"] ||
          data.city ||
          data.origin_or_city ||
          data.origin ||
          data.location ||
          values[1] ||
          "",

        destination:
          data.Country ||
          data.country ||
          data.destination_or_country ||
          data.destination ||
          values[2] ||
          "",

        origin:
          data.origin ||
          "",

        airline:
          data.airline ||
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
          data.category ||
          "",

        notes:
          data.duration_or_notes ||
          data.notes ||
          ""
      };

      results.push(normalized);
    })

    .on("end", () => {

      // CREATE AGENCY FOLDER IF MISSING
      const agencyFolder =
        `src/data/agencies/${agencyId}`;

      if (!fs.existsSync(agencyFolder)) {

        fs.mkdirSync(
          agencyFolder,
          { recursive: true }
        );
      }

      // SAVE INVENTORY
      const savePath =
        path.join(
          agencyFolder,
          `${fileType}.json`
        );

      fs.writeFileSync(
        savePath,
        JSON.stringify(results, null, 2)
      );

      console.log(
        `${fileType} inventory saved for ${agencyId}`
      );

      res.json({
        success: true,
        agencyId,
        fileType,
        uploadedRows: results.length,
        savedTo: savePath,
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
router.get("/:agencyId/:fileType", (req, res) => {

  const { agencyId, fileType } = req.params;

  const filePath =
    `src/data/agencies/${agencyId}/${fileType}.json`;

  if (!fs.existsSync(filePath)) {

    return res.status(404).json({
      success: false,
      error: "Inventory not found"
    });
  }

  const inventory =
    JSON.parse(
      fs.readFileSync(filePath)
    );

  res.json({
    success: true,
    agencyId,
    fileType,
    total: inventory.length,
    inventory
  });
});

module.exports = router;