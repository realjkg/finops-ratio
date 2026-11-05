// ISO 4217 alphabetic currency codes accepted on money records: the active national currencies of ISO 4217 List One
// (maintenance agency: SIX Group) as of 2026-01, transcribed for this contract, plus codes withdrawn since 2023 that
// still appear on historical invoices (ANG, BGN, HRK, SLL, ZWL). Fund codes, precious metals and testing codes are
// excluded. Re-verify against the published list before each contract major; adding a code is a contract change.
export const ISO_4217_SOURCE = 'ISO 4217 List One (SIX Group), active codes as of 2026-01, plus ANG BGN HRK SLL ZWL';
export const ISO_4217: ReadonlySet<string> = new Set(
  ('AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP ' +
    'CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF ' +
    'IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK ' +
    'MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR ' +
    'SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS ' +
    'VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG ZWL').split(' '),
);
