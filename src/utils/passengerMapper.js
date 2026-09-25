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
 *     type:           'adult' | 'child',
 *     seatPreference: 'window' | 'aisle' | 'exit_row' | null,
 *     ageAtTravel:    Number,
 *   }
 *
 * Output shapes:
 *   RateHawk  → guestsByRoom  (array of arrays, one per room)
 *   HotelBeds → paxes         (flat array with type AD/CH)
 *   TravelDuqa → passengers   (flat array for flight hold)
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

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
// RATEHAWK
// ─────────────────────────────────────────────

/**
 * Allocate a flat passenger list into rooms for RateHawk.
 *
 * ETG requires one `rooms` entry per room, each containing a
 * `guests` array. Adults and children must match the search
 * request exactly — ETG validates guest counts server-side.
 *
 * Strategy:
 *   - Adults fill rooms first (round-robin).
 *   - Children are distributed proportionally across rooms.
 *   - If only one room, all passengers go into room 0.
 *
 * @param {Array}  passengers  WhatsApp passenger objects
 * @param {number} roomCount   Number of rooms from the package
 * @param {string} travelDate  YYYY-MM-DD — used to compute child age
 * @returns {Array<Array>}     guestsByRoom — array of guest arrays
 */
function toRateHawkRooms(passengers, roomCount = 1, travelDate) {
  const refDate = travelDate || new Date().toISOString().split('T')[0];

  // Separate adults and children
  const adults   = passengers.filter(p => p.type === 'adult');
  const children = passengers.filter(p => p.type === 'child');

  // Build empty room buckets
  const rooms = Array.from({ length: roomCount }, () => []);

  // Distribute adults round-robin across rooms
  adults.forEach((adult, i) => {
    rooms[i % roomCount].push(_toRateHawkGuest(adult, refDate));
  });

  // Distribute children round-robin across rooms (after adults)
  children.forEach((child, i) => {
    rooms[i % roomCount].push(_toRateHawkGuest(child, refDate));
  });

  // Safety: every room must have at least one adult guest.
  // If a room ended up with only children (shouldn't happen in
  // normal search flow but guard defensively), log a warning.
  rooms.forEach((roomGuests, idx) => {
    const hasAdult = roomGuests.some(g => !g.is_child);
    if (!hasAdult) {
      const { logger } = require('./logger');
      logger.warn('passengerMapper: room has no adult — ETG will reject', {
        roomIndex: idx, guests: roomGuests.map(g => g.first_name),
      });
    }
  });

  return rooms;
}

/**
 * Convert a single WhatsApp passenger to an ETG guest object.
 * @private
 */
function _toRateHawkGuest(p, refDate) {
  const isChild = p.type === 'child';
  const guest = {
    first_name: p.firstName,
    last_name:  p.lastName,
  };
  if (isChild) {
    guest.is_child = true;
    // ETG requires integer age, not DOB string
    guest.age = typeof p.ageAtTravel === 'number'
      ? p.ageAtTravel
      : ageAt(p.dateOfBirth, refDate);
  }
  return guest;
}

/**
 * Build the ETG `guests` search param from a package room config.
 * Used in search / HP calls — separate from booking guest data.
 *
 * @param {number} adults
 * @param {Array}  childAges  Array of integer ages
 * @param {number} rooms
 * @returns {Array<{adults: number, children: number[]}>}
 */
function toRateHawkSearchGuests(adults, childAges = [], rooms = 1) {
  const adultsPerRoom = Math.max(1, Math.ceil(adults / rooms));
  const ages = [...childAges];
  const guests = [];
  for (let r = 0; r < rooms; r++) {
    const roomChildCount = Math.ceil((ages.length - r) / rooms);
    const roomChildren   = ages.splice(0, Math.max(0, roomChildCount));
    guests.push({ adults: adultsPerRoom, children: roomChildren });
  }
  return guests;
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

  // Distribute passengers across rooms (round-robin, same as RateHawk)
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
 * TravelDuqa uses type strings: 'ADT', 'CHD', 'INF'.
 * DOB is passed as-is (YYYY-MM-DD) — TravelDuqa accepts it.
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

module.exports = {
  ageAt,
  toRateHawkRooms,
  toRateHawkSearchGuests,
  toHotelBedsPaxes,
  toTravelDuqaPassengers,
  toHolder,
};