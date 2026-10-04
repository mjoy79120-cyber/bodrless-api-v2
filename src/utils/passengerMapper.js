/**
 * passengerMapper.js
 * ─────────────────────────────────────────────────────────────
 * Single source of truth for translating WhatsApp passenger
 * objects into supplier-specific shapes.
 *
 * WhatsApp passenger shape (from whatsappBookingFlow.js):
 *   {
 *     firstName:      String,
 *     lastName:       String,
 *     dateOfBirth:    'YYYY-MM-DD',
 *     gender:         'male' | 'female',
 *     nationality:    'ke' | 'uz' | ...  (ISO 3166-1 alpha-2, lowercase)
 *     type:           'adult' | 'child',
 *     seatPreference: 'window' | 'aisle' | 'exit_row' | null,
 *     ageAtTravel:    Number,
 *   }
 *
 * Output shapes:
 *   RateHawk  → allocateRooms()      (canonical — use for HP + booking)
 *   RateHawk  → toRateHawkSearchGuests() (SERP only — estimate from counts)
 *   HotelBeds → toHotelBedsPaxes()   (flat array with type AD/CH)
 *   TravelDuqa → toTravelDuqaPassengers() (flat array for flight hold)
 *
 * CHANGE LOG
 *   2026-10-02  Added allocateRooms() — single allocator for HP + booking.
 *               Fixed toRateHawkSearchGuests() child-age splice bug.
 *               ETG age threshold: ≤17 at check-in = child.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

// ─────────────────────────────────────────────
// SHARED UTILITY
// ─────────────────────────────────────────────

/**
 * Calculate age in full years at a reference date.
 * @param {string} dobStr      YYYY-MM-DD
 * @param {string} refDateStr  YYYY-MM-DD
 * @returns {number}
 */
function ageAt(dobStr, refDateStr) {
  const dob = new Date(dobStr + 'T00:00:00Z');
  const ref = new Date(refDateStr + 'T00:00:00Z');
  let age = ref.getUTCFullYear() - dob.getUTCFullYear();
  const m = ref.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

// ─────────────────────────────────────────────
// RATEHAWK — CANONICAL ROOM ALLOCATOR
// Use this for BOTH hotelpage guests AND booking rooms.
// Keeps the two in sync so ETG never sees a mismatch.
// ─────────────────────────────────────────────

/**
 * Allocate passengers into rooms for RateHawk.
 *
 * ETG rules:
 *   - Everyone ≤17 at check-in is a child (requires is_child:true + age).
 *   - Every room must have at least one adult.
 *   - Guest counts/ages in booking must exactly match the HP request.
 *
 * Returns two shapes derived from the same allocation so they always match:
 *   hotelpageGuests  — for /search/hp/  (adults count + children ages array)
 *   bookingRooms     — for /booking/finish/ (full guest objects per room)
 *
 * @param {Array}  passengers  WhatsApp passenger objects (with dateOfBirth)
 * @param {number} roomCount
 * @param {string} checkIn     YYYY-MM-DD — used to compute age at travel
 * @returns {{ hotelpageGuests: Array, bookingRooms: Array }}
 */
function allocateRooms(passengers, roomCount = 1, checkIn) {
  const refDate = checkIn || new Date().toISOString().split('T')[0];

  // Compute age at check-in for every passenger.
  // ETG threshold: ≤17 = child.
  const people = passengers.map(p => {
    const age = typeof p.ageAtTravel === 'number'
      ? p.ageAtTravel
      : ageAt(p.dateOfBirth, refDate);
    return { p, age, isChild: age <= 17 };
  });

  const adults   = people.filter(x => !x.isChild);
  const children = people.filter(x =>  x.isChild);

  // Every room needs at least one adult.
  if (adults.length < roomCount) {
    const { logger } = require('../utils/logger');
    logger.warn('passengerMapper.allocateRooms: fewer adults than rooms — ETG will reject', {
      adults: adults.length, roomCount,
    });
  }

  // Build room buckets.
  const rooms = Array.from({ length: roomCount }, () => ({ adults: [], children: [] }));

  // Round-robin adults first, then children.
  adults.forEach((x, i)   => rooms[i % roomCount].adults.push(x));
  children.forEach((x, i) => rooms[i % roomCount].children.push(x));

  // ── hotelpageGuests: ETG HP search shape ──────────────────
  // { adults: N, children: [age, age, ...] }
  const hotelpageGuests = rooms.map(room => ({
    adults:   room.adults.length || 1,   // safety: never send 0 adults
    children: room.children.map(x => x.age),
  }));

  // ── bookingRooms: ETG /booking/finish/ shape ──────────────
  // [{ guests: [{ first_name, last_name, is_child?, age? }] }]
  const bookingRooms = rooms.map(room => ({
    guests: [
      ...room.adults.map(x => ({
        first_name: x.p.firstName,
        last_name:  x.p.lastName,
      })),
      ...room.children.map(x => ({
        first_name: x.p.firstName,
        last_name:  x.p.lastName,
        is_child:   true,
        age:        x.age,
      })),
    ],
  }));

  return { hotelpageGuests, bookingRooms };
}

// ─────────────────────────────────────────────
// RATEHAWK — SERP SEARCH GUESTS  (estimate only)
// Used for /search/serp/* calls where we have counts but no DOBs.
// Do NOT use for hotelpage or booking — use allocateRooms() there.
// ─────────────────────────────────────────────

/**
 * Build the ETG `guests` SERP param from counts.
 *
 * FIX: previous version spliced `ages` inside the loop, which
 * caused the array length to shrink mid-iteration, dropping
 * children in later rooms.  We now slice (non-destructive) and
 * distribute by index.
 *
 * @param {number} adults
 * @param {Array}  childAges  Array of integer ages
 * @param {number} rooms
 * @returns {Array<{adults: number, children: number[]}>}
 */
function toRateHawkSearchGuests(adults, childAges = [], rooms = 1) {
  const adultsPerRoom = Math.max(1, Math.ceil(adults / rooms));
  const result = [];

  for (let r = 0; r < rooms; r++) {
    // Distribute child ages across rooms by index (non-destructive).
    const roomChildren = childAges.filter((_, i) => i % rooms === r);
    result.push({
      adults:   adultsPerRoom,
      children: roomChildren,
    });
  }

  return result;
}

// ─────────────────────────────────────────────
// RATEHAWK — LEGACY ROOM BUILDER  (kept for compatibility)
// New code should use allocateRooms() instead.
// ─────────────────────────────────────────────

/**
 * @deprecated Use allocateRooms() — this does not guarantee
 * that hotelpageGuests and bookingRooms match.
 */
function toRateHawkRooms(passengers, roomCount = 1, travelDate) {
  const { bookingRooms } = allocateRooms(passengers, roomCount, travelDate);
  // Return flat array-of-arrays to match old callers.
  return bookingRooms.map(r => r.guests);
}

// ─────────────────────────────────────────────
// HOTELBEDS
// ─────────────────────────────────────────────

/**
 * Convert WhatsApp passengers to HotelBeds paxes array.
 *
 * HotelBeds pax types: 'AD' (adult), 'CH' (child).
 * Children require an `age` field (integer).
 * Room number is 1-indexed and required.
 *
 * @param {Array}  passengers  WhatsApp passenger objects
 * @param {number} roomCount
 * @param {string} travelDate  YYYY-MM-DD
 * @returns {Array<{roomId, type, name, surname, age?}>}
 */
function toHotelBedsPaxes(passengers, roomCount = 1, travelDate) {
  const refDate = travelDate || new Date().toISOString().split('T')[0];
  const paxes   = [];

  const adults   = passengers.filter(p => p.type === 'adult');
  const children = passengers.filter(p => p.type === 'child');

  const allGuests = [
    ...adults.map((p, i)   => ({ ...p, roomId: (i % roomCount) + 1 })),
    ...children.map((p, i) => ({ ...p, roomId: (i % roomCount) + 1 })),
  ];

  for (const p of allGuests) {
    const isChild = p.type === 'child';
    const pax = {
      roomId:  p.roomId,
      type:    isChild ? 'CH' : 'AD',
      name:    p.firstName,
      surname: p.lastName,
    };
    if (isChild) {
      pax.age = typeof p.ageAtTravel === 'number'
        ? p.ageAtTravel
        : ageAt(p.dateOfBirth, refDate);
    }
    paxes.push(pax);
  }

  return paxes;
}

// ─────────────────────────────────────────────
// TRAVELDUQA  (flights)
// ─────────────────────────────────────────────

/**
 * Convert WhatsApp passengers to TravelDuqa passenger array.
 *
 * @param {Array}  passengers  WhatsApp passenger objects
 * @param {string} travelDate  YYYY-MM-DD
 * @returns {Array}
 */
function toTravelDuqaPassengers(passengers, travelDate) {
  const refDate = travelDate || new Date().toISOString().split('T')[0];

  return passengers.map(p => {
    const age = typeof p.ageAtTravel === 'number'
      ? p.ageAtTravel
      : ageAt(p.dateOfBirth, refDate);

    let type = 'ADT';
    if (p.type === 'child') type = age < 2 ? 'INF' : 'CHD';

    return {
      firstName:      p.firstName,
      lastName:       p.lastName,
      dateOfBirth:    p.dateOfBirth,
      gender:         p.gender,
      type,
      seatPreference: p.seatPreference || null,
      age,
    };
  });
}

// ─────────────────────────────────────────────
// HOLDER  (lead guest for booking forms)
// ─────────────────────────────────────────────

/**
 * Extract the lead guest (holder) for booking forms.
 * Always the first adult; falls back to first passenger.
 *
 * @param {Array}  passengers
 * @param {string} guestEmail
 * @param {string} guestPhone
 * @returns {Object}
 */
function toHolder(passengers, guestEmail, guestPhone) {
  const lead = passengers.find(p => p.type === 'adult') || passengers[0];
  return {
    firstName: lead.firstName,
    lastName:  lead.lastName,
    email:     guestEmail || null,
    phone:     guestPhone || null,
  };
}

// ─────────────────────────────────────────────
// NATIONALITY → ISO CODE
// Maps common country names / demonyms to lowercase ISO 3166-1 alpha-2.
// Used to extract residency from the passenger Nationality field.
// ─────────────────────────────────────────────

const NATIONALITY_MAP = {
  // East Africa
  kenyan: 'ke', kenya: 'ke', ke: 'ke',
  tanzanian: 'tz', tanzania: 'tz', tz: 'tz',
  ugandan: 'ug', uganda: 'ug', ug: 'ug',
  rwandan: 'rw', rwanda: 'rw', rw: 'rw',
  ethiopian: 'et', ethiopia: 'et', et: 'et',
  // Southern Africa
  southafrican: 'za', 'south africa': 'za', za: 'za',
  zimbabwean: 'zw', zimbabwe: 'zw', zw: 'zw',
  zambian: 'zm', zambia: 'zm', zm: 'zm',
  mozambican: 'mz', mozambique: 'mz', mz: 'mz',
  // Commonly tested by ETG
  uzbek: 'uz', uzbekistani: 'uz', uzbekistan: 'uz', uz: 'uz',
  // Indian Ocean
  seychellois: 'sc', seychelles: 'sc', sc: 'sc',
  mauritian: 'mu', mauritius: 'mu', mu: 'mu',
  // Middle East
  emirati: 'ae', uae: 'ae', 'united arab emirates': 'ae', ae: 'ae',
  qatari: 'qa', qatar: 'qa', qa: 'qa',
  // Common European
  british: 'gb', uk: 'gb', 'united kingdom': 'gb', gb: 'gb',
  german: 'de', germany: 'de', de: 'de',
  french: 'fr', france: 'fr', fr: 'fr',
  american: 'us', 'united states': 'us', usa: 'us', us: 'us',
  indian: 'in', india: 'in', in: 'in',
  chinese: 'cn', china: 'cn', cn: 'cn',
};

/**
 * Convert a raw nationality string to a lowercase ISO country code.
 * Falls back to 'ke' (Kenya) if not recognised — log a warning.
 *
 * @param {string} raw  e.g. "Kenyan", "Uganda", "uz"
 * @returns {string}    e.g. "ke"
 */
function toResidencyCode(raw) {
  if (!raw) return 'ke';
  const key = raw.trim().toLowerCase();
  // Direct ISO code (2 chars)
  if (/^[a-z]{2}$/.test(key)) return key;
  const mapped = NATIONALITY_MAP[key];
  if (mapped) return mapped;
  const { logger } = require('../utils/logger');
  logger.warn('passengerMapper.toResidencyCode: unrecognised nationality — defaulting ke', { raw });
  return 'ke';
}

module.exports = {
  ageAt,
  allocateRooms,
  toRateHawkRooms,
  toRateHawkSearchGuests,
  toHotelBedsPaxes,
  toTravelDuqaPassengers,
  toHolder,
  toResidencyCode,
};