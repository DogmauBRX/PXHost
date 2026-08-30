// Several primary keys in this schema are BigInt (architecture doc 2.2:
// high-volume, always-reached-via-a-parent-UUID tables use bigserial —
// template_variables, allocations, activity_logs, audit_logs,
// server_metrics_1m). Node's JSON.stringify has never supported BigInt
// (it throws "Do not know how to serialize a BigInt" rather than, say,
// silently truncating), which crashed the very first endpoint that
// returned one — caught live by the e2e suite the moment a template with
// variables was created.
//
// Fixed globally rather than per-DTO: mapping every BigInt field to a
// string in every service/controller response is exactly the kind of
// repetitive, easy-to-forget-once transformation that becomes a recurring
// bug as more BigInt-keyed resources get endpoints. `toJSON` is the
// standard, widely-used escape hatch `JSON.stringify` already looks for.
//
// Imported once, at the very top of app.module.ts (side-effect import),
// so it runs before any controller in either the real server (main.ts)
// or an e2e test (which builds the app via `Test.createTestingModule`
// and never touches main.ts at all).
(BigInt.prototype as unknown as { toJSON(): string }).toJSON = function (this: bigint) {
  return this.toString();
};
