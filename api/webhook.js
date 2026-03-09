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

      // Record purchase — column names match your actual Supabase table
      const purchase = await supabase("purchases", "POST", {
        session_id: sessionId,
        surfer_id: surferId,
        customer_email: surferEmail || session.customer_email || null,
        stripe_payment_id: session.payment_intent,
        purchased_at: new Date().toISOString(),
      });

      console.log("✅ Purchase recorded:", JSON.stringify(purchase));
    } catch (err) {
      console.error("Failed to record purchase:", err.message);
    }
  }

  res.status(200).json({ received: true });
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
