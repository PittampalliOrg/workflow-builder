/**
 * Minimal Kubernetes resource quantity parser.
 *
 * Quantities can come in three forms:
 *   - decimal SI: 100m, 1, 2.5
 *   - decimal BIG: 1k, 5M, 10G
 *   - binary BIG: 100Ki, 10Gi, 1Ti
 *
 * Returns the value in **base units** (cores for CPU, bytes for memory,
 * count for pods). The caller decides how to format.
 *
 * We only need this on the client for percentage math — server projections
 * stay as strings. If parsing fails, returns 0 rather than throwing so a
 * single bad value doesn't blow up a card.
 */

const DECIMAL_SUFFIXES: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

const BINARY_SUFFIXES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

export function parseQuantity(input: string | undefined | null): number {
  if (input === undefined || input === null) return 0;
  const value = String(input).trim();
  if (!value) return 0;

  // Binary suffix takes precedence — must be matched before decimal because
  // "Mi" overlaps "M".
  for (const [suffix, factor] of Object.entries(BINARY_SUFFIXES)) {
    if (value.endsWith(suffix)) {
      const n = Number(value.slice(0, -suffix.length));
      if (Number.isFinite(n)) return n * factor;
    }
  }

  // Decimal suffix (single character at the tail).
  const tail = value.slice(-1);
  const decimal = DECIMAL_SUFFIXES[tail];
  if (decimal !== undefined && tail !== "") {
    const n = Number(value.slice(0, -1));
    if (Number.isFinite(n)) return n * decimal;
  }

  const plain = Number(value);
  return Number.isFinite(plain) ? plain : 0;
}

/** Compute used / reserved / nominal as a percentage triple, capped to 100. */
export function quantityRatios(
  used: string | undefined,
  reserved: string | undefined,
  nominal: string | undefined,
): {
  used: number;
  reserved: number;
  free: number;
  over: number;
  nominal: number;
  usedAbs: number;
  reservedAbs: number;
} {
  const usedAbs = parseQuantity(used);
  const reservedTotalAbs = parseQuantity(reserved);
  const reservedAbs = Math.max(0, reservedTotalAbs - usedAbs);
  const consumedAbs = Math.max(usedAbs, reservedTotalAbs);
  const nominalAbs = parseQuantity(nominal);

  if (nominalAbs <= 0) {
    // Workloads can run on a CQ with nominalQuota=0 if borrowing is
    // allowed; show usage absolute and treat ratio as 100% if any used.
    const total = consumedAbs;
    return {
      used: total > 0 ? 100 : 0,
      reserved: 0,
      free: 0,
      over: 0,
      nominal: 0,
      usedAbs,
      reservedAbs,
    };
  }

  const usedPct = Math.min(100, (usedAbs / nominalAbs) * 100);
  const reservedPct = Math.max(
    0,
    Math.min(100 - usedPct, (reservedAbs / nominalAbs) * 100),
  );
  const overPct =
    consumedAbs > nominalAbs
      ? Math.min(100, ((consumedAbs - nominalAbs) / nominalAbs) * 100)
      : 0;
  const free = Math.max(0, 100 - usedPct - reservedPct);
  return {
    used: usedPct,
    reserved: reservedPct,
    free,
    over: overPct,
    nominal: nominalAbs,
    usedAbs,
    reservedAbs,
  };
}

/** Format an absolute base-unit value for the UI. CPU shows cores, memory shows bytes-by-prefix. */
export function formatQuantityForResource(
  resource: string,
  abs: number,
): string {
  if (abs === 0) return "0";
  if (resource === "cpu") {
    if (abs < 1) return `${(abs * 1000).toFixed(0)}m`;
    return abs % 1 === 0 ? abs.toFixed(0) : abs.toFixed(2);
  }
  if (resource === "memory" || resource.endsWith("-storage")) {
    const units = ["", "Ki", "Mi", "Gi", "Ti"];
    let v = abs;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${units[i]}`;
  }
  if (resource === "pods" || resource === "gpu" || resource.endsWith("count")) {
    return abs.toFixed(0);
  }
  // Fallback — generic SI prefix
  const units = ["", "k", "M", "G", "T"];
  let v = abs;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${units[i]}`;
}
