const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const supabase = require("../utils/supabase");

const router = express.Router();

const upload = multer({
  dest: "tmp/"
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function normalizeKeys(obj) {
  const normalized = {};

  Object.keys(obj).forEach(key => {
    normalized[key.toLowerCase().trim()] = obj[key];
  });

  return normalized;
}

function findField(data, possibleFields) {
  for (const field of possibleFields) {
    if (data[field] !== undefined && data[field] !== "") {
      return data[field];
    }
  }

  return "";
}

function extractPrice(data) {
  const priceFields = [
    "price",
    "rate",
    "amount",
    "cost",
    "price_usd",
    "rate_usd",
    "price_per_night",
    "price_per_night_usd",
    "rate (usd)"
  ];

  for (const field of priceFields) {
    if (data[field]) {
      const cleaned = String(data[field])
        .replace(/\$/g, "")
        .replace(/,/g, "")
        .trim();

      const num = Number(cleaned);

      if (!isNaN(num) && num > 0) {
        return num;
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// UPLOAD ROUTE
// ─────────────────────────────────────────────

router.post("/", upload.single("inventory"), async (req, res) => {

  try {

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

      .on("data", (row) => {

        const data = normalizeKeys(row);

        // ─────────────────────────────
        // HOTELS
        // ─────────────────────────────
        if (fileType === "hotels") {

          const hotel = {
            agency_id: agencyId,

            name: findField(data, [
              "hotel_name",
              "hotel",
              "name",
              "property"
            ]),

            location: findField(data, [
              "city",
              "location",
              "destination",
              "country"
            ]),

            price_per_night: extractPrice(data),

            stars: Number(findField(data, [
              "stars",
              "star_rating"
            ])) || null,

            rating: Number(findField(data, [
              "rating",
              "review_score"
            ])) || null
          };

          if (hotel.name && hotel.price_per_night) {
            results.push(hotel);
          }
        }

        // ─────────────────────────────
        // FLIGHTS
        // ─────────────────────────────
        if (fileType === "flights") {

          const flight = {
            agency_id: agencyId,

            origin: findField(data, [
              "origin",
              "from",
              "departure_city"
            ]),

            destination: findField(data, [
              "destination",
              "to",
              "arrival_city"
            ]),

            airline: findField(data, [
              "airline",
              "carrier"
            ]),

            flight_number: findField(data, [
              "flight_number",
              "flight_no"
            ]),

            price: extractPrice(data)
          };

          if (
            flight.origin &&
            flight.destination &&
            flight.price
          ) {
            results.push(flight);
          }
        }

        // ─────────────────────────────
        // TRANSFERS
        // ─────────────────────────────
        if (fileType === "transfers") {

          const transfer = {
            agency_id: agencyId,

            provider: findField(data, [
              "provider",
              "company",
              "name"
            ]),

            vehicle_type: findField(data, [
              "vehicle_type",
              "vehicle",
              "car_type"
            ]),

            price: extractPrice(data)
          };

          if (transfer.provider && transfer.price) {
            results.push(transfer);
          }
        }

      })

      .on("end", async () => {

        try {

          if (!results.length) {

            fs.unlink(req.file.path, () => {});

            return res.status(400).json({
              success: false,
              error: "No valid inventory rows found"
            });
          }

          const tableMap = {
            hotels: "hotels",
            flights: "flights",
            transfers: "transfers"
          };

          const table = tableMap[fileType];

          const { error } = await supabase
            .from(table)
            .insert(results);

          fs.unlink(req.file.path, () => {});

          if (error) {
            throw error;
          }

          return res.json({
            success: true,
            fileType,
            uploadedRows: results.length,
            message: "Inventory uploaded successfully"
          });

        } catch (err) {

          console.error(err);

          return res.status(500).json({
            success: false,
            error: err.message
          });
        }

      })

      .on("error", (err) => {

        console.error(err);

        return res.status(500).json({
          success: false,
          error: err.message
        });
      });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }

});

module.exports = router;