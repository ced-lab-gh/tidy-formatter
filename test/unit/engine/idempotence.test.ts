// Idempotence tests (SPEC SAFE-03): format(format(x)) === format(x) on the
// whole corpus. Covers the "code creeps right on every save" drift cluster.
// We format through the real dispatcher (so each language uses its real engine)
// and assert the second pass is a byte-for-byte no-op.
import assert from 'node:assert/strict';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { idempotenceFixtures } from '../../fixtures/idempotenceFixtures';
import { resolved } from '../../helpers/options';

describe('engine — idempotence (SPEC SAFE-03, drift protection)', () => {
  for (const f of idempotenceFixtures) {
    it(`${f.id}: format(format(x)) == format(x) for ${f.lang} [${f.ref}]`, async () => {
      const opts = resolved();
      const first = await dispatchFormat({ languageId: f.lang, code: f.input, options: opts });
      const second = await dispatchFormat({ languageId: f.lang, code: first, options: opts });
      assert.equal(second, first, `second pass drifted for ${f.id}`);
    });
  }
});
