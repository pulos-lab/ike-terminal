import { describe, it, expect } from 'vitest';
import { PRESET_RANGES, clampPresetRange } from '../dashboard-range';

describe('clampPresetRange', () => {
  it('przepuszcza każdy znany preset', () => {
    for (const r of PRESET_RANGES) expect(clampPresetRange(r)).toBe(r);
  });

  it('zakres własny nie jest zapamiętywany — wraca do ALL', () => {
    expect(clampPresetRange('CUSTOM')).toBe('ALL');
  });

  it('śmieci z localStorage sprowadza do ALL', () => {
    for (const junk of ['5Y', '', null, undefined, 42, {}, '1m']) {
      expect(clampPresetRange(junk)).toBe('ALL');
    }
  });
});
