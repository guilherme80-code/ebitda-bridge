import { ArrowRight } from 'lucide-react';
import type { Scenario } from '@workspace/api-client-react';
import { cn } from '../lib/utils';

const KIND_LABEL: Record<string, string> = {
  year: 'Ano',
  quarter: 'Trimestre',
  month: 'Mês',
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
    if (exact) {
      onSelect(exact.id);
      return;
    }
    // A combinação exata não existe — usa o primeiro cenário compatível com o
    // campo que o usuário acabou de alterar.
    const fallback =
      changed === 'version'
        ? scenarios.find((s) => s.version === version)
        : scenarios.find((s) => s.period === period);
    if (fallback) onSelect(fallback.id);
  };

  const versionHasData = (version: string) =>
    scenarios.some((s) => s.version === version && s.hasData);

  return (
    <div className="flex-1 bg-white border border-slate-200 shadow-sm px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">
        {title}
      </p>
      <div className="flex items-center gap-3">
        <label className="flex-1">
          <span className="block text-[11px] font-semibold text-slate-500 mb-1">
            Versão
          </span>
          <select
            className="w-full text-sm font-bold text-slate-800 bg-slate-50 border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-blue/40 cursor-pointer"
            value={selected?.version ?? ''}
            onChange={(e) => pick(e.target.value, selected?.period ?? '', 'version')}
          >
            {versions.map((v) => (
              <option key={v} value={v} disabled={!versionHasData(v)}>
                {versionHasData(v) ? v : `${v} (sem dados)`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1">
          <span className="block text-[11px] font-semibold text-slate-500 mb-1">
            Período
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
                  .map((p) => (
                    <option key={p.period} value={p.period}>
                      {p.period}
                    </option>
                  ))}
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
          title="Origem"
          scenarios={scenarios}
          selectedId={sourceId}
          onSelect={(id) => onChange(id, targetId ?? id)}
        />
        <div className="hidden md:flex items-center justify-center w-10 h-10 bg-brand-navy text-white shadow-sm shrink-0 self-center">
          <ArrowRight className="w-4 h-4" />
        </div>
        <ScenarioPicker
          title="Destino"
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
          ? 'Uma das versões selecionadas ainda não possui dados importados. Selecione outra combinação.'
          : 'Compare períodos do mesmo tipo: ano com ano, trimestre com trimestre ou mês com mês.'}
      </p>
    </div>
  );
}
