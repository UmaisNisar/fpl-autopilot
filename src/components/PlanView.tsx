'use client';

import { motion } from 'framer-motion';

import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { CHIP_LABELS } from '@/lib/fpl/model';
import type { PlanResult } from '@/lib/gemini/plan';

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
};

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const } },
};

function Block({
  eyebrow,
  children,
  className = '',
}: {
  eyebrow: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div variants={item} className={`flex flex-col gap-2.5 ${className}`}>
      <span className="eyebrow">{eyebrow}</span>
      {children}
    </motion.div>
  );
}

const CONFIDENCE_STYLE = {
  high: 'border-brand/40 text-brand',
  medium: 'border-amber/40 text-amber',
  low: 'border-rose/40 text-rose',
} as const;

export function PlanView({ result }: { result: PlanResult }) {
  const { plan } = result;
  const { transfer } = plan;

  return (
    <motion.section
      variants={container}
      initial="hidden"
      animate="show"
      className="panel relative overflow-hidden"
    >
      {/* Accent wash so the answer reads as the centre of the screen. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(0,229,160,0.10),transparent)]"
      />

      <div className="relative flex flex-col gap-8 px-5 py-7 sm:px-8 sm:py-9">
        <motion.header variants={item} className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
            Your gameweek plan
          </h2>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                CONFIDENCE_STYLE[plan.confidence]
              }`}
            >
              {plan.confidence} confidence
            </Badge>
          </div>
        </motion.header>

        {/* --- 1. TRANSFERS (the headline decision) --- */}
        <Block eyebrow="Transfers">
          {transfer.action === 'hold' ? (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-3xl font-extrabold tracking-tight text-text sm:text-4xl">
                No transfer
              </span>
              <span className="text-sm text-dim">Roll it. Keep the flexibility.</span>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {transfer.moves.map((move) => (
                <div
                  key={`${move.out}-${move.in}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2"
                >
                  <span className="text-2xl font-extrabold tracking-tight text-rose line-through decoration-rose/50 sm:text-3xl">
                    {move.out}
                  </span>
                  <span className="text-xl text-faint">→</span>
                  <span className="text-2xl font-extrabold tracking-tight text-brand sm:text-3xl">
                    {move.in}
                  </span>
                </div>
              ))}
              {transfer.moves.some((m) => m.reason) && (
                <p className="max-w-2xl text-sm leading-relaxed text-dim">
                  {transfer.moves.map((m) => m.reason).filter(Boolean).join(' ')}
                </p>
              )}
            </div>
          )}

          <div>
            <Badge
              variant="outline"
              className={`rounded-md px-3 py-1.5 text-xs font-bold uppercase tracking-wider ${
                transfer.takeHit
                  ? 'border-amber/40 bg-amber/[0.08] text-amber'
                  : 'border-line-bright bg-white/[0.03] text-dim'
              }`}
            >
              {transfer.takeHit ? `Take a -${transfer.hitCost} hit` : 'Do not take a hit'}
            </Badge>
          </div>
        </Block>

        <Separator className="bg-line-bright/60" />

        {/* --- 2 & 3 & 4 --- */}
        <div className="grid gap-8 sm:grid-cols-3">
          <Block eyebrow="Captain">
            <div className="flex flex-col gap-1">
              <span className="text-2xl font-extrabold tracking-tight text-violet">
                {plan.captain}
              </span>
              <span className="text-xs text-dim">
                Vice: <span className="font-semibold text-text">{plan.viceCaptain}</span>
              </span>
            </div>
          </Block>

          <Block eyebrow="Formation">
            <div className="flex flex-col gap-1">
              <span className="nums text-2xl font-extrabold tracking-tight">
                {plan.formation}
              </span>
              <span className="text-xs text-dim">Marked on the pitch below</span>
            </div>
          </Block>

          <Block eyebrow="Chip">
            <div className="flex flex-col gap-1">
              <span
                className={`text-2xl font-extrabold tracking-tight ${
                  plan.chip === 'none' ? 'text-text' : 'text-brand'
                }`}
              >
                {plan.chip === 'none' ? 'No chip' : CHIP_LABELS[plan.chip]}
              </span>
              <span className="text-xs text-dim">
                {plan.chip === 'none' ? 'Save them for a better week' : 'Play it this gameweek'}
              </span>
            </div>
          </Block>
        </div>

        <Separator className="bg-line-bright/60" />

        {/* --- 5. FINAL VERDICT --- */}
        <Block eyebrow="Verdict">
          <p className="max-w-3xl text-[15px] leading-relaxed text-text/90">{plan.summary}</p>
        </Block>

        {/* --- Bench order, spelled out --- */}
        <Block eyebrow="Bench order">
          <div className="flex flex-wrap items-center gap-2">
            {plan.benchOrder.map((name, index) => (
              <span key={name} className="flex items-center gap-2">
                {index > 0 && <span className="text-faint">→</span>}
                <Badge
                  variant="outline"
                  className="rounded-md border-line bg-white/[0.03] px-2.5 py-1 text-xs font-semibold"
                >
                  {name}
                </Badge>
              </span>
            ))}
          </div>
        </Block>

        {(result.warnings.length > 0 || result.fallback) && (
          <motion.div variants={item} className="flex flex-col gap-2 rounded-lg border border-line bg-white/[0.02] px-4 py-3">
            <span className="eyebrow">
              {result.fallback ? 'Fallback used' : 'Adjustments applied'}
            </span>
            <ul className="flex flex-col gap-1">
              {result.warnings.map((warning) => (
                <li key={warning} className="text-xs leading-relaxed text-dim">
                  {warning}
                </li>
              ))}
            </ul>
          </motion.div>
        )}

        <motion.footer variants={item} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-faint">
          <span>
            GW{result.meta.gameweek} · {result.meta.model}
          </span>
          <span>·</span>
          <span>Projections, not certainties. You take the decision.</span>
        </motion.footer>
      </div>
    </motion.section>
  );
}
