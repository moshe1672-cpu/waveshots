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
      Prefer: method === "PATCH" ? "return=representation" : "",
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { photographerId, email, name } = req.body;

    if (!photographerId || !email) {
      return res.status(400).json({ error: "Missing photographerId or email" });
    }

    // Check if photographer already has a Stripe account
    const photographers = await supabase(
      `photographers?id=eq.${photographerId}&select=id,stripe_account_id`
    );
    const photographer = photographers?.[0];
    if (!photographer) return res.status(404).json({ error: "Photographer not found" });

    let stripeAccountId = photographer.stripe_account_id;

    // Create a new Connect account if they don't have one
    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: "individual",
        metadata: { photographerId },
      });
      stripeAccountId = account.id;

      // Save the Stripe account ID to Supabase
      await supabase(`photographers?id=eq.${photographerId}`, "PATCH", {
        stripe_account_id: stripeAccountId,
      });
    }

    // Generate onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `https://waveshots.vercel.app/?stripe=refresh&photographer_id=${photographerId}`,
      return_url: `https://waveshots.vercel.app/?stripe=success&photographer_id=${photographerId}`,
      type: "account_onboarding",
    });

    res.status(200).json({ url: accountLink.url });
  } catch (err) {
    console.error("Connect onboard error:", err);
    res.status(500).json({ error: err.message });
  }
};
