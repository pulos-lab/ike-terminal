import type { TickerMapEntry } from './types.js';

export const TICKER_MAP: TickerMapEntry[] = [
  // === Polish GPW ===
  { isin: 'PLCRPJR00019', ticker: 'CRJ.WA', name: 'CreepyJar', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Gaming' },
  { isin: 'PLPLAYW00015', ticker: 'PLW.WA', name: 'PlayWay', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Gaming' },
  { isin: 'PLLPP0000011', ticker: 'LPP.WA', name: 'LPP', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Handel' },
  { isin: 'PLOPTTC00011', ticker: 'CDR.WA', name: 'CD Projekt', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Gaming' },
  { isin: 'PLXTRDM00011', ticker: 'XTB.WA', name: 'XTB', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Finanse' },
  { isin: 'PLVRCM000016', ticker: 'VRC.WA', name: 'Vercom', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },
  { isin: 'PLUNBEP00015', ticker: 'UNI.WA', name: 'Unibep', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Budownictwo' },
  { isin: 'PLGMSOP00019', ticker: 'GOP.WA', name: 'GameOps', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Gaming' },
  { isin: 'PLMOBRK00013', ticker: 'MBR.WA', name: 'Mo-BRUK', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Przemysł' },
  { isin: 'PLANSWR00019', ticker: 'ANS.WA', name: 'Answear', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Handel' },
  { isin: 'PLKRK0000010', ticker: 'KRU.WA', name: 'Kruk', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Finanse' },
  { isin: 'PLLVTSF00010', ticker: 'TXT.WA', name: 'Text (LiveChat)', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },
  { isin: 'PLSNKTK00019', ticker: 'SNT.WA', name: 'Synektik', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Ochrona zdrowia' },
  { isin: 'PLBNFTS00018', ticker: 'BFT.WA', name: 'Benefit Systems', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Usługi' },
  { isin: 'PLA340200015', ticker: 'BIG.WA', name: 'BigCheese Studio', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Gaming' },
  { isin: 'PLR220000018', ticker: 'CYB.WA', name: 'CyberFolks', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },
  { isin: 'PLBCT0000020', ticker: 'BCT.WA', name: 'Bact', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Ochrona zdrowia' },
  { isin: 'PLKETY000011', ticker: 'KTY.WA', name: 'Kety', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Przemysł' },
  { isin: 'PLCNTSL00014', ticker: 'COG.WA', name: 'Cognor', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Przemysł' },
  { isin: 'PLATMSI00016', ticker: 'ATE.WA', name: 'Atende', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },
  { isin: 'PLPILAB00012', ticker: 'DAT.WA', name: 'DataWalk', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },
  { isin: 'PLGPW0000017', ticker: 'GPW.WA', name: 'GPW', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Finanse' },
  { isin: 'PLSOFTB00016', ticker: 'ACP.WA', name: 'Asseco Poland', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },
  { isin: 'PLTOYA000011', ticker: 'TOA.WA', name: 'Toya', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Przemysł' },
  { isin: 'PLPRTSD00022', ticker: 'PRD.WA', name: 'President', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Handel' },
  { isin: 'PLPZU0000011', ticker: 'PZU.WA', name: 'PZU', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Finanse' },
  { isin: 'PLTORPL00016', ticker: 'TOR.WA', name: 'Torpol', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Budownictwo' },
  { isin: 'CY1000031710', ticker: 'ASB.WA', name: 'Asbis', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Handel' },
  { isin: 'NL0015000AU7', ticker: 'PCO.WA', name: 'Pepco', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Handel' },
  { isin: 'PLCFRPT00013', ticker: 'CPS.WA', name: 'Cyfrowy Polsat', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Media' },
  { isin: 'PLAGORA00067', ticker: 'AGO.WA', name: 'Agora', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Media' },
  { isin: 'AU0000198939', ticker: 'GRX.WA', name: 'GreenX Metals', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Surowce' },

  // === Polish NewConnect ===
  { isin: 'PLMNRLM00010', ticker: 'MND.WA', name: 'Mineral', exchange: 'NC', currency: 'PLN', priceSource: 'stooq', sector: 'Surowce' },
  { isin: 'PLPNTPK00014', ticker: 'PNT.WA', name: 'PointPack', exchange: 'NC', currency: 'PLN', priceSource: 'stooq', sector: 'Usługi' },
  { isin: 'PLLSRMD00018', ticker: 'ONE.WA', name: 'OneMore', exchange: 'NC', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },
  { isin: 'PLLGIMI00029', ticker: 'LGM.WA', name: 'Legimi', exchange: 'NC', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },
  { isin: 'PLKBT0000015', ticker: 'KBT.WA', name: 'Kubota', exchange: 'NC', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },
  { isin: 'PLWDPCK00017', ticker: 'WOD.WA', name: 'Woodpecker', exchange: 'NC', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },

  // === IKZE Polish GPW ===
  { isin: 'PL11BTS00015', ticker: '11B.WA', name: '11 Bit Studios', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Gaming' },
  { isin: 'PLBLOBR00014', ticker: 'BLO.WA', name: 'Bloober Team', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Gaming' },
  { isin: 'PLINTMS00019', ticker: 'IMS.WA', name: 'IMS', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Media' },
  { isin: 'PLSTLPD00017', ticker: 'STP.WA', name: 'Stalprodukt', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Przemysł' },
  { isin: 'PLVOTUM00016', ticker: 'VOT.WA', name: 'Votum', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Usługi' },
  { isin: 'PLONCTH00011', ticker: 'MOC.WA', name: 'Molecure', exchange: 'GPW', currency: 'PLN', priceSource: 'stooq', sector: 'Ochrona zdrowia' },

  // === IKZE Polish NewConnect ===
  { isin: 'PL4MASS00011', ticker: '4MS.WA', name: '4Mass', exchange: 'NC', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },
  { isin: 'PLRBGRL00016', ticker: 'ROB.WA', name: 'Robs Group', exchange: 'NC', currency: 'PLN', priceSource: 'stooq', sector: 'Usługi' },
  { isin: 'PLSFTMN00015', ticker: 'SWM.WA', name: 'Software Mansion', exchange: 'NC', currency: 'PLN', priceSource: 'stooq', sector: 'Technologia' },

  // === EU Stocks ===
  { isin: 'DE000A0WMPJ6', ticker: 'AIXA.DE', name: 'Aixtron', exchange: 'XETRA', currency: 'EUR', priceSource: 'yahoo', sector: 'Technologia' },

  // === US Stocks ===
  { isin: 'US01609W1027', ticker: 'BABA', name: 'Alibaba', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Technologia' },
  { isin: 'US0367521038', ticker: 'ELV', name: 'Elevance Health', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Ochrona zdrowia' },
  { isin: 'US09857L1089', ticker: 'BKNG', name: 'Booking Holdings', exchange: 'NASDAQ', currency: 'USD', priceSource: 'yahoo', sector: 'Usługi' },
  { isin: 'US2546871060', ticker: 'DIS', name: 'Walt Disney', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Media' },
  { isin: 'US3364331070', ticker: 'FSLR', name: 'First Solar', exchange: 'NASDAQ', currency: 'USD', priceSource: 'yahoo', sector: 'Energia' },
  { isin: 'US5500211090', ticker: 'LULU', name: 'Lululemon', exchange: 'NASDAQ', currency: 'USD', priceSource: 'yahoo', sector: 'Handel' },
  { isin: 'US8085131055', ticker: 'SCHW', name: 'Charles Schwab', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Finanse' },
  { isin: 'US83444M1018', ticker: 'SOLV', name: 'Solventum', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Ochrona zdrowia' },
  { isin: 'US88579Y1010', ticker: 'MMM', name: '3M', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Przemysł' },
  { isin: 'US90353T1007', ticker: 'UBER', name: 'Uber Technologies', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Technologia' },
  { isin: 'US91324P1021', ticker: 'UNH', name: 'UnitedHealth Group', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Ochrona zdrowia' },
  { isin: 'US64110L1061', ticker: 'NFLX', name: 'Netflix', exchange: 'NASDAQ', currency: 'USD', priceSource: 'yahoo', sector: 'Technologia' },
  { isin: 'US78409V1044', ticker: 'SPGI', name: 'S&P Global', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Finanse' },
  { isin: 'US75734B1008', ticker: 'RDDT', name: 'Reddit', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Technologia' },
  { isin: 'US81762P1021', ticker: 'NOW', name: 'ServiceNow', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Technologia' },
  { isin: 'US2270461096', ticker: 'CROX', name: 'Crocs', exchange: 'NASDAQ', currency: 'USD', priceSource: 'yahoo', sector: 'Handel' },
  { isin: 'LU1778762911', ticker: 'SPOT', name: 'Spotify', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Technologia' },
  { isin: 'US57636Q1040', ticker: 'MA', name: 'Mastercard', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Finanse' },
  { isin: 'US55354G1004', ticker: 'MSCI', name: 'MSCI', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Finanse' },
  { isin: 'US0079031078', ticker: 'AMD', name: 'AMD', exchange: 'NASDAQ', currency: 'USD', priceSource: 'yahoo', sector: 'Technologia' },
  { isin: 'US6701002056', ticker: 'NVO', name: 'Novo Nordisk ADR', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Ochrona zdrowia' },
  { isin: 'NL0010696654', ticker: 'QURE', name: 'uniQure', exchange: 'NASDAQ', currency: 'USD', priceSource: 'yahoo', sector: 'Ochrona zdrowia' },
  { isin: 'US8740541094', ticker: 'TTWO', name: 'Take-Two Interactive', exchange: 'NASDAQ', currency: 'USD', priceSource: 'yahoo', sector: 'Gaming' },
  { isin: 'US2435371073', ticker: 'DECK', name: 'Deckers Outdoor', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Handel' },
  { isin: 'US15118V2079', ticker: 'CELH', name: 'Celsius Holdings', exchange: 'NASDAQ', currency: 'USD', priceSource: 'yahoo', sector: 'Handel' },
  { isin: 'US52567D1072', ticker: 'LMND', name: 'Lemonade', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Finanse' },
  { isin: 'US11135F1012', ticker: 'AVGO', name: 'Broadcom', exchange: 'NASDAQ', currency: 'USD', priceSource: 'yahoo', sector: 'Technologia' },
  { isin: 'US3168411052', ticker: 'FGMA', name: 'Figma', exchange: 'NYSE', currency: 'USD', priceSource: 'yahoo', sector: 'Technologia' },

  // === Canadian ===
  { isin: 'CA21037X1006', ticker: 'CSU.TO', name: 'Constellation Software', exchange: 'TSX', currency: 'CAD', priceSource: 'yahoo', sector: 'Technologia' },
];

export const ISIN_TO_TICKER = new Map(TICKER_MAP.map(e => [e.isin, e]));
export const TICKER_TO_ENTRY = new Map(TICKER_MAP.map(e => [e.ticker, e]));
