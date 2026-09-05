export type Candle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  complete: boolean;
};

export type SignalPoint = Candle & {
  ema20: number | null;
  ema60: number | null;
  macd: number | null;
  bollMid: number | null;
  sar: number | null;
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
  votes: {
    trend: number;
    macd: number;
    boll: number;
    sar: number;
    ema: number;
  };
  score: number;
};

function ema(values: number[], period: number) {
  const out: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  let value = seed / period;
  out[period - 1] = value;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * alpha + value * (1 - alpha);
    out[i] = value;
  }
  return out;
}

function rollingMean(values: number[], period: number) {
  const out: Array<number | null> = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function adx(candles: Candle[], period = 14) {
  const n = candles.length;
  const plusDI: Array<number | null> = Array(n).fill(null);
  const minusDI: Array<number | null> = Array(n).fill(null);
  const adxValues: Array<number | null> = Array(n).fill(null);
  const tr = Array(n).fill(0);
  const plusDM = Array(n).fill(0);
  const minusDM = Array(n).fill(0);
  const dx: Array<number | null> = Array(n).fill(null);

  for (let i = 1; i < n; i += 1) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
  }
  if (n <= period) return { adx: adxValues, plusDI, minusDI };
  let smoothTR = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothPlus = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothMinus = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  for (let i = period; i < n; i += 1) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + tr[i];
      smoothPlus = smoothPlus - smoothPlus / period + plusDM[i];
      smoothMinus = smoothMinus - smoothMinus / period + minusDM[i];
    }
    plusDI[i] = smoothTR ? (100 * smoothPlus) / smoothTR : 0;
    minusDI[i] = smoothTR ? (100 * smoothMinus) / smoothTR : 0;
    const sum = plusDI[i]! + minusDI[i]!;
    dx[i] = sum ? (100 * Math.abs(plusDI[i]! - minusDI[i]!)) / sum : 0;
  }
  const firstAdxIndex = period * 2 - 1;
  if (n > firstAdxIndex) {
    let value =
      dx
        .slice(period, firstAdxIndex + 1)
        .reduce<number>((a, b) => a + (b ?? 0), 0) / period;
    adxValues[firstAdxIndex] = value;
    for (let i = firstAdxIndex + 1; i < n; i += 1) {
      value = (value * (period - 1) + (dx[i] ?? 0)) / period;
      adxValues[i] = value;
    }
  }
  return { adx: adxValues, plusDI, minusDI };
}

function parabolicSar(candles: Candle[]) {
  const out: Array<number | null> = Array(candles.length).fill(null);
  if (candles.length < 2) return out;
  let rising = candles[1].close >= candles[0].close;
  let sar = rising ? candles[0].low : candles[0].high;
  let ep = rising
    ? Math.max(candles[0].high, candles[1].high)
    : Math.min(candles[0].low, candles[1].low);
  let af = 0.02;
  out[1] = sar;
  for (let i = 2; i < candles.length; i += 1) {
    sar += af * (ep - sar);
    if (rising) {
      sar = Math.min(sar, candles[i - 1].low, candles[i - 2].low);
      if (candles[i].low < sar) {
        rising = false;
        sar = ep;
        ep = candles[i].low;
        af = 0.02;
      } else if (candles[i].high > ep) {
        ep = candles[i].high;
        af = Math.min(0.2, af + 0.02);
      }
    } else {
      sar = Math.max(sar, candles[i - 1].high, candles[i - 2].high);
      if (candles[i].high > sar) {
        rising = true;
        sar = ep;
        ep = candles[i].high;
        af = 0.02;
      } else if (candles[i].low < ep) {
        ep = candles[i].low;
        af = Math.min(0.2, af + 0.02);
      }
    }
    out[i] = sar;
  }
  return out;
}

const vote = (positive: boolean, negative: boolean) =>
  positive ? 1 : negative ? -1 : 0;

export function calculateSignals(candles: Candle[]): SignalPoint[] {
  const closes = candles.map((c) => c.close);
  const ema12 = ema(closes, 12);
  const ema20 = ema(closes, 20);
  const ema26 = ema(closes, 26);
  const ema60 = ema(closes, 60);
  const bollMid = rollingMean(closes, 20);
  const sar = parabolicSar(candles);
  const directional = adx(candles);

  return candles.map((candle, i) => {
    const macd =
      ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : null;
    const trend =
      directional.adx[i] != null && directional.adx[i]! > 25
        ? vote(
            directional.plusDI[i]! > directional.minusDI[i]!,
            directional.minusDI[i]! > directional.plusDI[i]!,
          )
        : 0;
    const votes = {
      trend,
      macd: macd == null ? 0 : vote(macd > 0, macd < 0),
      boll:
        bollMid[i] == null
          ? 0
          : vote(candle.close > bollMid[i]!, candle.close < bollMid[i]!),
      sar:
        sar[i] == null
          ? 0
          : vote(candle.close > sar[i]!, candle.close < sar[i]!),
      ema:
        ema20[i] == null || ema60[i] == null
          ? 0
          : vote(ema20[i]! > ema60[i]!, ema20[i]! < ema60[i]!),
    };
    return {
      ...candle,
      ema20: ema20[i],
      ema60: ema60[i],
      macd,
      bollMid: bollMid[i],
      sar: sar[i],
      adx: directional.adx[i],
      plusDI: directional.plusDI[i],
      minusDI: directional.minusDI[i],
      votes,
      score: Object.values(votes).reduce((sum, value) => sum + value, 0),
    };
  });
}

export function parseOkxCandles(rows: string[][]): Candle[] {
  return rows
    .map((r) => ({
      ts: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      complete: r[8] === '1',
    }))
    .sort((a, b) => a.ts - b.ts);
}

export const getSignalLabel = (
  point: SignalPoint,
  side: 'flat' | 'long' | 'short',
) => {
  if (side === 'long' && point.score <= 0)
    return { action: '平多', tone: 'exit' as const, reason: '总分回落至 ≤ 0' };
  if (side === 'short' && point.score >= -4)
    return { action: '平空', tone: 'exit' as const, reason: '总分回升至 ≥ -4' };
  if (side === 'flat' && point.score >= 4 && (point.adx ?? 0) > 10)
    return {
      action: '开多',
      tone: 'long' as const,
      reason: '总分 ≥ +4 且 ADX > 10',
    };
  if (side === 'flat' && point.score <= -3 && (point.adx ?? 0) > 25)
    return {
      action: '开空',
      tone: 'short' as const,
      reason: '总分 ≤ -3 且 ADX > 25',
    };
  return {
    action: side === 'flat' ? '观望' : '持有',
    tone: 'neutral' as const,
    reason: side === 'flat' ? '未触发入场阈值' : '未触发离场阈值',
  };
};
