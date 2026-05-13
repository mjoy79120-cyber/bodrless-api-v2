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

  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", () => {

      uploadedInventory = results;

      console.log("Parsed Inventory:", uploadedInventory);

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