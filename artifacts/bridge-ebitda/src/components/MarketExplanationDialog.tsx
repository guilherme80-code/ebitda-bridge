import { X, TrendingUp } from 'lucide-react';
import { useEffect } from 'react';
import type { MarketExplanation } from '@workspace/api-client-react';
import { cn } from '../lib/utils';

const nf = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

function fmt(v: number | undefined): string {
  if (v === undefined) return '—';
  return nf.format(v);
}

/**
 * Pop-up com a tabela de explicação (ex.: Iron Ores) vinculada ao item clicado
 * nas tabelas de detalhe — colunas origem, destino, Var, kt e $m. As
 * explicações são armazenadas por mês: para pares FY/trimestre a tabela
 * principal mostra a soma e uma seção adicional traz o detalhe mês a mês.
 */
export function MarketExplanationDialog({
  explanation,
  itemLabel,
  sourceLabel,
  targetLabel,
  onClose,
}: {
  explanation: MarketExplanation | null;
  /** Item clicado que abriu o pop-up (ex.: Fines). */
  itemLabel: string | null;
  sourceLabel?: string;
  targetLabel?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!explanation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [explanation, onClose]);

  if (!explanation) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-[2px] animate-in fade-in duration-200"
      onClick={onClose}
      data-testid="market-explanation-dialog"
    >
      <div
        className="bg-white w-full max-w-2xl shadow-2xl border-t-4 border-brand-orange animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Explanations: ${explanation.title}`}
      >
        <div className="flex items-start justify-between px-6 py-5 bg-brand-navy text-white">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/60 mb-1">
              Explanations
            </p>
            <h2 className="text-xl font-bold font-heading flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-brand-orange" />
              {explanation.title}
            </h2>
            {itemLabel && (
              <p className="text-xs font-medium text-white/70 mt-1.5">
                Affects item <strong className="text-white">{itemLabel}</strong>
                {explanation.items.length > 1 && (
                  <> — also: {explanation.items.filter((i) => i !== itemLabel).join(', ')}</>
                )}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/10 transition-colors text-white/80 hover:text-white"
            aria-label="Close"
            data-testid="button-close-market-explanation"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-market-explanation">
            <thead>
              <tr className="bg-slate-50 text-slate-500 border-b border-slate-200">
                <th className="text-left font-semibold px-6 py-2.5 whitespace-nowrap">
                  {explanation.unitLabel}
                </th>
                <th className="text-right font-semibold px-4 py-2.5 whitespace-nowrap">
                  {sourceLabel ?? 'Source'}
                </th>
                <th className="text-right font-semibold px-4 py-2.5 whitespace-nowrap">
                  {targetLabel ?? 'Target'}
                </th>
                <th className="text-right font-semibold px-4 py-2.5 whitespace-nowrap">Var</th>
                <th className="text-right font-semibold px-4 py-2.5 whitespace-nowrap">kt</th>
                <th className="text-right font-semibold px-6 py-2.5 whitespace-nowrap">$m</th>
              </tr>
            </thead>
            <tbody>
              {explanation.lines.map((line) => (
                <tr key={line.id} className="border-t border-slate-100 text-slate-600 hover:bg-slate-50/50">
                  <td className="px-6 py-2 font-medium text-slate-700">{line.label}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmt(line.sourceValue)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmt(line.targetValue)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmt(line.varValue)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmt(line.volumeKt)}</td>
                  <td
                    className={cn(
                      'px-6 py-2 text-right tabular-nums font-bold',
                      line.impactMusd > 0 ? 'text-emerald-600' : line.impactMusd < 0 ? 'text-rose-600' : '',
                    )}
                  >
                    {fmt(line.impactMusd)}
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-100/80 font-bold text-slate-900 border-t-2 border-slate-200">
                <td className="px-6 py-2.5">Total</td>
                <td className="px-4 py-2.5" colSpan={4} />
                <td
                  className={cn(
                    'px-6 py-2.5 text-right tabular-nums',
                    explanation.totalMusd > 0 ? 'text-emerald-600' : explanation.totalMusd < 0 ? 'text-rose-600' : '',
                  )}
                  data-testid="text-market-explanation-total"
                >
                  {fmt(explanation.totalMusd)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {explanation.months.length > 1 && (
          <div className="px-6 py-4 border-t border-slate-200 max-h-[40vh] overflow-y-auto" data-testid="section-monthly-detail">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">
              Monthly detail — the sum above consolidates {explanation.months.length} months
            </p>
            <div className="space-y-4">
              {explanation.months.map((m) => (
                <div key={m.periodLabel} data-testid={`month-detail-${m.periodLabel}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-slate-700">{m.periodLabel}</span>
                    <span
                      className={cn(
                        'text-xs font-bold tabular-nums',
                        m.totalMusd > 0 ? 'text-emerald-600' : m.totalMusd < 0 ? 'text-rose-600' : 'text-slate-500',
                      )}
                    >
                      {fmt(m.totalMusd)} $m
                    </span>
                  </div>
                  <table className="w-full text-xs">
                    <tbody>
                      {m.lines.map((line) => (
                        <tr key={line.id} className="border-t border-slate-100 text-slate-500">
                          <td className="py-1 pr-2">{line.label}</td>
                          <td className="py-1 text-right tabular-nums w-16">{fmt(line.sourceValue)}</td>
                          <td className="py-1 text-right tabular-nums w-16">{fmt(line.targetValue)}</td>
                          <td className="py-1 text-right tabular-nums w-14">{fmt(line.varValue)}</td>
                          <td className="py-1 text-right tabular-nums w-16">{fmt(line.volumeKt)}</td>
                          <td
                            className={cn(
                              'py-1 text-right tabular-nums font-semibold w-16',
                              line.impactMusd > 0 ? 'text-emerald-600' : line.impactMusd < 0 ? 'text-rose-600' : '',
                            )}
                          >
                            {fmt(line.impactMusd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 text-[11px] font-medium text-slate-400">
          Imported data — informational only, does not affect the bridge calculation.
        </div>
      </div>
    </div>
  );
}
