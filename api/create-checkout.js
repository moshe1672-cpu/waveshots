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
    const { sessionId, sessionTitle, price, photographerStripeId, surferEmail, platformFee, lessonId, isLesson } = req.body;

    if (!sessionId || !price) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const priceInCents = Math.round(parseFloat(price) * 100);

    // Only add transfer split if photographer has a fully onboarded Stripe account
    const paymentIntentData = {};
    if (photographerStripeId) {
      try {
        const account = await stripe.accounts.retrieve(photographerStripeId);
        const canTransfer =
          account.charges_enabled &&
          account.payouts_enabled &&
          account.capabilities?.transfers === "active";

        if (canTransfer) {
          const feePercent = (platformFee != null ? platformFee : 20) / 100;
          const platformFeeAmt = Math.round(priceInCents * feePercent);
          paymentIntentData.application_fee_amount = platformFeeAmt;
          paymentIntentData.transfer_data = { destination: photographerStripeId };
        } else {
          console.log(`Photographer ${photographerStripeId} not fully onboarded — skipping transfer`);
        }
      } catch (accountErr) {
        console.log("Could not retrieve photographer Stripe account:", accountErr.message);
        // Continue without transfer — don't block the purchase
      }
    }

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
      payment_intent_data: paymentIntentData,
      metadata: {
        sessionId,
        surferEmail: surferEmail || "",
        isLesson: isLesson ? "true" : "false",
        platformFee: String(platformFee != null ? platformFee : 20),
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
