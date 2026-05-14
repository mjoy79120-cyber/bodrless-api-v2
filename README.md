# Bodrless Orchestration API

The trip orchestration engine powering Bodrless. This is the core
infrastructure that assembles complete bookable trip packages from
a single traveler prompt.

---

## How It Works

```
Traveler sends prompt
      ↓
Prompt Parser (AI-powered)
      ↓
Orchestration Engine
      ↓
┌─────────────────────────────────┐
│  Flights  │  Hotels  │  Buses  │  ← searched in parallel
└─────────────────────────────────┘
      ↓
Dependency Chain Coordination
  1. Transport anchors dates
  2. Hotels follow transport
  3. Transfers complete package
      ↓
Package Ranker (budget + quality fit)
      ↓
Top 3 packages returned in seconds
      ↓
Sent via WhatsApp or chat widget
```

---

## Project Structure

```
bodrless-api/
├── src/
│   ├── server.js                    # Entry point
│   ├── orchestration/
│   │   ├── engine.js                # ⭐ Core orchestration logic (start here)
│   │   ├── promptParser.js          # Natural language → trip params
│   │   └── packageRanker.js         # Ranks packages by relevance
│   ├── integrations/
│   │   ├── flights.js               # Amadeus (+ add more providers)
│   │   ├── hotels.js                # Booking.com / Expedia
│   │   ├── buses.js                 # BuuPass / Easy Coach
│   │   └── transfers.js             # Airport transfers
│   ├── services/
│   │   └── whatsapp.js              # WhatsApp Business API
│   ├── routes/
│   │   ├── trips.js                 # POST /api/trips/orchestrate
│   │   ├── webhooks.js              # WhatsApp webhook handler
│   │   ├── agencies.js              # Agency management
│   │   └── health.js                # GET /health
│   ├── middleware/
│   │   └── auth.js                  # API key authentication
│   └── utils/
│       └── logger.js                # Winston logger
├── .env.example                     # Copy to .env and fill in keys
└── package.json
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment
```bash
cp .env.example .env
# Fill in your API keys in .env
```

### 3. Start the server
```bash
# Development (with auto-restart)
npm run dev

# Production
npm start
```

### 4. Test the orchestration engine
```bash
curl -X POST http://localhost:3000/api/trips/orchestrate \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "prompt": "Nairobi to Zanzibar, 2 people, mid-budget, last week of April",
    "agencyId": "agency_001",
    "channelType": "whatsapp"
  }'
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/trips/orchestrate` | Main endpoint — prompt → packages |
| POST | `/api/trips/book` | Book a specific package |
| GET | `/api/trips/booking/:id` | Get booking status |
| GET | `/api/webhooks/whatsapp` | WhatsApp webhook verification |
| POST | `/api/webhooks/whatsapp` | Incoming WhatsApp messages |
| POST | `/api/agencies/register` | Register new agency |
| GET | `/api/agencies/:id/stats` | Agency dashboard stats |
| GET | `/health` | Health check |

---

## What's Working Now (Mock Data)

Everything runs with mock data out of the box so you can
test the full orchestration flow immediately without any
API keys configured:

- ✅ Prompt parsing (uses Claude API if key provided, rules-based fallback)
- ✅ Orchestration engine — full dependency chain logic
- ✅ Package assembly and ranking
- ✅ WhatsApp webhook verification
- ✅ All API endpoints

---

## What Wilson Needs to Build Next

### Priority 1 — Real supplier integrations
Replace mock data with real API calls:

1. **Flights** — `src/integrations/flights.js`
   - Amadeus sandbox is free to test: https://developers.amadeus.com
   - Add `AMADEUS_API_KEY` and `AMADEUS_API_SECRET` to `.env`

2. **Hotels** — `src/integrations/hotels.js`
   - Booking.com Affiliate API or Expedia EPS
   - Or start with a direct hotel partner API

3. **Buses** — `src/integrations/buses.js`
   - BuuPass API — they're already a Bodrless partner
   - Add `BUUPASS_API_KEY` to `.env`

4. **Transfers** — `src/integrations/transfers.js`
   - Connect to a local transfers provider

### Priority 2 — Database
Add persistent storage for:
- Agency accounts and API keys
- Booking records
- Session/conversation history
- Package cache (don't search same route twice in 30 mins)

Recommended: PostgreSQL + Prisma ORM

### Priority 3 — WhatsApp Business
- Get approved for WhatsApp Business API (Meta Developer portal)
- Add `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` to `.env`
- Set webhook URL to `https://your-domain.com/api/webhooks/whatsapp`

### Priority 4 — Payments
- M-Pesa integration for Kenya (Daraja API)
- Add to booking flow in `src/routes/trips.js` — the `POST /book` endpoint

### Priority 5 — Booking confirmation flow
In `src/routes/trips.js` the `/book` endpoint has a TODO:
1. Lock the package (Redis to prevent double booking)
2. Initiate M-Pesa payment
3. On payment callback — book flight first, then hotel, then transfers
4. Send confirmation via WhatsApp

---

## The Orchestration Engine — Core IP

The most important file is `src/orchestration/engine.js`.

The key insight is the **dependency chain**:
- Flights anchor the dates and times
- Hotels must follow flight arrival/departure
- Transfers are last — they depend on flight times AND hotel location

Any system that doesn't respect this chain produces broken bookings.
This logic is what makes Bodrless different from just connecting APIs.

**Do not change this sequence without careful thought.**

---

## Environment Variables

See `.env.example` for the full list. Minimum required to go live:

```
AMADEUS_API_KEY=         # Flights
AMADEUS_API_SECRET=
BUUPASS_API_KEY=         # Buses
WHATSAPP_TOKEN=          # WhatsApp Business
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
DATABASE_URL=            # PostgreSQL
REDIS_URL=               # Redis for caching
MPESA_CONSUMER_KEY=      # Payments
MPESA_CONSUMER_SECRET=
```

---

## Questions?

Peter — ping Wilson directly with questions on the supplier
integrations. The orchestration logic is ready. The next
unlock is getting real flight and hotel data flowing through it.
