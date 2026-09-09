-- Checkout Bricks pivot: Pix payments are now created directly
-- (Payment.create with payment_method_id='pix'), never via a
-- Preference/redirect. The QR code comes back SYNCHRONOUSLY in that
-- create call's own response and is stored here so the customer's
-- status page can re-render it on every visit/poll without generating
-- a brand new Pix payment each time.
ALTER TABLE "orders" ADD COLUMN "pix_qr_code" TEXT;
ALTER TABLE "orders" ADD COLUMN "pix_qr_code_base64" TEXT;
