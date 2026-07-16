const { chromium } = require('playwright');
const supabase = require('../utils/supabase');
const PROPERTIES = [
  {
    groupSlug: 'sarova',
    name: 'Sarova Whitesands Beach Resort & Spa',
    bookingUrl: 'https://www.booking.com/hotel/ke/sarova-whitesands-beach-resort-amp-spa.en-gb.html'
  },
  {
    groupSlug: 'sarova',
    name: 'Sarova Panafric',
    bookingUrl: 'https://www.booking.com/hotel/ke/sarova-panafric.en-gb.html'
  }
];

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toDateStr(date) {
  return date.toISOString().split('T')[0];
}

async function scrapeBookingRate(page, property, checkIn, checkOut) {
  try {
    const url = new URL(property.bookingUrl);
    url.searchParams.set('checkin', checkIn);
    url.searchParams.set('checkout', checkOut);
    url.searchParams.set('group_adults', '2');
    url.searchParams.set('no_rooms', '1');
    url.searchParams.set('lang', 'en-gb');

    console.log(`  Fetching ${property.name} | ${checkIn} ...`);

    await page.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 40000
    });

    // Wait for prices to render
    await page.waitForTimeout(4000);

    // Try multiple selectors — Booking.com changes their HTML often
    const selectors = [
      '[data-testid="price-and-discounted-price"]',
      '[data-testid="recommended-units"] [class*="price"]',
      '.bui-price-display__value',
      '[class*="prco-valign"]',
      '[data-testid="price-for-x-nights"]',
      '.hp-av-result-price',
      'span[class*="Price"]'
    ];

    let rawText = null;

    for (const selector of selectors) {
      try {
        const el = await page.$(selector);
        if (el) {
          rawText = await el.innerText();
          if (rawText && rawText.match(/\d{3,}/)) break;
        }
      } catch (e) { continue; }
    }

    if (!rawText) {
      // Last resort — grab all text that looks like a price
      rawText = await page.evaluate(() => {
        const els = document.querySelectorAll('*');
        for (const el of els) {
          const txt = el.innerText || '';
          if (txt.match(/KES\s*[\d,]+/) && el.children.length === 0) return txt;
        }
        return null;
      });
    }

    if (!rawText) {
      console.log(`  ✗ No price found for ${property.name} ${checkIn}`);
      return null;
    }

    const numericStr = rawText.replace(/[^0-9]/g, '');
    const rate = parseInt(numericStr, 10);

    if (!rate || rate < 1000 || rate > 500000) {
      console.log(`  ✗ Implausible rate ${rate} for ${property.name} — skipping`);
      return null;
    }

    console.log(`  ✓ ${property.name} | ${checkIn} | booking.com: KES ${rate.toLocaleString()}`);
    return rate;

  } catch (err) {
    console.error(`  ✗ Error scraping ${property.name} ${checkIn}:`, err.message);
    return null;
  }
}

async function runScraper() {
  console.log('\n[RateScraper] Starting run at', new Date().toISOString());

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-GB',
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();

  // Block images/fonts to speed up scraping
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', route => route.abort());

  const today = new Date();
  let saved = 0;

  for (const property of PROPERTIES) {
    console.log(`\n[RateScraper] Scraping ${property.name}...`);

    for (let daysOut = 1; daysOut <= 30; daysOut++) {
      const ci = addDays(today, daysOut);
      const co = addDays(ci, 1);
      const checkIn  = toDateStr(ci);
      const checkOut = toDateStr(co);

      const rate = await scrapeBookingRate(page, property, checkIn, checkOut);

      if (rate) {
        // Mark old rates stale
        await supabase
          .from('competitor_rates')
          .update({ is_current: false })
          .match({
            group_slug:    property.groupSlug,
            property_name: property.name,
            check_in:      checkIn
          });

        // Insert fresh rate
        const { error } = await supabase
          .from('competitor_rates')
          .insert({
            group_slug:    property.groupSlug,
            property_name: property.name,
            check_in:      checkIn,
            nights:        1,
            ota_name:      'booking.com',
            ota_rate:      rate,
            currency:      'KES',
            is_current:    true
          });

        if (!error) saved++;
        else console.error('  Supabase insert error:', error.message);
      }

      // Polite delay — avoid getting blocked
      const delay = 3000 + Math.random() * 3000;
      await page.waitForTimeout(delay);
    }

    console.log(`[RateScraper] Done with ${property.name}`);
    // Longer pause between properties
    await page.waitForTimeout(8000);
  }

  await browser.close();
  console.log(`\n[RateScraper] Complete — ${saved} rates saved to Supabase\n`);
}

module.exports = { runScraper };