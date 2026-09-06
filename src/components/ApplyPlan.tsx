'use client';

import { motion } from 'framer-motion';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { buildApplySteps, type Step } from '@/components/apply-steps';
import type { TeamSnapshot } from '@/lib/fpl/model';
import type { PlanResult } from '@/lib/gemini/plan';

/**
 * Turning the plan into something you can actually do.
 *
 * FPL has no supported way for a server to change a team -- the old scripted
 * login endpoint no longer exists, and the write endpoints sit behind a browser
 * session. Rather than stash someone's credentials to work around that, this
 * lists exactly what to click and links straight to the right screen.
 *
 * It shows only what *changes*. A list of all fifteen players is a wall of
 * text; "bench these two, start these two" is a task.
 */

const TRANSFERS_URL = 'https://fantasy.premierleague.com/transfers';
const MY_TEAM_URL = 'https://fantasy.premierleague.com/my-team';

interface Props {
  result: PlanResult;
  snapshot: TeamSnapshot;
}

function asText(steps: Step[], result: PlanResult, snapshot: TeamSnapshot): string {
  const lines = [
    `FPL Autopilot — gameweek ${result.meta.gameweek}`,
    `Deadline ${new Date(snapshot.gameweek.deadline).toUTCString()}`,
    '',
  ];
  if (steps.length === 0) lines.push('Nothing to change this week.');
  else steps.forEach((step, i) => lines.push(`${i + 1}. ${step.label}`));
  lines.push('', result.plan.summary);
  return lines.join('\n');
}

export function ApplyPlan({ result, snapshot }: Props) {
  const steps = useMemo(() => buildApplySteps(result, snapshot), [result, snapshot]);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  const completed = steps.filter((s) => done[s.id]).length;
  const allDone = steps.length > 0 && completed === steps.length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText(steps, result, snapshot));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the steps are on screen regardless.
    }
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="panel flex flex-col gap-5 px-5 py-6 sm:px-8"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-bold tracking-tight">Apply on FPL</h3>
          {steps.length > 0 && (
            <Badge
              variant="outline"
              className={`text-[10px] ${allDone ? 'border-brand/40 text-brand' : 'border-line-bright text-faint'}`}
            >
              {completed}/{steps.length} done
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={copy} className="text-faint hover:text-text">
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button asChild size="sm">
            <a
              href={steps.some((s) => s.where === 'transfers') ? TRANSFERS_URL : MY_TEAM_URL}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open FPL
              <ExternalLink />
            </a>
          </Button>
        </div>
      </header>

      {steps.length === 0 ? (
        <p className="text-sm text-dim">
          Nothing to change. Your team already matches the plan — no transfer, same eleven, same
          armband.
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {steps.map((step, index) => (
            <li key={step.id}>
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-white/[0.03] ${
                  done[step.id] ? 'opacity-45' : ''
                }`}
              >
                <Checkbox
                  checked={done[step.id] ?? false}
                  onCheckedChange={(value) =>
                    setDone((prev) => ({ ...prev, [step.id]: value === true }))
                  }
                  className="mt-0.5"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className={`text-sm font-semibold leading-snug ${
                      done[step.id] ? 'line-through' : ''
                    }`}
                  >
                    <span className="nums mr-2 text-faint">{index + 1}.</span>
                    {step.label}
                  </span>
                  {step.detail && <span className="text-[11px] text-faint">{step.detail}</span>}
                </span>
                <Badge
                  variant="outline"
                  className="mt-0.5 shrink-0 border-line text-[9px] uppercase tracking-wider text-faint"
                >
                  {step.where === 'transfers' ? 'Transfers' : 'My Team'}
                </Badge>
              </label>
            </li>
          ))}
        </ol>
      )}

      <p className="text-[11px] leading-relaxed text-faint">
        These are done by hand on purpose. FPL has no supported way for an app to change your team,
        and the alternatives all mean handing over your login — not worth it to save half a minute.
      </p>
    </motion.section>
  );
}
