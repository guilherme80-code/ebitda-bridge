import { ArrowRight } from 'lucide-react';
import type { Scenario } from '@workspace/api-client-react';
import { cn } from '../lib/utils';

const KIND_LABEL: Record<string, string> = {
  year: 'Year',
  quarter: 'Quarter',
  month: 'Month',
};

function ScenarioPicker({
  title,
  scenarios,
  selectedId,
  onSelect,
}: {
  title: string;
  scenarios: Scenario[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selected = scenarios.find((s) => s.id === selectedId);
  const versions = [...new Set(scenarios.map((s) => s.version))];

  // Períodos únicos na ordem do catálogo, agrupados por tipo (ano/trimestre/mês).
  const periods: { period: string; periodKind: string }[] = [];
  const seen = new Set<string>();
  for (const s of scenarios) {
    if (!seen.has(s.period)) {
      seen.add(s.period);
      periods.push({ period: s.period, periodKind: s.periodKind });
    }
  }
  const kinds = ['year', 'quarter', 'month'].filter((k) =>
    periods.some((p) => p.periodKind === k),
  );

  const pick = (version: string, period: string, changed: 'version' | 'period') => {
    const exact = scenarios.find(
      (s) => s.version === version && s.period === period,
    );
    if (exact?.hasData) {
      onSelect(exact.id);
      return;
    }
    // A combinação exata não existe ou está incompleta (FY/trimestre sem
    // todos os meses) — usa o primeiro cenário COM DADOS compatível com o
    // campo que o usuário acabou de alterar, preferindo o mesmo tipo de
    // período (ano/trimestre/mês).
    const kind = exact?.periodKind ?? selected?.periodKind;
    const candidates =
      changed === 'version'
        ? scenarios.filter((s) => s.version === version && s.hasData)
        : scenarios.filter((s) => s.period === period && s.hasData);
    const fallback =
      candidates.find((s) => s.periodKind === kind) ?? candidates[0];
    if (fallback) onSelect(fallback.id);
  };

  const versionHasData = (version: string) =>
    scenarios.some((s) => s.version === version && s.hasData);

  // Para a versão selecionada: um período derivado (ano/trimestre) pode não
  // ter todos os meses consolidados — mostramos desabilitado com a dica.
  const periodInfo = (period: string) => {
    const s = scenarios.find(
      (sc) => sc.version === (selected?.version ?? '') && sc.period === period,
    );
    if (!s) return { disabled: false, hint: '' };
    if (s.hasData) return { disabled: false, hint: '' };
    const missing = s.missingMonths ?? [];
    if (missing.length === 0) return { disabled: true, hint: ' (no data)' };
    const shown = missing.slice(0, 3).join(', ');
    const rest = missing.length > 3 ? ` +${missing.length - 3}` : '';
    return { disabled: true, hint: ` (missing ${shown}${rest})` };
  };

  return (
    <div className="flex-1 bg-white border border-slate-200 shadow-sm px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">
        {title}
      </p>
      <div className="flex items-center gap-3">
        <label className="flex-1">
          <span className="block text-[11px] font-semibold text-slate-500 mb-1">
            Version
          </span>
          <select
            className="w-full text-sm font-bold text-slate-800 bg-slate-50 border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-blue/40 cursor-pointer"
            value={selected?.version ?? ''}
            onChange={(e) => pick(e.target.value, selected?.period ?? '', 'version')}
          >
            {versions.map((v) => (
              <option key={v} value={v} disabled={!versionHasData(v)}>
                {versionHasData(v) ? v : `${v} (no data)`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1">
          <span className="block text-[11px] font-semibold text-slate-500 mb-1">
            Period
          </span>
          <select
            className="w-full text-sm font-bold text-slate-800 bg-slate-50 border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-blue/40 cursor-pointer"
            value={selected?.period ?? ''}
            onChange={(e) => pick(selected?.version ?? versions[0], e.target.value, 'period')}
          >
            {kinds.map((k) => (
              <optgroup key={k} label={KIND_LABEL[k] ?? k}>
                {periods
                  .filter((p) => p.periodKind === k)
                  .map((p) => {
                    const info = periodInfo(p.period);
                    return (
                      <option
                        key={p.period}
                        value={p.period}
                        disabled={info.disabled}
                        title={
                          info.disabled
                            ? `Incomplete period — import the missing months to consolidate${info.hint}`
                            : undefined
                        }
                      >
                        {p.period}
                        {info.hint}
                      </option>
                    );
                  })}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

export function ScenarioSelector({
  scenarios,
  sourceId,
  targetId,
  onChange,
}: {
  scenarios: Scenario[];
  sourceId: string | null;
  targetId: string | null;
  onChange: (sourceId: string, targetId: string) => void;
}) {
  const byId = (id: string | null) => scenarios.find((s) => s.id === id);
  const source = byId(sourceId);
  const target = byId(targetId);
  const bothHaveData = !!source?.hasData && !!target?.hasData;
  const sameKind =
    !!source && !!target && source.periodKind === target.periodKind;

  return (
    <div className="w-full">
      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <ScenarioPicker
          title="Source"
          scenarios={scenarios}
          selectedId={sourceId}
          onSelect={(id) => onChange(id, targetId ?? id)}
        />
        <div className="hidden md:flex items-center justify-center w-10 h-10 bg-brand-navy text-white shadow-sm shrink-0 self-center">
          <ArrowRight className="w-4 h-4" />
        </div>
        <ScenarioPicker
          title="Target"
          scenarios={scenarios}
          selectedId={targetId}
          onSelect={(id) => onChange(sourceId ?? id, id)}
        />
      </div>
      <p
        className={cn(
          'text-xs font-semibold mt-2 transition-opacity',
          bothHaveData && sameKind ? 'opacity-0 h-0 overflow-hidden' : 'text-amber-600',
        )}
      >
        {!bothHaveData
          ? 'One of the selected versions has no imported data yet. Choose another combination.'
          : 'Compare periods of the same kind: year with year, quarter with quarter, or month with month.'}
      </p>
    </div>
  );
}
