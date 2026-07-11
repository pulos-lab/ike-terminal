import { KNOWN_XTB_TYPES } from './xtb-transactions.js';

/**
 * Katalog kanonicznych typów operacji per broker — jedyne dozwolone targety
 * aliasów parser_type (walidacja approve w panelu admina). Zły alias w DB
 * nie może wpuścić wiersza w nieistniejącą gałąź dispatchu parsera.
 *
 * Faza 1: tylko XTB (jedyny parser konsultujący aliasy). Kolejne brokerzy
 * dochodzą tu razem z konsumpcją ParserContext w ich parserach.
 */
export const KNOWN_PARSER_TYPES: Record<string, ReadonlySet<string>> = {
  xtb: KNOWN_XTB_TYPES,
};

/** Brokerzy, dla których aliasy parser_type są obsługiwane. */
export function knownTypesForBroker(broker: string): ReadonlySet<string> | null {
  return KNOWN_PARSER_TYPES[broker.trim().toLowerCase()] ?? null;
}
