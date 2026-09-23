-- Customer-facing processor/hardware label for the commercial catalog.
-- This is display metadata only and does not affect placement or capacity.
ALTER TABLE "plans" ADD COLUMN "hardware_label" TEXT;
