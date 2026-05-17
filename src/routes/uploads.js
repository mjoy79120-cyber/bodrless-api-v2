const express = require("express");
const multer = require("multer");
const fs = require("fs");
const csv = require("csv-parser");

const router = express.Router();

const upload = multer({
  dest: "src/uploads/inventory/"
});

let uploadedInventory = [];

// POST upload
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

      // ✅ NORMALIZE INVENTORY
      results.push({

        type:
          data.type?.toLowerCase(),

        name:
          data.provider_or_name,

        location:
          data.origin_or_city,

        destination:
          data.destination_or_country,

        price:
          Number(data.price_usd || 0),

        category:
          data.category,

        notes:
          data.duration_or_notes
      });
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
    });
});

// GET uploaded inventory
router.get("/", (req, res) => {
  res.json(uploadedInventory);
});

module.exports = router;