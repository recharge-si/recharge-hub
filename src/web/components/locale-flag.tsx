import {
  AE,
  AF,
  AL,
  AM,
  AR,
  AT,
  AU,
  AZ,
  BA,
  BD,
  BE,
  BG,
  BI,
  BR,
  BT,
  BY,
  CA,
  CD,
  CF,
  CH,
  CL,
  CN,
  CO,
  CZ,
  DE,
  DK,
  EE,
  EG,
  ES,
  ET,
  FI,
  FO,
  FR,
  GB,
  GE,
  GH,
  GL,
  GR,
  HK,
  HR,
  HU,
  ID,
  IE,
  IL,
  IM,
  IN,
  IQ,
  IR,
  IS,
  IT,
  JP,
  KE,
  KG,
  KH,
  KR,
  KZ,
  LA,
  LI,
  LK,
  LT,
  LU,
  LV,
  MA,
  MG,
  MK,
  ML,
  MM,
  MN,
  MT,
  MX,
  MY,
  NG,
  NL,
  NO,
  NP,
  NZ,
  PE,
  PH,
  PK,
  PL,
  PT,
  RO,
  RS,
  RU,
  RW,
  SA,
  SE,
  SG,
  SI,
  SK,
  SN,
  SO,
  TH,
  TJ,
  TM,
  TO,
  TR,
  TW,
  TZ,
  UA,
  UG,
  US,
  UZ,
  VE,
  VN,
  ZA,
  ZW,
} from "country-flag-icons/react/3x2";

/**
 * The flag that stands beside a language (docs/translations.md
 * § Languages).
 *
 * Flags are `country-flag-icons` SVGs compiled into the bundle: no request
 * per flag, nothing to load, nothing to shift when it arrives. The set is
 * every region CLDR's likely-subtags rule reaches from a locale Shopify can
 * enable, plus the regional variants a store is likely to add — about
 * 60 KB of SVG, where the whole set would be fifteen times that for
 * emblems no store's language points at. A region outside the set, or a
 * language with no region at all, gets the globe, which is the honest
 * answer rather than a wrong flag.
 *
 * The flag is decoration beside a name that is always written out, so it is
 * hidden from assistive technology; the region's name is available as a
 * title for a pointer to hover.
 */
type Flag = typeof DE;

const FLAGS: Record<string, Flag> = {
  AE,
  AF,
  AL,
  AM,
  AR,
  AT,
  AU,
  AZ,
  BA,
  BD,
  BE,
  BG,
  BI,
  BR,
  BT,
  BY,
  CA,
  CD,
  CF,
  CH,
  CL,
  CN,
  CO,
  CZ,
  DE,
  DK,
  EE,
  EG,
  ES,
  ET,
  FI,
  FO,
  FR,
  GB,
  GE,
  GH,
  GL,
  GR,
  HK,
  HR,
  HU,
  ID,
  IE,
  IL,
  IM,
  IN,
  IQ,
  IR,
  IS,
  IT,
  JP,
  KE,
  KG,
  KH,
  KR,
  KZ,
  LA,
  LI,
  LK,
  LT,
  LU,
  LV,
  MA,
  MG,
  MK,
  ML,
  MM,
  MN,
  MT,
  MX,
  MY,
  NG,
  NL,
  NO,
  NP,
  NZ,
  PE,
  PH,
  PK,
  PL,
  PT,
  RO,
  RS,
  RU,
  RW,
  SA,
  SE,
  SG,
  SI,
  SK,
  SN,
  SO,
  TH,
  TJ,
  TM,
  TO,
  TR,
  TW,
  TZ,
  UA,
  UG,
  US,
  UZ,
  VE,
  VN,
  ZA,
  ZW,
};

/** Whether a flag is bundled for the region. */
export function hasFlag(regionCode: string | null | undefined): boolean {
  return regionCode !== null && regionCode !== undefined && regionCode in FLAGS;
}

const SIZES = {
  small: { inlineSize: "18px", blockSize: "12px" },
  base: { inlineSize: "24px", blockSize: "16px" },
  large: { inlineSize: "36px", blockSize: "24px" },
} as const;

export function LocaleFlag({
  regionCode,
  regionName,
  size = "base",
}: {
  regionCode: string | null | undefined;
  /** What the pointer's tooltip says: "Germany". */
  regionName?: string | null;
  size?: keyof typeof SIZES;
}) {
  const Flag = regionCode ? FLAGS[regionCode] : undefined;
  const box = SIZES[size];
  return (
    <s-box
      inlineSize={box.inlineSize}
      blockSize={box.blockSize}
      minInlineSize={box.inlineSize}
      borderRadius="small"
      border="base"
      borderColor="subdued"
      overflow="hidden"
      background="subdued"
    >
      {Flag ? (
        <Flag
          aria-hidden="true"
          focusable="false"
          preserveAspectRatio="xMidYMid slice"
          style={{ display: "block", width: "100%", height: "100%" }}
          {...(regionName ? { title: regionName } : {})}
        />
      ) : (
        <s-stack
          direction="inline"
          alignItems="center"
          justifyContent="center"
          blockSize="100%"
        >
          <s-icon type="globe" size="small" color="subdued" />
        </s-stack>
      )}
    </s-box>
  );
}
