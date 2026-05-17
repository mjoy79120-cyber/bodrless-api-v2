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

      // FLEXIBLE NORMALIZATION
      const normalized = {

        type: (
          data.type ||
          data.category ||
          values.find(v => {

            const val =
              String(v).toLowerCase();

            return (
              val.includes("hotel") ||
              val.includes("flight") ||
              val.includes("transfer") ||
              val.includes("bus")
            );
          }) ||
          "unknown"
        )
          .toString()
          .toLowerCase(),

        name:
          data.provider_or_name ||
          data.name ||
          data.provider ||
          data.hotel ||
          data.airline ||
          values[0] ||
          "Unknown",

        location:
          data.origin_or_city ||
          data.city ||
          data.origin ||
          data.location ||
          values[1] ||
          "",

        destination:
          data.destination_or_country ||
          data.destination ||
          data.country ||
          values[2] ||
          "",

        price:
          Number(

            data.price_usd ||
            data.price ||
            data.amount ||

            values.find(v =>
              !isNaN(Number(v))
            ) ||

            0
          ),

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

      // SAVE JSON LOCALLY
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