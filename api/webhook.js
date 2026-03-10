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

  let event;
  try {
    const rawBody = await getRawBody(req);
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

    try {
      // Look up surfer by email
      let surferId = null;
      if (surferEmail) {
        try {
          const surfers = await supabase(
            `surfers?email=ilike.${encodeURIComponent(surferEmail)}&select=id`
          );
          if (surfers && surfers.length > 0) surferId = surfers[0].id;
          console.log("Found surfer ID:", surferId);
        } catch (e) {
          console.error("Surfer lookup failed:", e.message);
        }
      }

      // Look up session to get photographer_id
      let photographerId = null;
      try {
        const sessions = await supabase(`sessions?id=eq.${sessionId}&select=photographer_id,price`);
        if (sessions && sessions.length > 0) {
          photographerId = sessions[0].photographer_id;
        }
        console.log("Session photographer:", photographerId);
      } catch (e) {
        console.error("Session lookup failed:", e.message);
      }

      const amountPaid = session.amount_total / 100;
      const photographerEarnings = parseFloat((amountPaid * 0.8).toFixed(2));

      // Mark session as sold
      try {
        await supabase(`sessions?id=eq.${sessionId}`, "PATCH", { is_sold: true });
        console.log("✅ Session marked as sold");
      } catch (e) {
        console.error("Failed to mark session sold:", e.message);
      }

      // Record purchase
      const purchase = await supabase("purchases", "POST", {
        session_id: sessionId,
        surfer_id: surferId,
        customer_email: surferEmail || session.customer_email || null,
        stripe_payment_id: session.payment_intent,
        purchased_at: new Date().toISOString(),
      });
      console.log("✅ Purchase recorded:", JSON.stringify(purchase));

      // Record payout for photographer
      if (photographerId) {
        try {
          const payout = await supabase("payouts", "POST", {
            photographer_id: photographerId,
            session_id: sessionId,
            amount: photographerEarnings,
            platform_fee: parseFloat((amountPaid * 0.2).toFixed(2)),
            status: "pending",
            stripe_payment_intent: session.payment_intent,
            created_at: new Date().toISOString(),
          });
          console.log("✅ Payout recorded:", JSON.stringify(payout));
        } catch (e) {
          console.error("Payout record failed:", e.message);
        }
      }

    } catch (err) {
      console.error("Failed to process payment:", err.message);
    }
  }

  // ── TRANSFER PAID (photographer received their money) ──────────
  if (event.type === "transfer.paid") {
    const transfer = event.data.object;
    const paymentIntent = transfer.source_transaction || transfer.metadata?.payment_intent;

    console.log("Transfer paid — transfer id:", transfer.id, "payment_intent:", paymentIntent);

    if (paymentIntent) {
      try {
        // Find the matching payout by stripe_payment_intent and mark as paid
        const result = await supabase(
          `payouts?stripe_payment_intent=eq.${paymentIntent}`,
          "PATCH",
          {
            status: "paid",
            paid_at: new Date().toISOString(),
          }
        );
        console.log("✅ Payout marked as paid:", JSON.stringify(result));
      } catch (e) {
        console.error("Failed to update payout status:", e.message);
      }
    } else {
      // Fallback: try matching by transfer amount and recent pending payouts
      console.warn("No payment_intent on transfer — cannot auto-match payout");
    }
  }

  // ── TRANSFER FAILED ────────────────────────────────────────────
  if (event.type === "transfer.failed") {
    const transfer = event.data.object;
    const paymentIntent = transfer.source_transaction || transfer.metadata?.payment_intent;

    console.log("Transfer FAILED — transfer id:", transfer.id);

    if (paymentIntent) {
      try {
        await supabase(
          `payouts?stripe_payment_intent=eq.${paymentIntent}`,
          "PATCH",
          { status: "failed" }
        );
        console.log("✅ Payout marked as failed");
      } catch (e) {
        console.error("Failed to update payout status to failed:", e.message);
      }
    }
  }

  res.status(200).json({ received: true });
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
