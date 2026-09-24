import { describe, it, expect } from 'vitest';
import { isCatastrophicRegex } from 'shared';

describe('isCatastrophicRegex — ochrona przed ReDoS w regexach profili', () => {
  it.each(['(a+)+$', '(a*)*', '(\\w*x)*', '(a|aa)+', '(.*a){2,}', '((ab)+)+', '(?:\\s*\\w+)+'])(
    'odrzuca %s',
    (p) => {
      expect(isCatastrophicRegex(p)).toBe(true);
    },
  );

  it.each([
    // Wzorce z wbudowanych profili — nie mogą dać fałszywego alarmu.
    'BUY ([\\d.]+)(?:/[\\d.]+)? @ ([\\d.]+)',
    'Wymiana waluty (\\w+/\\w+)',
    'Wymiana waluty \\w+/\\w+ ([\\d.]+)',
    'Wypłata kuponu\\s+(\\S+)',
    'dywidendy(?:\\s+(?:netto|brutto))?\\s+(\\w+)',
    '^(\\d{2})-(\\d{2})-(\\d{4})$',
    '[(+)]+',
    '\\(a+\\)+',
    '(ab){3}',
    '(a|b)',
    '(?:\\d+,)?\\d+',
  ])('przepuszcza %s', (p) => {
    expect(isCatastrophicRegex(p)).toBe(false);
  });
});
