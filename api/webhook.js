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

    try {
      let surferId = null;
      if (surferEmail) {
        try {
          const surfers = await supabase(`surfers?email=ilike.${encodeURIComponent(surferEmail)}&select=id`);
          if (surfers && surfers.length > 0) surferId = surfers[0].id;
          console.log("Found surfer ID:", surferId);
        } catch (e) {
          console.error("Surfer lookup failed:", e.message);
        }
      }

      let photographerId = null;
      try {
        const sessions = await supabase(`sessions?id=eq.${sessionId}&select=photographer_id,price`);
        if (sessions && sessions.length > 0) photographerId = sessions[0].photographer_id;
        console.log("Session photographer:", photographerId);
      } catch (e) {
        console.error("Session lookup failed:", e.message);
      }

      const amountPaid = session.amount_total / 100;
      const photographerEarnings = parseFloat((amountPaid * 0.8).toFixed(2));

      // Idempotency check — skip if purchase already recorded for this payment intent
      try {
        const existing = await supabase(`purchases?stripe_payment_id=eq.${session.payment_intent}&select=id`);
        if (existing && existing.length > 0) {
          console.log("⚠️ Purchase already recorded for payment intent:", session.payment_intent, "— skipping duplicate");
          return res.status(200).json({ received: true });
        }
      } catch (e) {
        console.error("Idempotency check failed:", e.message);
      }

      try {
        await supabase(`sessions?id=eq.${sessionId}`, "PATCH", { is_sold: true });
        console.log("✅ Session marked as sold");
      } catch (e) {
        console.error("Failed to mark session sold:", e.message);
      }

      const purchase = await supabase("purchases", "POST", {
        session_id: sessionId,
        surfer_id: surferId,
        customer_email: surferEmail || session.customer_email || null,
        stripe_payment_id: session.payment_intent,
        purchased_at: new Date().toISOString(),
      });
      console.log("✅ Purchase recorded:", JSON.stringify(purchase));

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

  // ── TRANSFER CREATED (photographer payout sent) ────────────────
  if (event.type === "transfer.created") {
    const transfer = event.data.object;
    const sourceTransaction = transfer.source_transaction; // ch_ charge ID
    const metaPaymentIntent = transfer.metadata?.originalPaymentIntent || transfer.metadata?.payment_intent;

    console.log("Transfer created — id:", transfer.id, "source_transaction:", sourceTransaction, "meta pi:", metaPaymentIntent);

    try {
      let matched = false;

      // Strategy 1: match by payment_intent stored in transfer metadata
      if (metaPaymentIntent) {
        await supabase(`payouts?stripe_payment_intent=eq.${metaPaymentIntent}`, "PATCH", {
          status: "paid",
          paid_at: new Date().toISOString()
        });
        matched = true;
        console.log("✅ Matched payout by payment_intent metadata:", metaPaymentIntent);
      }

      // Strategy 2: resolve ch_ charge → pi_ payment intent, then match
      if (!matched && sourceTransaction && sourceTransaction.startsWith("ch_")) {
        const charge = await stripe.charges.retrieve(sourceTransaction);
        const pi = charge.payment_intent;
        if (pi) {
          await supabase(`payouts?stripe_payment_intent=eq.${pi}`, "PATCH", {
            status: "paid",
            paid_at: new Date().toISOString()
          });
          matched = true;
          console.log("✅ Matched payout by charge→payment_intent:", pi);
        }
      }

      if (!matched) console.warn("⚠️ Could not match transfer to a payout row:", transfer.id);
    } catch (e) {
      console.error("Failed to update payout status:", e.message);
    }
  }

  // ── TRANSFER REVERSED ──────────────────────────────────────────
  if (event.type === "transfer.reversed") {
    const transfer = event.data.object;
    const metaPaymentIntent = transfer.metadata?.originalPaymentIntent || transfer.metadata?.payment_intent;

    console.log("Transfer reversed — id:", transfer.id);

    if (metaPaymentIntent) {
      try {
        await supabase(`payouts?stripe_payment_intent=eq.${metaPaymentIntent}`, "PATCH", { status: "failed" });
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
