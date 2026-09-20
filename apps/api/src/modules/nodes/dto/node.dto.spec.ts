import 'reflect-metadata'; // the DTO's decorators need it; main.ts/NestFactory normally pulls it in
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HeartbeatDto, SERVER_POWER_STATES } from './node.dto';

/**
 * The heartbeat's `servers` array is the only writer of
 * `servers.power_state`, a column the platform branches on ("is this
 * server offline?"). A value that isn't one of the agent's own srv.State
 * constants must be refused at the edge — stored, an unknown string
 * would read as "not offline" everywhere at once.
 *
 * Asserted here rather than in nodes.e2e-spec.ts because that suite
 * builds its app with Test.createTestingModule and never installs
 * main.ts's global ValidationPipe, so no DTO validation runs there.
 * These options mirror that pipe's real configuration.
 */
async function validateHeartbeat(payload: unknown) {
  const dto = plainToInstance(HeartbeatDto, payload, { enableImplicitConversion: false });
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

/**
 * A REAL id shape from this database, not a synthetic one: `Server.id` is
 * `dbgenerated("uuidv7()")`, so every uuid the agent ever echoes back in a
 * heartbeat is version 7. A validator that only accepted v4 would reject
 * every genuine heartbeat in production while passing any hand-written
 * test fixture — the exact bug this constant exists to prevent.
 */
const REAL_UUID_V7 = '0199a3cd-4e2f-7b8a-9c1d-2e3f4a5b6c7d';

describe('HeartbeatDto servers[]', () => {
  it.each(SERVER_POWER_STATES)('accepts the agent state %s', async (state) => {
    const errors = await validateHeartbeat({ servers: [{ uuid: REAL_UUID_V7, state }] });
    expect(errors).toHaveLength(0);
  });

  it('accepts a uuidv7 — the version this database actually generates', async () => {
    const errors = await validateHeartbeat({ servers: [{ uuid: REAL_UUID_V7, state: 'running' }] });
    expect(errors).toHaveLength(0);
  });

  it('rejects a state outside srv.State', async () => {
    const errors = await validateHeartbeat({ servers: [{ uuid: REAL_UUID_V7, state: 'zombie' }] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-uuid server id', async () => {
    const errors = await validateHeartbeat({ servers: [{ uuid: 'not-a-uuid', state: 'running' }] });
    expect(errors.length).toBeGreaterThan(0);
  });

  /**
   * The compatibility contract every other heartbeat field already has:
   * an agent binary older than this feature sends no `servers` key, and
   * that must validate cleanly — the panel then leaves every row alone
   * rather than inferring anything from the silence.
   */
  it('accepts a heartbeat with no servers key at all (older agent)', async () => {
    const errors = await validateHeartbeat({ agentVersion: 'v0.4.0' });
    expect(errors).toHaveLength(0);
  });

  it('accepts an explicitly empty list', async () => {
    const errors = await validateHeartbeat({ servers: [] });
    expect(errors).toHaveLength(0);
  });
});
