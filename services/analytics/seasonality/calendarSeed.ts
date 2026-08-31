// C5's seed data — real Indian festive dates for 2025 and 2026, the years B5/C1's order history
// covers (2025-01-15 -> 2025-12-13, with a known gap to ~2026-07-02; "today" per this step's own
// implementation is 2026-08-31). IMPLEMENTATION_PLAN.md C5: "Seed it with real Indian festive
// dates for the years the data covers (2025 onward); state your source for the dates and mark
// any you are unsure of."
//
// This file is the SEED, not the source of truth. Once seedSeasonalCalendarHandler
// (seedTask.ts) writes these into `seasonalCalendarWindows`, the Firestore documents are what
// `seasonalityContextFor` actually reads — an operator correcting a mis-estimated date edits the
// Firestore document directly (or via a small admin script), which takes effect immediately,
// with no deploy. See calendarRepo.ts's module comment for exactly how that interacts with this
// file on a future re-seed.
//
// Every entry below is `confidence: "confirmed"` only when EVERY day in [startDay, endDay] is
// independently corroborated by a cited source; otherwise `"estimated"`, with `notes` stating
// which part is confirmed and which was derived by calendar convention (typically "the customary
// day before a confirmed festival day, when pre-festival gift/gold shopping starts"). Sources
// were checked live (web search) while authoring this file, not recalled from training data —
// festival dates move on the lunar calendar and must never be guessed.
//
// Design choices, stated plainly:
//   - `dhanteras` and `diwali` are modeled as two adjacent but DISJOINT windows (dhanteras ends
//     the day the diwali window begins), not one nested inside the other — Dhanteras is, on its
//     own, the single most important gold/jewellery-buying day in the Indian calendar and this
//     account's own product category, so it earns its own distinct label rather than being
//     absorbed into the broader 5-day Diwali window. This also matches the interface's own
//     documented example, `["wedding_season","dhanteras"]` (dhanteras without diwali).
//   - `navratri`'s window includes Vijayadashami/Dussehra (the culminating day) rather than
//     treating Dussehra as a tenth label — this account's own evidence (a live ad set named
//     "Navratri sale 15% OFF| AD") ties the whole period, not just the nine nights, to one
//     shopping season.
//   - `wedding_season` windows are deliberately coarser than the festival windows above: unlike
//     a festival's tithi, "wedding season" is a commercial-convention date range (mid-November
//     through mid-February, and again mid-April through June, avoiding the Chaturmas period when
//     Hindu weddings are not performed), not a specific muhurat list. Every wedding_season entry
//     is marked "estimated" for this reason — narrowing it to actual muhurat-dense sub-ranges is
//     future work for whoever has a reason to need that precision, not guessed here.
//   - Only the five labels IMPLEMENTATION_PLAN.md C5 names explicitly (diwali, navratri,
//     dhanteras, akshaya_tritiya, wedding_season) plus three additional well-sourced, broadly
//     recognized Indian gifting/shopping occasions (holi, raksha_bandhan, ganesh_chaturthi) are
//     seeded. Other festivals (Onam, Pongal, regional New Year days, etc.) are not included —
//     not because they don't matter, but because there is no account-specific evidence yet that
//     they do, and adding a label later is exactly the one-line, no-deploy data edit this table
//     exists to make cheap.

import type { ReportingDay } from "@shared/schema/index.ts";

export interface SeasonalCalendarSeedEntry {
  label: string;
  startDay: ReportingDay;
  endDay: ReportingDay;
  year: number;
  confidence: "confirmed" | "estimated";
  source: string;
  notes: string | null;
}

const WEDDING_SEASON_SOURCE =
  "Web search, Aug 2026 (shaadidukaan.com, samajsaathi.com/blog/wedding-season-2026-india-guide, " +
  "weddingwire.in/wedding-tips/marriage-dates--c11524): Indian wedding season conventionally opens " +
  "around Dev Uthani Ekadashi (~mid-November) and runs through ~mid-February, resuming ~mid-April " +
  "through June/early July, avoiding the Chaturmas period (no Hindu wedding muhurats roughly " +
  "August-October). Calendar-month approximation, not a muhurat list — see module comment.";

export const SEASONAL_CALENDAR_SEED_ENTRIES: SeasonalCalendarSeedEntry[] = [
  // ---- Holi ------------------------------------------------------------------------------
  {
    label: "holi",
    startDay: "2025-03-13",
    endDay: "2025-03-14",
    year: 2025,
    confidence: "confirmed",
    source:
      "Web search, Aug 2026 (floweraura.com/blog/holi-calendar, holifestival.org/holi-calendar.html): " +
      "Holika Dahan 13 March 2025, Rangwali Holi 14 March 2025.",
    notes: null,
  },
  {
    label: "holi",
    startDay: "2026-03-03",
    endDay: "2026-03-04",
    year: 2026,
    confidence: "estimated",
    source:
      "Web search, Aug 2026: multiple sources cite Holi (Rangwali) 2026 = 4 March. Holika Dahan " +
      "specifically for 2026 was not independently confirmed in the search results.",
    notes:
      "4 Mar (main day) confirmed; 3 Mar is the customary Holika Dahan eve, estimated by convention.",
  },

  // ---- Akshaya Tritiya (gold/jewellery-buying day) ----------------------------------------
  {
    label: "akshaya_tritiya",
    startDay: "2025-04-29",
    endDay: "2025-04-30",
    year: 2025,
    confidence: "estimated",
    source:
      "Web search, Aug 2026 (outlookindia.com/brand-studio/festivals/akshaya-tritiya-2025, " +
      "ganeshaspeaks.com/predictions/festivals/akshaya-tritiya-festival, drikpanchang.com): " +
      "Akshaya Tritiya 2025 = 30 April (Wednesday).",
    notes: "30 Apr (main day) confirmed; 29 Apr is the customary pre-day, estimated.",
  },
  {
    label: "akshaya_tritiya",
    startDay: "2026-04-20",
    endDay: "2026-04-21",
    year: 2026,
    confidence: "estimated",
    source:
      "Web search, Aug 2026 (hindusphere.com/akshaya-tritiya-2026-date, thedevlok.com/festivals/2026/akshaya-tritiya): " +
      "Akshaya Tritiya 2026 = 21 April.",
    notes: "21 Apr (main day) confirmed; 20 Apr is the customary pre-day, estimated.",
  },

  // ---- Raksha Bandhan (gifting occasion) ---------------------------------------------------
  {
    label: "raksha_bandhan",
    startDay: "2025-08-09",
    endDay: "2025-08-09",
    year: 2025,
    confidence: "confirmed",
    source:
      "Web search, Aug 2026 (en.wikipedia.org/wiki/Raksha_Bandhan and corroborating results): 9 August 2025.",
    notes: null,
  },
  {
    label: "raksha_bandhan",
    startDay: "2026-08-28",
    endDay: "2026-08-28",
    year: 2026,
    confidence: "confirmed",
    source: "Web search, Aug 2026: Raksha Bandhan 2026 = 28 August (Friday).",
    notes: null,
  },

  // ---- Ganesh Chaturthi ---------------------------------------------------------------------
  {
    label: "ganesh_chaturthi",
    startDay: "2025-08-27",
    endDay: "2025-08-27",
    year: 2025,
    confidence: "confirmed",
    source:
      "Web search, Aug 2026 (drikpanchang.com-cited results, olyv.co.in): Ganesh Chaturthi 2025 = 27 August (Wednesday).",
    notes:
      "Only the opening day is modeled — the full ~10-day festival through Anant Chaturdashi was " +
      "not independently date-confirmed for this account's purposes.",
  },
  {
    label: "ganesh_chaturthi",
    startDay: "2026-09-14",
    endDay: "2026-09-14",
    year: 2026,
    confidence: "confirmed",
    source: "Web search, Aug 2026: Ganesh Chaturthi 2026 = 14 September (Monday).",
    notes: "Only the opening day is modeled — see the 2025 entry's note.",
  },

  // ---- Navratri (includes Vijayadashami/Dussehra — see module comment) ---------------------
  {
    label: "navratri",
    startDay: "2025-09-22",
    endDay: "2025-10-02",
    year: 2025,
    confidence: "confirmed",
    source:
      "Web search, Aug 2026 (radhakrishnatemple.net/blog/navratri-2025-guide, fibe.in, " +
      "ethnicindiahandicrafts.com): Navratri 2025 begins 22 September, ends 1 October; " +
      "Vijayadashami/Dussehra 2 October 2025.",
    notes: "Window extended one day past Navratri proper to include Dussehra — see module comment.",
  },
  {
    label: "navratri",
    startDay: "2026-10-11",
    endDay: "2026-10-20",
    year: 2026,
    confidence: "confirmed",
    source:
      "Web search, Aug 2026 (vrindavanmathuratourism.com/blogs/sharad-navratri-2026, " +
      "hindutone.com, ishvaram.com, divinehindu.in — citing Drik Panchang): Sharad Navratri 2026 " +
      "Ghatasthapana 11 October, Maha Navami 19 October; Vijayadashami/Dussehra 20 October 2026 " +
      "(a 10-calendar-day span this year because Saptami tithi spans two dates).",
    notes: "Window extended to include Dussehra — see module comment.",
  },

  // ---- Dhanteras (single most important jewellery-buying day) -------------------------------
  {
    label: "dhanteras",
    startDay: "2025-10-17",
    endDay: "2025-10-18",
    year: 2025,
    confidence: "estimated",
    source:
      "Web search, Aug 2026 (outlookindia.com/astrology, dnaindia.com, newsonair.gov.in): " +
      "Dhanteras 2025 = 18 October (Saturday).",
    notes: "18 Oct (main day) confirmed; 17 Oct is the customary pre-shopping day, estimated.",
  },
  {
    label: "dhanteras",
    startDay: "2026-11-05",
    endDay: "2026-11-06",
    year: 2026,
    confidence: "estimated",
    source:
      "Web search, Aug 2026 (devaastha.com, shrimahalaxmicalendar.com, daanyam.in, astrozindagi.in): " +
      "Dhanteras 2026 = 6 November (Friday).",
    notes: "6 Nov (main day) confirmed; 5 Nov is the customary pre-shopping day, estimated.",
  },

  // ---- Diwali (Choti Diwali through Bhai Dooj; Dhanteras modeled separately, above) ---------
  {
    label: "diwali",
    startDay: "2025-10-19",
    endDay: "2025-10-23",
    year: 2025,
    confidence: "estimated",
    source:
      "Web search, Aug 2026 (dnaindia.com/viral: 'Dhanteras Oct 18 ... ending with Bhai Dooj on " +
      "October 23'; vedantu.com, triptotemples.com, jabalpurtoday.com): main Diwali/Lakshmi Puja " +
      "20 October 2025 (confirmed); Bhai Dooj 23 October 2025 (confirmed).",
    notes:
      "20 Oct (main Diwali) and 23 Oct (Bhai Dooj) confirmed; 19 Oct (Choti Diwali) and 22 Oct " +
      "(Govardhan Puja) are the standard intervening days by convention, estimated.",
  },
  {
    label: "diwali",
    startDay: "2026-11-07",
    endDay: "2026-11-10",
    year: 2026,
    confidence: "estimated",
    source:
      "Web search, Aug 2026 (samvat.in/festivals/diwali-2026, archyam.com, mygiftscorner.com): " +
      "Dhanteras 6 Nov, Choti Diwali 7 Nov, Diwali/Lakshmi Puja 8 Nov, Govardhan Puja 9 Nov, " +
      "Bhai Dooj 10 Nov 2026.",
    notes:
      "8 Nov (main Diwali) confirmed by multiple sources; 7/9/10 Nov corroborated by the same calendar listing but not independently cross-checked against a second source — treated as estimated out of caution.",
  },

  // ---- Wedding season (coarse commercial-convention window — see module comment) -----------
  {
    label: "wedding_season",
    startDay: "2024-11-15",
    endDay: "2025-02-15",
    year: 2025,
    confidence: "estimated",
    source: WEDDING_SEASON_SOURCE,
    notes:
      "Tail end of the 2024-25 winter wedding season, overlapping the start of this account's order history (2025-01-15).",
  },
  {
    label: "wedding_season",
    startDay: "2025-04-15",
    endDay: "2025-06-30",
    year: 2025,
    confidence: "estimated",
    source: WEDDING_SEASON_SOURCE,
    notes: "2025 summer wedding season.",
  },
  {
    label: "wedding_season",
    startDay: "2025-11-15",
    endDay: "2026-02-15",
    year: 2026,
    confidence: "estimated",
    source: WEDDING_SEASON_SOURCE,
    notes:
      "2025-26 winter wedding season, overlapping the tail of B5's Shopify data gap (through ~2026-07-02).",
  },
  {
    label: "wedding_season",
    startDay: "2026-04-15",
    endDay: "2026-06-30",
    year: 2026,
    confidence: "estimated",
    source: WEDDING_SEASON_SOURCE,
    notes: "2026 summer wedding season.",
  },
  {
    label: "wedding_season",
    startDay: "2026-11-15",
    endDay: "2027-02-15",
    year: 2027,
    confidence: "estimated",
    source: WEDDING_SEASON_SOURCE,
    notes:
      "2026-27 winter wedding season — seeded ahead of the other 2027 dates since it is imminent relative to this step's implementation date (2026-08-31); other 2027 festival dates are not yet seeded (out of scope: seed years the data covers, 2025 onward, not the whole future).",
  },
];
