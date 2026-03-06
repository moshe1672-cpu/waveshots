const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { sessionId, sessionTitle, price, photographerStripeId, surferEmail } = req.body;

    if (!sessionId || !price || !photographerStripeId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const priceInCents = Math.round(parseFloat(price) * 100);
    const platformFee = Math.round(priceInCents * 0.20); // WaveShots keeps 20%

    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: surferEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: sessionTitle || "WaveShots Session",
              description: "Full HD surf photography bundle — instant download after purchase",
              images: ["https://waveshots.vercel.app/AdobeStock_542844415.jpeg"],
            },
            unit_amount: priceInCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: platformFee,
        transfer_data: {
          destination: photographerStripeId,
        },
      },
      metadata: {
        sessionId,
        surferEmail: surferEmail || "",
      },
      success_url: `https://waveshots.vercel.app/?payment=success&session_id=${sessionId}`,
      cancel_url: `https://waveshots.vercel.app/?payment=cancelled`,
    });

    res.status(200).json({ url: checkoutSession.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: err.message });
  }
};
