import type { ClassificationRule, Condition, Matcher, RowClass } from 'shared';
import { parseNumber } from '../utils.js';
import { ColumnResolver, compileRegex } from './value-parsers.js';

/**
 * Klasyfikacja wierszy CSV wg reguł profilu — ordered, first-match-wins.
 * Matchery w obrębie reguły łączone są AND-em.
 */

export interface ClassifiedRow {
  /** id dopasowanej reguły z profilu; null = defaultClass. */
  ruleId: string | null;
  emit: RowClass;
  skipReason?: ClassificationRule['skipReason'];
}

function evalMatcher(m: Matcher, row: string[], resolver: ColumnResolver): boolean {
  const cell = resolver.cell(row, m.col) ?? '';
  const subject = m.caseInsensitive ? cell.toLowerCase() : cell;
  const values = (m.values ?? []).map((v) => (m.caseInsensitive ? v.toLowerCase() : v));

  switch (m.op) {
    case 'equals':
    case 'oneOf':
      return values.includes(subject);
    case 'contains':
      return values.some((v) => subject.includes(v));
    case 'startsWith':
      return values.some((v) => subject.startsWith(v));
    case 'regex':
      return compileRegex(m.pattern ?? '', m.caseInsensitive ? 'i' : '').test(cell);
    case 'signPositive':
      return parseNumber(cell) > 0;
    case 'signNegative':
      return parseNumber(cell) < 0;
    case 'zeroNumber':
      return parseNumber(cell) === 0;
    case 'nonzeroNumber':
      return parseNumber(cell) !== 0;
    case 'empty':
      return cell === '';
    case 'notEmpty':
      return cell !== '';
  }
}

export function evalCondition(
  condition: Condition,
  row: string[],
  resolver: ColumnResolver,
): boolean {
  return condition.every((m) => evalMatcher(m, row, resolver));
}

export function classifyRow(
  rules: ClassificationRule[],
  defaultClass: RowClass,
  row: string[],
  resolver: ColumnResolver,
): ClassifiedRow {
  for (const rule of rules) {
    if (evalCondition(rule.when, row, resolver)) {
      return { ruleId: rule.id, emit: rule.emit, skipReason: rule.skipReason };
    }
  }
  return { ruleId: null, emit: defaultClass };
}
