const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { stripePaymentIntentId, photographerStripeId, amount, purchaseId } = req.body;

    if (!stripePaymentIntentId || !photographerStripeId || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify the connected account is fully onboarded
    const account = await stripe.accounts.retrieve(photographerStripeId);
    const canTransfer =
      account.charges_enabled &&
      account.payouts_enabled &&
      account.capabilities?.transfers === "active";

    if (!canTransfer) {
      return res.status(400).json({
        error: "Photographer Stripe account is not fully onboarded. They need to complete bank account setup first."
      });
    }

    // Resolve Charge ID from Payment Intent.
    // Stripe transfers require source_transaction to be a ch_ Charge ID, not a pi_ Payment Intent ID.
    let chargeId = stripePaymentIntentId;

    if (stripePaymentIntentId.startsWith("pi_")) {
      const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
      chargeId = paymentIntent.latest_charge;
      if (!chargeId) {
        return res.status(400).json({
          error: "No charge found for this payment intent. It may not have been captured yet."
        });
      }
      console.log(`Resolved ${stripePaymentIntentId} → charge ${chargeId}`);
    }

    // Calculate 80% photographer share (in cents)
    const transferAmount = Math.round(parseFloat(amount) * 0.80 * 100);

    // Create the transfer using the Charge ID as source_transaction
    const transfer = await stripe.transfers.create({
      amount: transferAmount,
      currency: "usd",
      destination: photographerStripeId,
      source_transaction: chargeId,
      metadata: {
        purchaseId: purchaseId || "",
        originalPaymentIntent: stripePaymentIntentId
      }
    });

    console.log(`✅ Transfer ${transfer.id}: $${transferAmount / 100} → ${photographerStripeId}`);

    res.status(200).json({
      success: true,
      transferId: transfer.id,
      amount: transferAmount / 100,
      chargeId
    });

  } catch (err) {
    console.error("Manual transfer error:", err);
    res.status(500).json({ error: err.message });
  }
};
