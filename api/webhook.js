const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Helper: call Supabase REST API
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error: ${res.status} ${text}`);
  }
  return res.json().catch(() => null);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    // req.body must be raw buffer — Vercel sends it as string by default
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { sessionId, surferEmail } = session.metadata || {};

    if (!sessionId) {
      console.error("No sessionId in metadata");
      return res.status(200).end();
    }

    try {
      // Look up the surfer by email
      let surferId = null;
      if (surferEmail) {
        const surfers = await supabase(`surfers?email=ilike.${encodeURIComponent(surferEmail)}&select=id`);
        if (surfers && surfers.length > 0) surferId = surfers[0].id;
      }

      // Record the purchase
      await supabase("purchases", "POST", {
        session_id: sessionId,
        surfer_id: surferId,
        surfer_email: surferEmail || session.customer_email || null,
        stripe_payment_intent: session.payment_intent,
        amount_paid: session.amount_total / 100,
        purchased_at: new Date().toISOString(),
      });

      console.log(`✅ Purchase recorded — session: ${sessionId}, surfer: ${surferEmail}`);
    } catch (err) {
      console.error("Failed to record purchase:", err.message);
      // Still return 200 so Stripe doesn't retry
    }
  }

  res.status(200).json({ received: true });
};

// Tell Vercel NOT to parse body — Stripe needs raw body for signature verification
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
