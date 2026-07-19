/**
 * HOTEL DIRECT BOOKING SERVICE — v2
 */

const { v4: uuidv4 } = require('uuid');
const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');
const notificationService = require('./notifications');

let intasend = null;
try {
  const IntaSend = require('intasend-node');
  intasend = new IntaSend(
    process.env.INTASEND_PUBLISHABLE_KEY,
    process.env.INTASEND_SECRET_KEY,
    process.env.NODE_ENV !== 'production'
  );
} catch (e) {
  logger.warn('IntaSend not loaded in hotelDirectBookingService', { error: e.message });
}

class HotelDirectBookingService {

  async createReservation({
    pkg, selectedAncillaries = [], guestName, guestEmail, guestPhone,
    specialRequests, channel = 'widget', groupId,
  }) {
    try {
      const hotel   = pkg.hotel   || {};
      const summary = pkg.summary || {};

      const resolvedGroupId = groupId    || hotel.groupId;
      const propertyId      = hotel.propertyId;
      const roomTypeId      = hotel.roomTypeId;
      const ratePlanId      = hotel.ratePlanId;

      if (!resolvedGroupId || !propertyId || !roomTypeId || !ratePlanId) {
        return { success: false, error: 'Invalid package — missing booking identifiers. Please search again.' };
      }

      const { data: group, error: groupErr } = await supabase
        .from('hotel_groups')
        .select('id, name, slug, commission_rate, payment_type, mpesa_shortcode, mpesa_account_ref, payment_link_template, notification_email, notification_phone')
        .eq('id', resolvedGroupId)
        .single();

      if (groupErr || !group) {
        logger.error('HotelDirect: group not found', { groupId: resolvedGroupId });
        return { success: false, error: 'Hotel configuration not found.' };
      }

      const nights     = hotel.nights || summary.nights || 1;
      const passengers = summary.passengers || 1;
      const currency   = hotel.currency || summary.currency || 'KES';
      const roomTotal  = hotel.totalRate || (hotel.pricePerNight * nights) || 0;

      const ancillaryTotal = selectedAncillaries.reduce((sum, a) => {
        if (a.priceBasis === 'per_person') return sum + (a.price * passengers);
        if (a.priceBasis === 'per_night')  return sum + (a.price * nights);
        return sum + a.price;
      }, 0);

      const grossAmount      = roomTotal + ancillaryTotal;
      const commissionRate   = group.commission_rate || 0.05;
      const commissionAmount = Math.round(grossAmount * commissionRate * 100) / 100;
      const reservationRef   = `HTL-${Date.now()}`;

      const { data: reservation, error: resErr } = await supabase
        .from('hotel_reservations')
        .insert({
          id:                  uuidv4(),
          reservation_ref:     reservationRef,
          group_id:            resolvedGroupId,
          property_id:         propertyId,
          room_type_id:        roomTypeId,
          rate_plan_id:        ratePlanId,
          guest_name:          guestName,
          guest_email:         guestEmail   || null,
          guest_phone:         guestPhone   || null,
          special_requests:    specialRequests || null,
          check_in:            hotel.checkIn,
          check_out:           hotel.checkOut,
          nights,
          adults:              passengers,
          children:            summary.children || 0,
          meal_plan:           hotel.mealPlan   || null,
          room_total:          roomTotal,
          ancillary_total:     ancillaryTotal,
          gross_amount:        grossAmount,
          commission_rate:     commissionRate,
          commission_amount:   commissionAmount,
          currency,
          ancillary_services:  selectedAncillaries,
          status:              'confirmed',
          payment_status:      'pending',
          commission_status:   'pending',
          channel,
          created_at:          new Date().toISOString(),
        })
        .select()
        .single();

      if (resErr) {
        logger.error('HotelDirect: reservation insert failed', { error: resErr.message });
        return { success: false, error: 'Could not create reservation. Please try again.' };
      }

      const period = new Date().toISOString().slice(0, 7);
      await supabase.from('commission_ledger').insert({
        id:                uuidv4(),
        group_id:          resolvedGroupId,
        reservation_id:    reservation.id,
        reservation_ref:   reservationRef,
        gross_amount:      grossAmount,
        commission_rate:   commissionRate,
        commission_amount: commissionAmount,
        currency,
        period,
        status:            'pending',
        created_at:        new Date().toISOString(),
      });

      this._notifyHotel({ group, reservation, hotel, selectedAncillaries, guestName, guestPhone, guestEmail })
        .catch(err => logger.error('HotelDirect: hotel notification failed', { reservationRef, error: err.message }));

      logger.info('HotelDirect: reservation created', { reservationRef, groupSlug: group.slug, grossAmount, commissionAmount });

      return {
        success:          true,
        reservationRef,
        reservationId:    reservation.id,
        grossAmount,
        commissionAmount,
        currency,
        paymentType:      group.payment_type,
        message:          `Reservation ${reservationRef} confirmed. Total: ${currency} ${grossAmount.toLocaleString()}.`,
      };

    } catch (err) {
      logger.error('HotelDirect: createReservation threw', { error: err.message });
      return { success: false, error: 'An unexpected error occurred. Please try again.' };
    }
  }

  async triggerGuestPayment({ reservationRef, guestPhone, paymentMethod }) {
    try {
      const { data: reservation, error } = await supabase
        .from('hotel_reservations')
        .select(`*, hotel_groups ( name, payment_type, mpesa_shortcode, mpesa_account_ref, payment_link_template )`)
        .eq('reservation_ref', reservationRef)
        .single();

      if (error || !reservation) {
        return { success: false, error: 'Reservation not found.' };
      }

      const group    = reservation.hotel_groups;
      const amount   = reservation.gross_amount;
      const currency = reservation.currency;
      const phone    = guestPhone || reservation.guest_phone;
      const method   = paymentMethod || (group.payment_type === 'mpesa' ? 'mpesa' : 'card');

      if (method === 'mpesa') {
        if (!group.mpesa_shortcode) {
          return { success: false, error: 'Hotel M-Pesa shortcode not configured. Please contact the hotel directly.' };
        }
        if (!intasend) {
          return { success: false, error: 'Payment service unavailable. Please try again.' };
        }
        try {
          const nameParts = (reservation.guest_name || '').split(' ');
          await intasend.collection().mpesaStkPush({
            first_name:   nameParts[0] || 'Guest',
            last_name:    nameParts.slice(1).join(' ') || '',
            email:        reservation.guest_email || '',
            host:         process.env.API_BASE_URL,
            amount:       Math.round(amount),
            phone_number: phone,
            api_ref:      reservationRef,
            account:      group.mpesa_shortcode,
            narrative:    `${group.mpesa_account_ref || group.name} — ${reservationRef}`,
          });
          await supabase.from('hotel_reservations').update({ payment_method: 'mpesa' }).eq('reservation_ref', reservationRef);
          logger.info('HotelDirect: M-Pesa STK sent', { reservationRef, shortcode: group.mpesa_shortcode, amount });
          return {
            success:       true,
            paymentMethod: 'mpesa',
            message:       `M-Pesa prompt sent to ${phone}. Enter your PIN to pay ${currency} ${amount.toLocaleString()} to ${group.name}.`,
          };
        } catch (stkErr) {
          logger.error('HotelDirect: STK push failed', { reservationRef, error: stkErr.message });
          return { success: false, error: `Could not send payment prompt (${stkErr.message}). Please try again.` };
        }
      }

      if (method === 'card') {
        if (!group.payment_link_template) {
          return { success: false, error: 'Hotel card payment not configured. Please contact the hotel directly.' };
        }
        const paymentLink = group.payment_link_template
          .replace('{amount}',   Math.round(amount))
          .replace('{ref}',      reservationRef)
          .replace('{currency}', currency)
          .replace('{name}',     encodeURIComponent(reservation.guest_name));
        await supabase.from('hotel_reservations').update({ payment_method: 'card' }).eq('reservation_ref', reservationRef);
        return {
          success:       true,
          paymentMethod: 'card',
          paymentLink,
          message:       `Complete your payment of ${currency} ${amount.toLocaleString()} via the link below.`,
        };
      }

      return { success: false, error: 'No payment method available for this hotel.' };

    } catch (err) {
      logger.error('HotelDirect: triggerGuestPayment threw', { error: err.message });
      return { success: false, error: 'Payment initiation failed. Please try again.' };
    }
  }

  async markPaid({ reservationRef, paymentReference, markedBy = 'hotel' }) {
    try {
      const { data: reservation, error } = await supabase
        .from('hotel_reservations')
        .select(`*, hotel_groups ( name, notification_email, notification_phone ), hotel_properties ( name, location, address, check_in_time, check_out_time ), room_types ( name, bed_type, view ), rate_plans ( name, meal_plan )`)
        .eq('reservation_ref', reservationRef)
        .single();

      if (error || !reservation) {
        return { success: false, error: 'Reservation not found.' };
      }
      if (reservation.payment_status === 'paid') {
        return { success: false, error: 'Already marked as paid.', alreadyPaid: true };
      }

      await supabase
        .from('hotel_reservations')
        .update({ payment_status: 'paid', status: 'paid', payment_reference: paymentReference || null, voucher_sent: false })
        .eq('reservation_ref', reservationRef);

      this._sendGuestVoucher(reservation)
        .catch(err => logger.error('HotelDirect: voucher send failed', { reservationRef, error: err.message }));

      logger.info('HotelDirect: reservation marked paid', { reservationRef, markedBy });
      return { success: true, reservationRef, status: 'paid' };

    } catch (err) {
      logger.error('HotelDirect: markPaid threw', { error: err.message });
      return { success: false, error: 'Could not update payment status.' };
    }
  }

  // ─────────────────────────────
  // MODIFY RESERVATION
  // Updates dates and recalculates totals.
  // ─────────────────────────────
  async modifyReservation({ reservationRef, newCheckIn, newCheckOut, specialRequests }) {
    try {
      const { data: reservation } = await supabase
        .from('hotel_reservations')
        .select('id, status, group_id, rate_plan_id, adults, children, currency, ancillary_total')
        .eq('reservation_ref', reservationRef)
        .single();

      if (!reservation) {
        return { success: false, error: 'Reservation not found.' };
      }
      if (reservation.status === 'cancelled') {
        return { success: false, error: 'Cannot modify a cancelled reservation.' };
      }

      const checkIn  = new Date(newCheckIn);
      const checkOut = new Date(newCheckOut);
      const nights   = Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24));

      if (nights <= 0) {
        return { success: false, error: 'Check-out must be after check-in.' };
      }

      // Fetch rate plan to recalculate totals
      const { data: ratePlan } = await supabase
        .from('rate_plans')
        .select('price_per_night, extra_adult_surcharge, child_surcharge')
        .eq('id', reservation.rate_plan_id)
        .single();

      const pricePerNight  = ratePlan?.price_per_night || 0;
      const roomTotal      = pricePerNight * nights;
      const ancillaryTotal = Number(reservation.ancillary_total) || 0;
      const grossAmount    = roomTotal + ancillaryTotal;

      const updates = {
        check_in:     newCheckIn,
        check_out:    newCheckOut,
        nights,
        room_total:   roomTotal,
        gross_amount: grossAmount,
        updated_at:   new Date().toISOString(),
      };
      if (specialRequests !== undefined) updates.special_requests = specialRequests;

      await supabase
        .from('hotel_reservations')
        .update(updates)
        .eq('reservation_ref', reservationRef);

      // Update commission ledger with new gross
      const commissionRate = 0.05; // will be overridden by group rate if needed
      const commissionAmount = Math.round(grossAmount * commissionRate * 100) / 100;
      await supabase
        .from('commission_ledger')
        .update({ gross_amount: grossAmount, commission_amount: commissionAmount })
        .eq('reservation_ref', reservationRef);

      logger.info('HotelDirect: reservation modified', { reservationRef, newCheckIn, newCheckOut, nights });

      return {
        success:        true,
        reservationRef,
        newCheckIn,
        newCheckOut,
        nights,
        note:           'Modification recorded. The hotel will confirm your updated dates shortly.',
      };

    } catch (err) {
      logger.error('HotelDirect: modifyReservation threw', { error: err.message });
      return { success: false, error: 'Could not modify reservation.' };
    }
  }

  async cancelReservation({ reservationRef, reason, cancelledBy = 'guest' }) {
    try {
      const { data: reservation } = await supabase
        .from('hotel_reservations')
        .select('id, status, group_id')
        .eq('reservation_ref', reservationRef)
        .single();

      if (!reservation) {
        return { success: false, error: 'Reservation not found.' };
      }
      if (reservation.status === 'cancelled') {
        return { success: false, error: 'Reservation already cancelled.', alreadyCancelled: true };
      }

      await supabase
        .from('hotel_reservations')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('reservation_ref', reservationRef);

      await supabase
        .from('commission_ledger')
        .update({ status: 'waived' })
        .eq('reservation_ref', reservationRef);

      logger.info('HotelDirect: reservation cancelled', { reservationRef, cancelledBy, reason });

      return {
        success:        true,
        reservationRef,
        status:         'cancelled',
        note:           'Cancellation recorded. Please contact the hotel regarding any refund.',
      };

    } catch (err) {
      logger.error('HotelDirect: cancelReservation threw', { error: err.message });
      return { success: false, error: 'Could not cancel reservation.' };
    }
  }

  async getReservation(reservationRef) {
    const { data, error } = await supabase
      .from('hotel_reservations')
      .select(`*, hotel_groups ( name, slug, commission_rate ), hotel_properties ( name, location, address, check_in_time, check_out_time ), room_types ( name, bed_type, view, amenities ), rate_plans ( name, meal_plan, price_per_night )`)
      .eq('reservation_ref', reservationRef)
      .single();

    if (error || !data) return null;
    return data;
  }

  async generateMonthlyInvoice({ groupId, period }) {
    try {
      const { data: entries, error } = await supabase
        .from('commission_ledger')
        .select('*')
        .eq('group_id', groupId)
        .eq('period', period)
        .eq('status', 'pending');

      if (error) throw error;
      if (!entries?.length) {
        return { success: true, message: 'No pending entries for this period.', total: 0 };
      }

      const grossTotal      = entries.reduce((s, e) => s + Number(e.gross_amount),      0);
      const commissionTotal = entries.reduce((s, e) => s + Number(e.commission_amount), 0);
      const currency        = entries[0].currency || 'KES';
      const dueDate         = this._addDays(new Date(`${period}-01`).toISOString().split('T')[0], 30);

      const { data: invoice, error: invErr } = await supabase
        .from('commission_invoices')
        .upsert({
          group_id:         groupId,
          period,
          total_bookings:   entries.length,
          gross_total:      Math.round(grossTotal      * 100) / 100,
          commission_total: Math.round(commissionTotal * 100) / 100,
          currency,
          status:           'sent',
          due_date:         dueDate,
          created_at:       new Date().toISOString(),
        }, { onConflict: 'group_id,period' })
        .select()
        .single();

      if (invErr) throw invErr;

      await supabase
        .from('commission_ledger')
        .update({ status: 'invoiced', invoice_id: invoice.id })
        .eq('group_id', groupId)
        .eq('period', period)
        .eq('status', 'pending');

      logger.info('HotelDirect: commission invoice generated', { groupId, period, commissionTotal, entries: entries.length });

      return {
        success:         true,
        invoiceId:       invoice.id,
        period,
        totalBookings:   entries.length,
        grossTotal:      Math.round(grossTotal      * 100) / 100,
        commissionTotal: Math.round(commissionTotal * 100) / 100,
        currency,
        dueDate,
      };

    } catch (err) {
      logger.error('HotelDirect: generateMonthlyInvoice failed', { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async _notifyHotel({ group, reservation, hotel, selectedAncillaries, guestName, guestPhone, guestEmail }) {
    const currency = reservation.currency || 'KES';
    const ancLines = selectedAncillaries.length > 0
      ? selectedAncillaries.map(a => `  • ${a.name}: ${currency} ${a.price.toLocaleString()}`).join('\n')
      : '  None';

    const emailBody = `
New Reservation — ${reservation.reservation_ref}

Guest:       ${guestName}
Phone:       ${guestPhone || 'Not provided'}
Email:       ${guestEmail || 'Not provided'}

Property:    ${hotel.propertyName || hotel.name || ''}
Room:        ${hotel.roomType || ''}
Check-in:    ${reservation.check_in}
Check-out:   ${reservation.check_out}
Nights:      ${reservation.nights}
Guests:      ${reservation.adults} adult(s), ${reservation.children || 0} child(ren)
Meal plan:   ${reservation.meal_plan || 'Room only'}

Add-ons:
${ancLines}

Room total:   ${currency} ${Number(reservation.room_total).toLocaleString()}
Add-ons:      ${currency} ${Number(reservation.ancillary_total).toLocaleString()}
TOTAL DUE:    ${currency} ${Number(reservation.gross_amount).toLocaleString()}

Special requests: ${reservation.special_requests || 'None'}

Bodrless commission (${(reservation.commission_rate * 100).toFixed(1)}%):
${currency} ${Number(reservation.commission_amount).toLocaleString()} — invoiced monthly.
    `.trim();

    if (group.notification_email) {
      try {
        await notificationService.sendEmail({
          to:      group.notification_email,
          subject: `New Reservation ${reservation.reservation_ref} — ${guestName}`,
          text:    emailBody,
        });
      } catch (err) {
        logger.warn('HotelDirect: hotel email failed', { error: err.message });
      }
    }

    if (group.notification_phone) {
      try {
        const whatsapp      = require('./whatsappService');
        const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        if (phoneNumberId) {
          const waText =
            `🏨 *New Reservation — ${reservation.reservation_ref}*\n\n` +
            `*Guest:* ${guestName}\n` +
            `*Phone:* ${guestPhone || 'Not provided'}\n` +
            `*Check-in:* ${reservation.check_in}\n` +
            `*Check-out:* ${reservation.check_out}\n` +
            `*Room:* ${hotel.roomType || hotel.name}\n` +
            `*Meal plan:* ${reservation.meal_plan || 'Room only'}\n` +
            `*Total due:* ${currency} ${Number(reservation.gross_amount).toLocaleString()}\n\n` +
            `Payment pending — mark as paid in the hotel panel once received.`;
          await whatsapp.sendText(phoneNumberId, group.notification_phone, waText);
        }
      } catch (err) {
        logger.warn('HotelDirect: hotel WhatsApp notification failed', { error: err.message });
      }
    }
  }

  async _sendGuestVoucher(reservation) {
    const currency  = reservation.currency || 'KES';
    const property  = reservation.hotel_properties || {};
    const roomType  = reservation.room_types       || {};
    const ratePlan  = reservation.rate_plans       || {};
    const group     = reservation.hotel_groups     || {};

    const mealLabels = {
      room_only: 'Room Only', bed_and_breakfast: 'Bed & Breakfast',
      half_board: 'Half Board', full_board: 'Full Board', all_inclusive: 'All Inclusive',
    };

    const ancLines = Array.isArray(reservation.ancillary_services) && reservation.ancillary_services.length > 0
      ? reservation.ancillary_services.map(a => `  • ${a.name}`).join('\n')
      : '  None';

    const voucherText = `
BOOKING CONFIRMATION
${group.name || 'Hotel'} — Ref: ${reservation.reservation_ref}
${'─'.repeat(44)}

Guest:       ${reservation.guest_name}
Property:    ${property.name || ''}
Address:     ${property.address || property.location || ''}
Room:        ${roomType.name || ''} ${roomType.view ? '— ' + roomType.view : ''}
Bed type:    ${roomType.bed_type || ''}
Meal plan:   ${mealLabels[ratePlan.meal_plan] || ratePlan.meal_plan || reservation.meal_plan || 'Room only'}

Check-in:    ${reservation.check_in} from ${property.check_in_time || '14:00'}
Check-out:   ${reservation.check_out} by ${property.check_out_time || '11:00'}
Nights:      ${reservation.nights}
Guests:      ${reservation.adults} adult(s), ${reservation.children || 0} child(ren)

Add-ons:
${ancLines}

Total paid:  ${currency} ${Number(reservation.gross_amount).toLocaleString()}

${reservation.special_requests ? 'Special requests: ' + reservation.special_requests : ''}

Please present this confirmation at check-in.
    `.trim();

    if (reservation.guest_email) {
      try {
        await notificationService.sendEmail({
          to:      reservation.guest_email,
          subject: `Booking confirmed — ${reservation.reservation_ref}`,
          text:    voucherText,
        });
      } catch (err) {
        logger.warn('HotelDirect: guest email voucher failed', { error: err.message });
      }
    }

    if (reservation.guest_phone) {
      try {
        const whatsapp      = require('./whatsappService');
        const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        if (phoneNumberId) {
          const waVoucher =
            `✅ *Booking Confirmed!*\n\n` +
            `*${group.name || 'Hotel'}*\n` +
            `Ref: *${reservation.reservation_ref}*\n\n` +
            `🏨 *${property.name || ''}*\n` +
            `${property.address || property.location || ''}\n\n` +
            `🛏️ ${roomType.name || ''} ${roomType.view ? '— ' + roomType.view : ''}\n` +
            `🍽️ ${mealLabels[ratePlan.meal_plan] || reservation.meal_plan || 'Room only'}\n\n` +
            `📅 Check-in: *${reservation.check_in}* from ${property.check_in_time || '14:00'}\n` +
            `📅 Check-out: *${reservation.check_out}* by ${property.check_out_time || '11:00'}\n` +
            `🌙 ${reservation.nights} night(s) · ${reservation.adults} guest(s)\n\n` +
            `💰 *${currency} ${Number(reservation.gross_amount).toLocaleString()}* ✅ Paid\n\n` +
            `Show this message at check-in. Enjoy your stay! 🙏`;
          await whatsapp.sendText(phoneNumberId, reservation.guest_phone, waVoucher);
        }
      } catch (err) {
        logger.warn('HotelDirect: guest WhatsApp voucher failed', { error: err.message });
      }
    }

    await supabase
      .from('hotel_reservations')
      .update({ voucher_sent: true, voucher_sent_at: new Date().toISOString() })
      .eq('reservation_ref', reservation.reservation_ref);

    logger.info('HotelDirect: guest voucher sent', { reservationRef: reservation.reservation_ref });
  }

  _addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + (days || 1));
    return d.toISOString().split('T')[0];
  }
}

module.exports = new HotelDirectBookingService();