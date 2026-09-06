'use client';
/* oxlint-disable react/react-compiler -- Initial localStorage hydration and first market refresh intentionally synchronize external state. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CircleDollarSign,
  Clock3,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  WalletCards,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  calculateSignals,
  getSignalLabel,
  parseOkxCandles,
  SignalPoint,
} from '@/lib/strategy';

const STARTING_BALANCE = 10_000;
const SPOT_TAKER_FEE = 0.001;
const PERP_TAKER_FEE = 0.0005;
const STORAGE_KEY = 'eth-score-paper-v3';
const CARRY_ENTRY_TS = Date.UTC(2026, 7, 17);
const CARRY_ENTRY_PRICE = 1843.69;

type Position = {
  side: 'long' | 'short';
  entry: number;
  quantity: number;
  margin: number;
  entryFee: number;
  openedAt: number;
};
type Trade = {
  id: string;
  side: 'long' | 'short';
  entry: number;
  exit: number;
  openedAt: number;
  closedAt: number;
  fee: number;
  pnl: number;
  returnPct: number;
};
type Account = {
  startedAt: number | null;
  balance: number;
  position: Position | null;
  trades: Trade[];
  lastProcessedTs: number | null;
};
type OkxResponse<T> = { code: string; msg?: string; data: T };

const entryNotional = STARTING_BALANCE / (1 + SPOT_TAKER_FEE);
const cleanAccount: Account = {
  startedAt: CARRY_ENTRY_TS,
  balance: 0,
  position: {
    side: 'long',
    entry: CARRY_ENTRY_PRICE,
    quantity: entryNotional / CARRY_ENTRY_PRICE,
    margin: STARTING_BALANCE,
    entryFee: entryNotional * SPOT_TAKER_FEE,
    openedAt: CARRY_ENTRY_TS,
  },
  trades: [],
  lastProcessedTs: CARRY_ENTRY_TS,
};
const money = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const priceFmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dateFmt = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  timeZone: 'UTC',
});
const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function loadAccount(): Account {
  if (typeof window === 'undefined') return cleanAccount;
  try {
    return {
      ...cleanAccount,
      ...JSON.parse(localStorage.getItem(STORAGE_KEY) || ''),
    };
  } catch {
    return cleanAccount;
  }
}

function markEquity(account: Account, price: number) {
  const p = account.position;
  if (!p) return account.balance;
  const pnl =
    p.side === 'long'
      ? p.quantity * price
      : p.margin - p.entryFee + p.quantity * (p.entry - price);
  return p.side === 'long' ? p.quantity * price : pnl;
}

function executePoint(account: Account, point: SignalPoint): Account {
  const next = { ...account, trades: [...account.trades] };
  const signal = getSignalLabel(point, account.position?.side ?? 'flat');
  if (account.position?.side === 'long' && signal.action === '平多') {
    const gross = account.position.quantity * point.close;
    const exitFee = gross * SPOT_TAKER_FEE;
    const final = gross - exitFee;
    const totalFee = account.position.entryFee + exitFee;
    const pnl = final - account.position.margin;
    next.balance = final;
    next.trades.unshift({
      id: `L-${point.ts}`,
      side: 'long',
      entry: account.position.entry,
      exit: point.close,
      openedAt: account.position.openedAt,
      closedAt: point.ts,
      fee: totalFee,
      pnl,
      returnPct: (pnl / account.position.margin) * 100,
    });
    next.position = null;
  } else if (account.position?.side === 'short' && signal.action === '平空') {
    const exitFee = account.position.quantity * point.close * PERP_TAKER_FEE;
    const pnl =
      account.position.quantity * (account.position.entry - point.close) -
      account.position.entryFee -
      exitFee;
    next.balance = account.position.margin + pnl;
    next.trades.unshift({
      id: `S-${point.ts}`,
      side: 'short',
      entry: account.position.entry,
      exit: point.close,
      openedAt: account.position.openedAt,
      closedAt: point.ts,
      fee: account.position.entryFee + exitFee,
      pnl,
      returnPct: (pnl / account.position.margin) * 100,
    });
    next.position = null;
  } else if (!account.position && signal.action === '开多') {
    const notional = account.balance / (1 + SPOT_TAKER_FEE);
    next.position = {
      side: 'long',
      entry: point.close,
      quantity: notional / point.close,
      margin: account.balance,
      entryFee: notional * SPOT_TAKER_FEE,
      openedAt: point.ts,
    };
    next.balance = 0;
  } else if (!account.position && signal.action === '开空') {
    next.position = {
      side: 'short',
      entry: point.close,
      quantity: account.balance / point.close,
      margin: account.balance,
      entryFee: account.balance * PERP_TAKER_FEE,
      openedAt: point.ts,
    };
  }
  next.lastProcessedTs = point.ts;
  return next;
}

export default function Home() {
  const [signals, setSignals] = useState<SignalPoint[]>([]);
  const [ticker, setTicker] = useState<{
    last: number;
    open24h: number;
  } | null>(null);
  const [account, setAccount] = useState<Account>(cleanAccount);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const accountRef = useRef(account);
  const latest = [...signals].reverse().find((point) => point.complete) ?? null;

  useEffect(() => {
    const saved = loadAccount();
    // oxlint-disable-next-line react-compiler/effect-set-state
    setAccount(saved);
    accountRef.current = saved;
  }, []);
  useEffect(() => {
    accountRef.current = account;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
  }, [account]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [candlesResponse, tickerResponse] = await Promise.all([
        fetch(
          'https://www.okx.com/api/v5/market/candles?instId=ETH-USDT&bar=1Dutc&limit=300',
          { cache: 'no-store' },
        ),
        fetch('https://www.okx.com/api/v5/market/ticker?instId=ETH-USDT', {
          cache: 'no-store',
        }),
      ]);
      if (!candlesResponse.ok || !tickerResponse.ok)
        throw new Error('行情接口暂时不可用');
      const candleJson = (await candlesResponse.json()) as OkxResponse<
        string[][]
      >;
      const tickerJson = (await tickerResponse.json()) as OkxResponse<
        Array<{ last: string; open24h: string }>
      >;
      if (candleJson.code !== '0' || tickerJson.code !== '0')
        throw new Error(candleJson.msg || tickerJson.msg || '行情返回异常');
      const allCandles = parseOkxCandles(candleJson.data);
      const calculated = calculateSignals(allCandles);
      setSignals(calculated);
      setTicker({
        last: Number(tickerJson.data[0].last),
        open24h: Number(tickerJson.data[0].open24h),
      });
      setUpdatedAt(Date.now());
      const complete = calculated.filter(
        (p) => p.complete && p.ema60 != null && p.adx != null,
      );
      let next = accountRef.current;
      if (next.startedAt) {
        const pending = complete.filter(
          (p) => !next.lastProcessedTs || p.ts > next.lastProcessedTs,
        );
        pending.forEach((point) => {
          next = executePoint(next, point);
        });
        if (pending.length) setAccount(next);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法读取 OKX 行情');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react-compiler/effect-set-state
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const resetAccount = () =>
    setAccount({
      ...cleanAccount,
      position: cleanAccount.position ? { ...cleanAccount.position } : null,
      trades: [],
    });

  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: unknown,
            options?: { signal?: AbortSignal },
          ) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = async () => {
      await context.registerTool(
        {
          name: 'read_eth_monitor',
          title: '读取 ETH 模拟盘',
          description: '读取当前 ETH 评分、交易信号、账户权益与持仓。',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: false },
          execute: () => ({
            score: latest?.score ?? null,
            adx: latest?.adx ?? null,
            signal: latest
              ? getSignalLabel(
                  latest,
                  accountRef.current.position?.side ?? 'flat',
                ).action
              : null,
            equity: markEquity(
              accountRef.current,
              ticker?.last ?? latest?.close ?? 0,
            ),
            position: accountRef.current.position?.side ?? 'flat',
          }),
        },
        { signal: lifecycle.signal },
      );
    };
    void register().catch(() => undefined);
    return () => lifecycle.abort();
  }, [latest, ticker]);

  const currentPrice = ticker?.last ?? latest?.close ?? 0;
  const equity = currentPrice
    ? markEquity(account, currentPrice)
    : account.balance;
  const change24h =
    ticker && ticker.open24h ? (ticker.last / ticker.open24h - 1) * 100 : 0;
  const positionSide = account.position?.side ?? 'flat';
  const decision = latest
    ? getSignalLabel(latest, positionSide)
    : { action: '等待行情', tone: 'neutral' as const, reason: '正在计算指标' };
  const unrealized = equity - (account.position?.margin ?? equity);
  const wins = account.trades.filter((trade) => trade.pnl > 0).length;
  const winRate = account.trades.length
    ? (wins / account.trades.length) * 100
    : 0;
  const chartData = useMemo(
    () =>
      signals
        .filter((point) => point.complete)
        .slice(-90)
        .map((p) => ({
          date: dateFmt.format(p.ts),
          price: p.close,
          ema20: p.ema20,
          ema60: p.ema60,
          score: p.score,
        })),
    [signals],
  );
  const voteRows = latest
    ? ([
        [
          'ADX + DI',
          latest.votes.trend,
          `ADX ${latest.adx?.toFixed(1)} · +DI ${latest.plusDI?.toFixed(1)} / -DI ${latest.minusDI?.toFixed(1)}`,
        ],
        ['MACD', latest.votes.macd, `DIFF ${latest.macd?.toFixed(2)}`],
        [
          'BOLL 中轨',
          latest.votes.boll,
          `中轨 ${priceFmt.format(latest.bollMid ?? 0)}`,
        ],
        ['SAR', latest.votes.sar, `SAR ${priceFmt.format(latest.sar ?? 0)}`],
        [
          'EMA20 / 60',
          latest.votes.ema,
          `${priceFmt.format(latest.ema20 ?? 0)} / ${priceFmt.format(latest.ema60 ?? 0)}`,
        ],
      ] as const)
    : [];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-[#07100ee8] px-4 py-3 backdrop-blur-xl md:px-8">
        <div className="mx-auto flex max-w-[1540px] flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                ETH 评分模拟盘
              </h1>
              <p className="text-xs text-muted-foreground">
                5 指标共振 · OKX 日线 · UTC 收盘
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="live-badge">
              <i />
              运行中
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label="刷新行情"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
              />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="恢复回测持仓起点"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    恢复到 8 月 17 日的持仓起点？
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    账户将恢复为 10,000 U，并按 1,843.69
                    的入场价重新建立现货多单；已有模拟交易记录会清空。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={resetAccount}>
                    确认恢复
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1540px] gap-5 p-4 md:p-8">
        {error && (
          <div className="error-banner">{error}。系统会每 60 秒自动重试。</div>
        )}
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Metric
            icon={<WalletCards />}
            label="账户权益"
            value={`${money.format(equity)} U`}
            note={`累计 ${(equity / STARTING_BALANCE - 1) * 100 >= 0 ? '+' : ''}${((equity / STARTING_BALANCE - 1) * 100).toFixed(2)}%`}
          />
          <Metric
            icon={<CircleDollarSign />}
            label="ETH / USDT"
            value={currentPrice ? `$${priceFmt.format(currentPrice)}` : '—'}
            note={`24h ${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%`}
            tone={change24h >= 0 ? 'positive' : 'negative'}
          />
          <Metric
            icon={<Activity />}
            label="当前总分"
            value={
              latest ? `${latest.score > 0 ? '+' : ''}${latest.score} / 5` : '—'
            }
            note={latest?.adx ? `ADX ${latest.adx.toFixed(1)}` : '等待完整日K'}
            tone={
              latest && latest.score > 0
                ? 'positive'
                : latest && latest.score < 0
                  ? 'negative'
                  : undefined
            }
          />
          <Metric
            icon={positionSide === 'short' ? <TrendingDown /> : <TrendingUp />}
            label="模拟仓位"
            value={
              positionSide === 'long'
                ? '现货多单'
                : positionSide === 'short'
                  ? '永续空单'
                  : '空仓'
            }
            note={
              account.position
                ? `入场 $${priceFmt.format(account.position.entry)}`
                : '等待共振'
            }
            tone={
              positionSide === 'long'
                ? 'positive'
                : positionSide === 'short'
                  ? 'negative'
                  : undefined
            }
          />
          <Metric
            icon={<ShieldCheck />}
            label="浮动盈亏"
            value={`${unrealized >= 0 ? '+' : ''}${money.format(unrealized)} U`}
            note={
              account.position
                ? `${unrealized >= 0 ? '+' : ''}${((unrealized / account.position.margin) * 100).toFixed(2)}%`
                : '无持仓'
            }
            tone={
              unrealized > 0
                ? 'positive'
                : unrealized < 0
                  ? 'negative'
                  : undefined
            }
          />
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.62fr_.76fr]">
          <article className="panel min-h-[440px]">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">MARKET PULSE</p>
                <h2>90 日价格与评分</h2>
              </div>
              <span className="status-pill">
                <span />
                {updatedAt
                  ? `${dateTimeFmt.format(updatedAt)} 更新`
                  : '连接行情'}
              </span>
            </div>
            <div className="mt-7 h-[340px] w-full">
              <PriceChart data={chartData} />
            </div>
            <div className="chart-legend">
              <span>
                <i className="mint" />
                收盘
              </span>
              <span>
                <i className="blue" />
                EMA20
              </span>
              <span>
                <i className="amber" />
                EMA60 / 评分柱
              </span>
            </div>
          </article>

          <aside className={`panel signal-panel ${decision.tone}`}>
            <div className="panel-heading">
              <div>
                <p className="eyebrow">DAILY DECISION</p>
                <h2>最新完整日K</h2>
              </div>
              <Clock3 className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className={`signal-orb ${decision.tone}`}>
              {latest ? `${latest.score > 0 ? '+' : ''}${latest.score}` : '—'}
            </div>
            <p className="mt-5 text-center text-xl font-semibold">
              {decision.action}
            </p>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              {decision.reason}
            </p>
            <div className="mt-7">
              <div className="mb-2 flex justify-between text-xs text-muted-foreground">
                <span>共振强度</span>
                <span>{latest ? Math.abs(latest.score) : 0} / 5</span>
              </div>
              <Progress value={(Math.abs(latest?.score ?? 0) / 5) * 100} />
            </div>
            <div className="mt-7 rounded-xl border border-border bg-black/10 p-4 text-sm leading-6">
              <div className="flex justify-between">
                <span className="text-muted-foreground">信号日期</span>
                <span>
                  {latest
                    ? new Date(latest.ts).toISOString().slice(0, 10)
                    : '—'}
                </span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-muted-foreground">执行价格</span>
                <span>
                  {latest ? `$${priceFmt.format(latest.close)}` : '—'}
                </span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-muted-foreground">下次收盘</span>
                <span>00:00 UTC</span>
              </div>
            </div>
          </aside>
        </section>

        <section className="grid gap-5 xl:grid-cols-[.82fr_1.38fr]">
          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">VOTE BREAKDOWN</p>
                <h2>5 项指标投票</h2>
              </div>
              <span className="text-xs text-muted-foreground">
                +1 多 / −1 空
              </span>
            </div>
            <div className="mt-5 overflow-hidden rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>指标</TableHead>
                    <TableHead>读数</TableHead>
                    <TableHead className="text-right">票</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {voteRows.map(([name, vote, reading]) => (
                    <TableRow key={name}>
                      <TableCell className="font-medium">{name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {reading}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono font-bold ${vote > 0 ? 'text-[#54e6b1]' : vote < 0 ? 'text-[#ff716b]' : 'text-muted-foreground'}`}
                      >
                        {vote > 0 ? '+' : ''}
                        {vote}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </article>
          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">PAPER LEDGER</p>
                <h2>模拟交易记录</h2>
              </div>
              <span className="text-xs text-muted-foreground">
                {account.position ? '1 个持仓 · ' : ''}
                {account.trades.length} 笔已平 · 胜率 {winRate.toFixed(1)}%
              </span>
            </div>
            <div className="mt-5 overflow-x-auto rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>方向</TableHead>
                    <TableHead>开仓</TableHead>
                    <TableHead>平仓</TableHead>
                    <TableHead>持仓</TableHead>
                    <TableHead className="text-right">手续费</TableHead>
                    <TableHead className="text-right">净盈亏</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {account.position && (
                    <TableRow className="bg-[#54e6b1]/[.035]">
                      <TableCell>
                        <span
                          className={
                            account.position.side === 'long'
                              ? 'tag long'
                              : 'tag short'
                          }
                        >
                          {account.position.side === 'long'
                            ? '现货多'
                            : '永续空'}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {new Date(account.position.openedAt)
                          .toISOString()
                          .slice(0, 10)}
                        <br />
                        <span className="text-muted-foreground">
                          ${priceFmt.format(account.position.entry)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="live-badge">
                          <i />
                          持仓中
                        </span>
                      </TableCell>
                      <TableCell>
                        {Math.max(
                          0,
                          Math.floor(
                            ((updatedAt ?? account.position.openedAt) -
                              account.position.openedAt) /
                              86400000,
                          ),
                        )}{' '}
                        天
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {money.format(account.position.entryFee)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono font-semibold ${unrealized >= 0 ? 'text-[#54e6b1]' : 'text-[#ff716b]'}`}
                      >
                        {unrealized >= 0 ? '+' : ''}
                        {money.format(unrealized)}
                        <br />
                        <span className="text-xs">浮动</span>
                      </TableCell>
                    </TableRow>
                  )}
                  {account.trades.length ? (
                    account.trades.slice(0, 8).map((t) => (
                      <TableRow key={t.id}>
                        <TableCell>
                          <span
                            className={
                              t.side === 'long' ? 'tag long' : 'tag short'
                            }
                          >
                            {t.side === 'long' ? '现货多' : '永续空'}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {new Date(t.openedAt).toISOString().slice(0, 10)}
                          <br />
                          <span className="text-muted-foreground">
                            ${priceFmt.format(t.entry)}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {new Date(t.closedAt).toISOString().slice(0, 10)}
                          <br />
                          <span className="text-muted-foreground">
                            ${priceFmt.format(t.exit)}
                          </span>
                        </TableCell>
                        <TableCell>
                          {Math.round((t.closedAt - t.openedAt) / 86400000)} 天
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {money.format(t.fee)}
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono font-semibold ${t.pnl >= 0 ? 'text-[#54e6b1]' : 'text-[#ff716b]'}`}
                        >
                          {t.pnl >= 0 ? '+' : ''}
                          {money.format(t.pnl)}
                          <br />
                          <span className="text-xs">
                            {t.returnPct >= 0 ? '+' : ''}
                            {t.returnPct.toFixed(2)}%
                          </span>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : !account.position ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="h-28 text-center text-muted-foreground"
                      >
                        启动后，系统将在完整日K触发阈值时自动记账
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </article>
        </section>

        <section className="rules-strip">
          <div>
            <strong>多头</strong>
            <span>评分 ≥ +4 且 ADX &gt; 10 开现货；评分 ≤ 0 平仓</span>
          </div>
          <div>
            <strong>空头</strong>
            <span>评分 ≤ −3 且 ADX &gt; 25 开 1× 永续；评分 ≥ −4 平仓</span>
          </div>
          <div>
            <strong>费用</strong>
            <span>现货 taker 0.10% · 永续 taker 0.05% · 未计资金费</span>
          </div>
        </section>
        <p className="pb-3 text-center text-xs leading-5 text-muted-foreground">
          模拟盘以 2026-08-17 的回测持仓为起点：10,000 U，现货多单入场价
          1,843.69。仅在本机浏览器记账，不连接交易账户；页面关闭期间会在下次打开时补算完整日K。
        </p>
      </div>
    </main>
  );
}

function Metric({
  icon,
  label,
  value,
  note,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note: string;
  tone?: 'positive' | 'negative';
}) {
  return (
    <article className="metric-card">
      <div className="flex items-center justify-between">
        <p className="metric-label">{label}</p>
        <span className="metric-icon">{icon}</span>
      </div>
      <p className={`metric-value ${tone ?? ''}`}>{value}</p>
      <p className={`metric-note ${tone ?? ''}`}>{note}</p>
    </article>
  );
}

function PriceChart({
  data,
}: {
  data: Array<{
    date: string;
    price: number;
    ema20: number | null;
    ema60: number | null;
    score: number;
  }>;
}) {
  if (data.length < 2)
    return <div className="h-full animate-pulse rounded-xl bg-white/[.025]" />;
  const allPrices = data.flatMap((d) =>
    [d.price, d.ema20, d.ema60].filter((v): v is number => v != null),
  );
  const rawMin = Math.min(...allPrices);
  const rawMax = Math.max(...allPrices);
  const padding = Math.max((rawMax - rawMin) * 0.12, 1);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const x = (i: number) => 12 + (i / (data.length - 1)) * 680;
  const y = (value: number) => 22 + ((max - value) / (max - min)) * 210;
  const pathFor = (key: 'price' | 'ema20' | 'ema60') =>
    data
      .map((d, i) => {
        const value = d[key];
        return value == null
          ? ''
          : `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
      })
      .join(' ');
  const pricePath = pathFor('price');
  const areaPath = `${pricePath} L692,238 L12,238 Z`;
  return (
    <svg
      className="h-full w-full"
      viewBox="0 0 760 310"
      preserveAspectRatio="none"
      aria-label="最近 90 个完整日K的 ETH 收盘价、EMA20、EMA60 与评分"
    >
      <title>最近 90 个完整日K的 ETH 收盘价、EMA20、EMA60 与评分</title>
      <defs>
        <linearGradient id="priceFade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#54e6b1" stopOpacity=".22" />
          <stop offset="1" stopColor="#54e6b1" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[22, 92, 162, 232].map((line) => (
        <line
          key={line}
          x1="12"
          y1={line}
          x2="692"
          y2={line}
          stroke="rgba(183,226,208,.08)"
        />
      ))}
      <path d={areaPath} fill="url(#priceFade)" />
      <path
        d={pricePath}
        fill="none"
        stroke="#54e6b1"
        strokeWidth="2.2"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={pathFor('ema20')}
        fill="none"
        stroke="#8aa9ff"
        strokeWidth="1.25"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={pathFor('ema60')}
        fill="none"
        stroke="#f2b84b"
        strokeWidth="1.25"
        vectorEffect="non-scaling-stroke"
      />
      {data.map((d, i) => {
        const height = Math.abs(d.score) * 5.4;
        const base = 278;
        return (
          <rect
            key={`${d.date}-${i}`}
            x={x(i) - 1.5}
            y={d.score >= 0 ? base - height : base}
            width="3"
            height={height}
            rx="1.5"
            fill={d.score >= 0 ? '#54e6b1' : '#ff716b'}
            opacity=".42"
          />
        );
      })}
      <line x1="12" y1="278" x2="692" y2="278" stroke="rgba(255,255,255,.14)" />
      <text x="704" y="28" fill="#789087" fontSize="11">
        ${Math.round(max).toLocaleString()}
      </text>
      <text x="704" y="232" fill="#789087" fontSize="11">
        ${Math.round(min).toLocaleString()}
      </text>
      <text x="12" y="305" fill="#789087" fontSize="11">
        {data[0].date}
      </text>
      <text x="692" y="305" textAnchor="end" fill="#789087" fontSize="11">
        {data.at(-1)?.date}
      </text>
    </svg>
  );
}
