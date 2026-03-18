const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabase(path, method = "GET", body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase error: ${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return null; }
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log("Webhook received:", event.type);

  // ── CHECKOUT COMPLETED ─────────────────────────────────────────
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { sessionId, surferEmail } = session.metadata || {};

    console.log("Payment completed — sessionId:", sessionId, "surferEmail:", surferEmail);

    if (!sessionId) {
      console.error("No sessionId in metadata");
      return res.status(200).json({ received: true });
    }

    const isLesson = session.metadata?.isLesson === "true";

    try {
      if (isLesson) {
        // ── LESSON BOOKING ───────────────────────────────────────
        console.log("Lesson booking — lessonId:", sessionId);

        // Idempotency check against bookings table
        const existingBooking = await supabase(`bookings?stripe_payment_id=eq.${session.payment_intent}&select=id`);
        if (existingBooking && existingBooking.length > 0) {
          console.log("⚠️ Booking already recorded — skipping");
          return res.status(200).json({ received: true });
        }

        // Look up surfer
        let surferId = null;
        if (surferEmail) {
          try {
            const surfers = await supabase(`surfers?email=ilike.${encodeURIComponent(surferEmail)}&select=id`);
            if (surfers && surfers.length > 0) surferId = surfers[0].id;
          } catch (e) { console.error("Surfer lookup failed:", e.message); }
        }

        // Look up lesson for coach info
        let coachId = null;
        let coachStripeId = null;
        try {
          const lessons = await supabase(`lessons?id=eq.${sessionId}&select=coach_id`);
          if (lessons && lessons.length > 0) {
            coachId = lessons[0].coach_id;
            const coaches = await supabase(`photographers?id=eq.${coachId}&select=stripe_account_id,platform_fee`);
            if (coaches && coaches.length > 0) {
              coachStripeId = coaches[0].stripe_account_id;
            }
          }
        } catch (e) { console.error("Lesson lookup failed:", e.message); }

        const amountPaid = session.amount_total / 100;
        const payoutStatus = coachStripeId ? "paid" : "pending";

        // Mark lesson as booked
        try {
          await supabase(`lessons?id=eq.${sessionId}`, "PATCH", { status: "booked" });
          console.log("✅ Lesson marked as booked");
        } catch (e) { console.error("Failed to mark lesson booked:", e.message); }

        // Record booking
        try {
          await supabase("bookings", "POST", {
            lesson_id: sessionId,
            surfer_id: surferId,
            coach_id: coachId,
            stripe_payment_id: session.payment_intent,
            amount: amountPaid,
            status: payoutStatus === "paid" ? "confirmed" : "pending",
            created_at: new Date().toISOString(),
          });
          console.log("✅ Booking recorded");
        } catch (e) { console.error("Booking record failed:", e.message); }

        // Record payout for coach
        if (coachId) {
          try {
            const platformFeeAmt = parseFloat((amountPaid * (session.metadata?.platformFee ? parseFloat(session.metadata.platformFee) / 100 : 0.01)).toFixed(2));
            const coachEarnings = parseFloat((amountPaid - platformFeeAmt).toFixed(2));
            await supabase("payouts", "POST", {
              photographer_id: coachId,
              session_id: sessionId,
              amount: coachEarnings,
              platform_fee: platformFeeAmt,
              status: payoutStatus,
              stripe_payment_intent: session.payment_intent,
              paid_at: payoutStatus === "paid" ? new Date().toISOString() : null,
              created_at: new Date().toISOString(),
            });
            console.log(`✅ Coach payout recorded with status: ${payoutStatus}`);
          } catch (e) { console.error("Coach payout record failed:", e.message); }
        }

      } else {
        // ── REGULAR PHOTO SESSION PURCHASE ───────────────────────
        // Idempotency check — skip if already recorded
        const existing = await supabase(`purchases?stripe_payment_id=eq.${session.payment_intent}&select=id`);
        if (existing && existing.length > 0) {
          console.log("⚠️ Already recorded for payment intent:", session.payment_intent, "— skipping");
          return res.status(200).json({ received: true });
        }

        // Look up surfer
        let surferId = null;
        if (surferEmail) {
          try {
            const surfers = await supabase(`surfers?email=ilike.${encodeURIComponent(surferEmail)}&select=id`);
            if (surfers && surfers.length > 0) surferId = surfers[0].id;
          } catch (e) { console.error("Surfer lookup failed:", e.message); }
        }

        // Look up session for photographer
        let photographerId = null;
        let photographerStripeId = null;
        try {
          const sessions = await supabase(`sessions?id=eq.${sessionId}&select=photographer_id`);
          if (sessions && sessions.length > 0) {
            photographerId = sessions[0].photographer_id;
            const photogs = await supabase(`photographers?id=eq.${photographerId}&select=stripe_account_id`);
            if (photogs && photogs.length > 0) photographerStripeId = photogs[0].stripe_account_id;
          }
        } catch (e) { console.error("Session lookup failed:", e.message); }

        const amountPaid = session.amount_total / 100;
        const photographerEarnings = parseFloat((amountPaid * 0.8).toFixed(2));
        const platformFee = parseFloat((amountPaid * 0.2).toFixed(2));
        const payoutStatus = photographerStripeId ? "paid" : "pending";

        // Mark session as sold
        try {
          await supabase(`sessions?id=eq.${sessionId}`, "PATCH", { is_sold: true });
          console.log("✅ Session marked as sold");
        } catch (e) { console.error("Failed to mark session sold:", e.message); }

        // Record purchase
        await supabase("purchases", "POST", {
          session_id: sessionId,
          surfer_id: surferId,
          customer_email: surferEmail || session.customer_email || null,
          stripe_payment_id: session.payment_intent,
          purchased_at: new Date().toISOString(),
        });
        console.log("✅ Purchase recorded");

        // Record payout
        if (photographerId) {
          try {
            await supabase("payouts", "POST", {
              photographer_id: photographerId,
              session_id: sessionId,
              amount: photographerEarnings,
              platform_fee: platformFee,
              status: payoutStatus,
              stripe_payment_intent: session.payment_intent,
              paid_at: payoutStatus === "paid" ? new Date().toISOString() : null,
              created_at: new Date().toISOString(),
            });
            console.log(`✅ Payout recorded with status: ${payoutStatus}`);
          } catch (e) { console.error("Payout record failed:", e.message); }
        }
      }

    } catch (err) {
      console.error("Failed to process payment:", err.message);
    }
  }

  res.status(200).json({ received: true });
};

module.exports.config = {
  api: { bodyParser: false },
};
